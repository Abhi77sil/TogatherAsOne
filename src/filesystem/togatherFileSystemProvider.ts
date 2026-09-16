import * as vscode from 'vscode';
import { LANClient } from '../network/lanClient';
import { FileTreeNode } from '../protocol/types';
import {
  FileTreeRequestMessage,
  FileTreeResponseMessage,
  ReadFileRequestMessage,
  ReadFileResponseMessage,
  WriteFileRequestMessage,
  WriteFileResponseMessage,
  DeleteFileRequestMessage,
  CreateDirRequestMessage,
  FileChangedEventMessage,
} from '../protocol/messages';
import { base64ToUint8Array, uint8ArrayToBase64 } from '../utils/networkUtils';

interface CachedFile {
  content: Uint8Array;
  timestamp: number;
}

export class TogatherFileSystemProvider implements vscode.FileSystemProvider {
  public static readonly SCHEME = 'togather';

  private client: LANClient | null = null;
  private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

  // Multi-tier In-memory Cache
  private treeNodes: Map<string, FileTreeNode> = new Map();
  private rootTree: FileTreeNode[] = [];
  private fileCache: Map<string, CachedFile> = new Map();
  private pendingReads: Map<string, Promise<Uint8Array>> = new Map();
  private isInitialized = false;
  private sessionStartTime = Date.now();

  constructor(client?: LANClient) {
    if (client) {
      this.setClient(client);
    }
  }

  public setClient(client: LANClient | null): void {
    this.client = client;
    this.fileCache.clear();
    this.treeNodes.clear();
    this.rootTree = [];
    this.pendingReads.clear();
    this.isInitialized = false;

    if (this.client) {
      this.setupListeners();
    }
  }

  private setupListeners(): void {
    if (!this.client) return;

    this.client.on('file_changed_event', (msg: FileChangedEventMessage) => {
      const uri = vscode.Uri.parse(`${TogatherFileSystemProvider.SCHEME}:/${msg.path}`);
      this.fileCache.delete(msg.path);

      let changeType = vscode.FileChangeType.Changed;
      if (msg.changeType === 'created') changeType = vscode.FileChangeType.Created;
      if (msg.changeType === 'deleted') {
        changeType = vscode.FileChangeType.Deleted;
        this.treeNodes.delete(msg.path);
      }

      // Re-fetch tree on create or delete
      if (msg.changeType !== 'changed') {
        this.fetchTree().catch(() => {});
      }

      // If document is open in visible editors, avoid firing Changed event which would force
      // VS Code to reload and conflict with live CRDT synchronization
      const isOpenInEditor = vscode.window.visibleTextEditors.some(
        (ed) =>
          ed.document.uri.scheme === TogatherFileSystemProvider.SCHEME &&
          ed.document.uri.path.replace(/^\/+/, '') === msg.path
      );
      if (changeType === vscode.FileChangeType.Changed && isOpenInEditor) {
        return;
      }

      this._emitter.fire([{ type: changeType, uri }]);
    });
  }

  public async initialize(): Promise<void> {
    await this.fetchTree();
    this.isInitialized = true;
    // Notify VS Code that the root directory contents have populated
    this._emitter.fire([
      {
        type: vscode.FileChangeType.Changed,
        uri: vscode.Uri.parse(`${TogatherFileSystemProvider.SCHEME}:/`),
      },
    ]);
  }

  public getRootTree(): FileTreeNode[] {
    return this.rootTree;
  }

  public async preloadAllFiles(
    onProgress?: (loaded: number, total: number, currentPath: string) => void
  ): Promise<void> {
    const filesToLoad: string[] = [];
    for (const [p, node] of this.treeNodes.entries()) {
      if (!node.isDirectory) {
        filesToLoad.push(p);
      }
    }

    const total = filesToLoad.length;
    if (total === 0) return;

    let loaded = 0;
    const concurrency = 6;
    const queue = [...filesToLoad];

    const worker = async () => {
      while (queue.length > 0) {
        const filePath = queue.shift();
        if (!filePath) break;
        try {
          const uri = vscode.Uri.parse(`${TogatherFileSystemProvider.SCHEME}:/${filePath}`);
          await this.readFile(uri);
        } catch (err) {
          console.warn(`[Togather] Could not preload file ${filePath}:`, err);
        }
        loaded++;
        onProgress?.(loaded, total, filePath);
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, total) }, () => worker());
    await Promise.all(workers);
  }

  public async fetchTree(): Promise<FileTreeNode[]> {
    if (!this.client) return [];

    try {
      const res = await this.client.sendRequest<FileTreeResponseMessage>({
        type: 'file_tree_request',
      });

      this.treeNodes.clear();
      this.rootTree = res.tree || [];

      const flatten = (nodes: FileTreeNode[]) => {
        for (const node of nodes) {
          this.treeNodes.set(node.path, node);
          if (node.children) {
            flatten(node.children);
          }
        }
      };
      flatten(this.rootTree);
      return this.rootTree;
    } catch (err) {
      console.error('[Togather] Failed to fetch remote file tree:', err);
      return [];
    }
  }

  private getRelativePath(uri: vscode.Uri): string {
    return uri.path.replace(/^\/+/, '');
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const relPath = this.getRelativePath(uri);

    // Root directory
    if (!relPath) {
      return {
        type: vscode.FileType.Directory,
        ctime: this.sessionStartTime,
        mtime: this.sessionStartTime,
        size: 0,
      };
    }

    if (!this.isInitialized && this.client) {
      await this.initialize();
    }

    // 1. Check in-memory fileCache first for exact, up-to-date stat
    const cached = this.fileCache.get(relPath);
    if (cached) {
      return {
        type: vscode.FileType.File,
        ctime: cached.timestamp,
        mtime: cached.timestamp,
        size: cached.content.length,
      };
    }

    // 2. Check treeNodes with stable timestamp (never dynamic Date.now()!)
    const node = this.treeNodes.get(relPath);
    if (node) {
      const stableMtime =
        typeof node.mtime === 'number' && node.mtime > 0 ? node.mtime : this.sessionStartTime;
      return {
        type: node.isDirectory ? vscode.FileType.Directory : vscode.FileType.File,
        ctime: stableMtime,
        mtime: stableMtime,
        size: node.size || 0,
      };
    }

    throw vscode.FileSystemError.FileNotFound(uri);
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    if (!this.isInitialized && this.client) {
      await this.initialize();
    }

    const relPath = this.getRelativePath(uri);
    const results: [string, vscode.FileType][] = [];

    for (const [nodePath, node] of this.treeNodes.entries()) {
      const parent = nodePath.includes('/') ? nodePath.substring(0, nodePath.lastIndexOf('/')) : '';
      if (parent === relPath) {
        results.push([
          node.name,
          node.isDirectory ? vscode.FileType.Directory : vscode.FileType.File,
        ]);
      }
    }

    return results;
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const relPath = this.getRelativePath(uri);

    // 1. Cache hit
    const cached = this.fileCache.get(relPath);
    if (cached) {
      return cached.content;
    }

    // 2. Coalesce concurrent reads
    if (this.pendingReads.has(relPath)) {
      return await this.pendingReads.get(relPath)!;
    }

    if (!this.client) {
      throw vscode.FileSystemError.Unavailable(uri);
    }

    const readPromise = (async () => {
      try {
        const res = await this.client!.sendRequest<ReadFileResponseMessage>({
          type: 'read_file_request',
          path: relPath,
        });

        if (res.error || res.content === undefined) {
          throw new Error(res.error || 'Empty file or read error from host');
        }

        const bytes = base64ToUint8Array(res.content);
        this.fileCache.set(relPath, {
          content: bytes,
          timestamp: Date.now(),
        });
        return bytes;
      } finally {
        this.pendingReads.delete(relPath);
      }
    })();

    this.pendingReads.set(relPath, readPromise);
    return await readPromise;
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean }
  ): Promise<void> {
    if (!this.client) {
      throw vscode.FileSystemError.Unavailable(uri);
    }

    if (this.client.currentParticipant?.access === 'read-only') {
      vscode.window.showErrorMessage('Write failed: You have Read-Only permissions in this session.');
      throw vscode.FileSystemError.NoPermissions(uri);
    }

    const relPath = this.getRelativePath(uri);
    const base64 = uint8ArrayToBase64(content);
    const now = Date.now();

    // Fast-write in-memory cache with exact timestamp
    this.fileCache.set(relPath, {
      content,
      timestamp: now,
    });

    const node = this.treeNodes.get(relPath);
    if (node) {
      node.mtime = now;
      node.size = content.length;
    }

    try {
      const res = await this.client.sendRequest<WriteFileResponseMessage>({
        type: 'write_file_request',
        path: relPath,
        content: base64,
      });

      if (!res.success) {
        throw new Error(res.error || 'Failed to write file on host');
      }

      // Note: Do NOT fire this._emitter.fire(Changed) here.
      // VS Code is the caller of writeFile and already has the document in memory.
      // Firing Changed here would prompt VS Code to reload from disk and trigger duplicate text!
    } catch (err: any) {
      vscode.window.showErrorMessage(`Write failed: ${err.message}`);
      throw vscode.FileSystemError.NoPermissions(uri);
    }
  }

  async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    if (!this.client) throw vscode.FileSystemError.Unavailable(uri);

    const relPath = this.getRelativePath(uri);
    try {
      await this.client.sendRequest<any>({
        type: 'delete_file_request',
        path: relPath,
        recursive: options.recursive,
      });
      this.fileCache.delete(relPath);
      this.treeNodes.delete(relPath);
      this._emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
    } catch (err: any) {
      throw vscode.FileSystemError.NoPermissions(uri);
    }
  }

  async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    const oldRel = this.getRelativePath(oldUri);
    const node = this.treeNodes.get(oldRel);
    if (node?.isDirectory) {
      const newRel = this.getRelativePath(newUri);
      await this.createDirectory(newUri);
      for (const [p, child] of Array.from(this.treeNodes.entries())) {
        if (p.startsWith(oldRel + '/')) {
          const sub = p.substring(oldRel.length + 1);
          const target = `${newRel}/${sub}`;
          const targetUri = vscode.Uri.parse(`${TogatherFileSystemProvider.SCHEME}:/${target}`);
          if (child.isDirectory) {
            await this.createDirectory(targetUri);
          } else {
            const data = await this.readFile(vscode.Uri.parse(`${TogatherFileSystemProvider.SCHEME}:/${p}`));
            await this.writeFile(targetUri, data, { create: true, overwrite: true });
          }
        }
      }
      await this.delete(oldUri, { recursive: true });
      await this.fetchTree();
      this._emitter.fire([
        { type: vscode.FileChangeType.Deleted, uri: oldUri },
        { type: vscode.FileChangeType.Created, uri: newUri },
      ]);
      return;
    }

    const content = await this.readFile(oldUri);
    await this.writeFile(newUri, content, { create: true, overwrite: options.overwrite });
    await this.delete(oldUri, { recursive: false });
    await this.fetchTree();
    this._emitter.fire([
      { type: vscode.FileChangeType.Deleted, uri: oldUri },
      { type: vscode.FileChangeType.Created, uri: newUri },
    ]);
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    if (!this.client) throw vscode.FileSystemError.Unavailable(uri);

    const relPath = this.getRelativePath(uri);
    try {
      await this.client.sendRequest<any>({
        type: 'create_dir_request',
        path: relPath,
      });
      await this.fetchTree();
      this._emitter.fire([{ type: vscode.FileChangeType.Created, uri }]);
    } catch (err: any) {
      throw vscode.FileSystemError.NoPermissions(uri);
    }
  }

  watch(uri: vscode.Uri, options: { recursive: boolean; excludes: string[] }): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }
}
