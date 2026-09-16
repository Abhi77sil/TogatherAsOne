import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { FileTreeNode } from '../protocol/types';
import { LANServer } from '../network/lanServer';
import {
  FileTreeRequestMessage,
  FileTreeResponseMessage,
  ReadFileRequestMessage,
  ReadFileResponseMessage,
  WriteFileRequestMessage,
  WriteFileResponseMessage,
  DeleteFileRequestMessage,
  DeleteFileResponseMessage,
  CreateDirRequestMessage,
  CreateDirResponseMessage,
  FileChangedEventMessage,
} from '../protocol/messages';

const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.cache',
]);

export class HostFileManager {
  private workspaceRoot: string;
  private server: LANServer;
  private fileWatcher: vscode.FileSystemWatcher | null = null;
  public recentSaves: Map<string, number> = new Map();
  private isDocActive?: (filePath: string) => boolean;

  constructor(
    workspaceRoot: string,
    server: LANServer,
    isDocActive?: (filePath: string) => boolean
  ) {
    this.workspaceRoot = workspaceRoot;
    this.server = server;
    this.isDocActive = isDocActive;
    this.setupServerHandlers();
    this.setupFileWatcher();
  }

  private setupServerHandlers(): void {
    this.server.on('fileSystemRequest', async ({ client, msg }) => {
      try {
        switch (msg.type) {
          case 'file_tree_request': {
            const tree = await this.buildFileTree();
            const res: FileTreeResponseMessage = {
              type: 'file_tree_response',
              requestId: msg.requestId,
              tree,
            };
            this.server.sendTo(client.participant.id, res);
            break;
          }

          case 'read_file_request': {
            const readReq = msg as ReadFileRequestMessage;
            try {
              const content = await this.readFile(readReq.path);
              const res: ReadFileResponseMessage = {
                type: 'read_file_response',
                requestId: msg.requestId,
                path: readReq.path,
                content,
              };
              this.server.sendTo(client.participant.id, res);
            } catch (err: any) {
              const res: ReadFileResponseMessage = {
                type: 'read_file_response',
                requestId: msg.requestId,
                path: readReq.path,
                error: err.message,
              };
              this.server.sendTo(client.participant.id, res);
            }
            break;
          }

          case 'write_file_request': {
            const writeReq = msg as WriteFileRequestMessage;
            if (client.participant.access === 'read-only') {
              const res: WriteFileResponseMessage = {
                type: 'write_file_response',
                requestId: msg.requestId,
                path: writeReq.path,
                success: false,
                error: 'Read-only access: Host has not granted write permissions.',
              };
              this.server.sendTo(client.participant.id, res);
              return;
            }

            try {
              this.recentSaves.set(writeReq.path, Date.now());

              const openDoc = vscode.workspace.textDocuments.find((d) => {
                if (d.uri.scheme !== 'file') return false;
                const rel = path.relative(this.workspaceRoot, d.uri.fsPath).replace(/\\/g, '/');
                return rel === writeReq.path;
              });

              if (openDoc) {
                if (openDoc.isDirty) {
                  await openDoc.save();
                }
              } else {
                await this.writeFile(writeReq.path, writeReq.content);
              }

              const res: WriteFileResponseMessage = {
                type: 'write_file_response',
                requestId: msg.requestId,
                path: writeReq.path,
                success: true,
              };
              this.server.sendTo(client.participant.id, res);
            } catch (err: any) {
              const res: WriteFileResponseMessage = {
                type: 'write_file_response',
                requestId: msg.requestId,
                path: writeReq.path,
                success: false,
                error: err.message,
              };
              this.server.sendTo(client.participant.id, res);
            }
            break;
          }

          case 'delete_file_request': {
            const delReq = msg as DeleteFileRequestMessage;
            if (client.participant.access === 'read-only') {
              const res: DeleteFileResponseMessage = {
                type: 'delete_file_response',
                requestId: msg.requestId,
                path: delReq.path,
                success: false,
                error: 'Read-only access: Host has not granted write permissions.',
              };
              this.server.sendTo(client.participant.id, res);
              return;
            }
            try {
              await this.deleteFile(delReq.path, delReq.recursive);
              const res: DeleteFileResponseMessage = {
                type: 'delete_file_response',
                requestId: msg.requestId,
                path: delReq.path,
                success: true,
              };
              this.server.sendTo(client.participant.id, res);
            } catch (err: any) {
              const res: DeleteFileResponseMessage = {
                type: 'delete_file_response',
                requestId: msg.requestId,
                path: delReq.path,
                success: false,
                error: err.message,
              };
              this.server.sendTo(client.participant.id, res);
            }
            break;
          }

          case 'create_dir_request': {
            const dirReq = msg as CreateDirRequestMessage;
            if (client.participant.access === 'read-only') {
              const res: CreateDirResponseMessage = {
                type: 'create_dir_response',
                requestId: msg.requestId,
                path: dirReq.path,
                success: false,
                error: 'Read-only access: Host has not granted write permissions.',
              };
              this.server.sendTo(client.participant.id, res);
              return;
            }
            try {
              await this.createDirectory(dirReq.path);
              const res: CreateDirResponseMessage = {
                type: 'create_dir_response',
                requestId: msg.requestId,
                path: dirReq.path,
                success: true,
              };
              this.server.sendTo(client.participant.id, res);
            } catch (err: any) {
              const res: CreateDirResponseMessage = {
                type: 'create_dir_response',
                requestId: msg.requestId,
                path: dirReq.path,
                success: false,
                error: err.message,
              };
              this.server.sendTo(client.participant.id, res);
            }
            break;
          }
        }
      } catch (err) {
        console.error('[Togather] Error processing file system request:', err);
      }
    });
  }

  private setupFileWatcher(): void {
    const pattern = new vscode.RelativePattern(this.workspaceRoot, '**/*');
    this.fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);

    const notifyChange = (uri: vscode.Uri, changeType: 'created' | 'changed' | 'deleted') => {
      const relPath = path.relative(this.workspaceRoot, uri.fsPath).replace(/\\/g, '/');
      if (IGNORED_DIRECTORIES.has(relPath.split('/')[0])) return;

      // Ignore watcher events triggered by our own collaborative saves
      const lastSave = this.recentSaves.get(relPath) || 0;
      if (changeType === 'changed' && Date.now() - lastSave < 4000) {
        return;
      }

      // If document is actively open and synchronized via CRDT, do NOT broadcast 'changed'
      // to avoid triggering file reload and text duplication on connected guests
      if (changeType === 'changed' && this.isDocActive && this.isDocActive(relPath)) {
        return;
      }

      const eventMsg: FileChangedEventMessage = {
        type: 'file_changed_event',
        changeType,
        path: relPath,
      };
      this.server.broadcast(eventMsg);
    };

    this.fileWatcher.onDidCreate((uri) => notifyChange(uri, 'created'));
    this.fileWatcher.onDidChange((uri) => notifyChange(uri, 'changed'));
    this.fileWatcher.onDidDelete((uri) => notifyChange(uri, 'deleted'));
  }

  public async buildFileTree(subDir = ''): Promise<FileTreeNode[]> {
    const fullDirPath = path.join(this.workspaceRoot, subDir);
    let entries: string[] = [];
    try {
      entries = await fs.readdir(fullDirPath);
    } catch (e) {
      return [];
    }

    const nodes: FileTreeNode[] = [];

    for (const entry of entries) {
      if (IGNORED_DIRECTORIES.has(entry) || entry.startsWith('.')) continue;

      const relPath = subDir ? `${subDir}/${entry}` : entry;
      const fullPath = path.join(fullDirPath, entry);

      try {
        const stat = await fs.stat(fullPath);
        const isDirectory = stat.isDirectory();

        const node: FileTreeNode = {
          name: entry,
          path: relPath,
          isDirectory,
          size: stat.size,
          mtime: stat.mtimeMs,
        };

        if (isDirectory) {
          node.children = await this.buildFileTree(relPath);
        }

        nodes.push(node);
      } catch (e) {
        // Skip inaccessible files/symlinks
      }
    }

    // Sort folders first, then alphabetical
    nodes.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });

    return nodes;
  }

  public async readFile(relPath: string): Promise<string> {
    const safePath = this.resolveSafePath(relPath);
    const buffer = await fs.readFile(safePath);
    return buffer.toString('base64');
  }

  public async readDocumentText(relPath: string): Promise<string> {
    const safePath = this.resolveSafePath(relPath);
    return await fs.readFile(safePath, 'utf-8');
  }

  public async writeFile(relPath: string, base64Content: string): Promise<void> {
    this.recentSaves.set(relPath, Date.now());
    const safePath = this.resolveSafePath(relPath);
    const dir = path.dirname(safePath);
    await fs.mkdir(dir, { recursive: true });
    const buffer = Buffer.from(base64Content, 'base64');
    await fs.writeFile(safePath, buffer);
  }

  public async saveDocumentContent(relPath: string, text: string): Promise<void> {
    this.recentSaves.set(relPath, Date.now());
    const safePath = this.resolveSafePath(relPath);
    const dir = path.dirname(safePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(safePath, text, 'utf-8');
  }

  public async deleteFile(relPath: string, recursive = false): Promise<void> {
    const safePath = this.resolveSafePath(relPath);
    const stat = await fs.stat(safePath);
    if (stat.isDirectory()) {
      await fs.rm(safePath, { recursive: true, force: true });
    } else {
      await fs.unlink(safePath);
    }
  }

  public async createDirectory(relPath: string): Promise<void> {
    const safePath = this.resolveSafePath(relPath);
    await fs.mkdir(safePath, { recursive: true });
  }

  private resolveSafePath(relPath: string): string {
    const normalized = path.normalize(relPath).replace(/^(\.\.[\/\\])+/, '');
    const resolved = path.join(this.workspaceRoot, normalized);
    if (!resolved.startsWith(this.workspaceRoot)) {
      throw new Error('Access denied: Path traversal attempted');
    }
    return resolved;
  }

  public dispose(): void {
    if (this.fileWatcher) {
      this.fileWatcher.dispose();
      this.fileWatcher = null;
    }
  }
}
