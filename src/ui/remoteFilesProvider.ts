import * as vscode from 'vscode';
import { FileTreeNode } from '../protocol/types';
import { TogatherFileSystemProvider } from '../filesystem/togatherFileSystemProvider';
import { SessionManager } from '../session/sessionManager';

export class RemoteFileItem extends vscode.TreeItem {
  constructor(public readonly node: FileTreeNode) {
    super(
      node.name,
      node.isDirectory
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    if (node.isDirectory) {
      this.iconPath = new vscode.ThemeIcon('folder');
      this.contextValue = 'directory';
    } else {
      this.iconPath = new vscode.ThemeIcon('file-code');
      this.contextValue = 'file';
      this.tooltip = node.path;
      this.command = {
        command: 'togather.openRemoteFile',
        title: 'Open File',
        arguments: [node.path],
      };
    }
  }
}

export class RemoteFilesViewProvider implements vscode.TreeDataProvider<RemoteFileItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<RemoteFileItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private sessionManager: SessionManager) {}

  public refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: RemoteFileItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: RemoteFileItem): Promise<RemoteFileItem[]> {
    if (!this.sessionManager.isConnected()) {
      const item = new vscode.TreeItem('No active session.');
      item.iconPath = new vscode.ThemeIcon('circle-slash');
      return [];
    }

    const fsProvider = this.sessionManager.getFileSystemProvider();
    if (!fsProvider) return [];

    if (!element) {
      // Root level files/directories
      const rootTree = fsProvider.getRootTree();
      if (rootTree.length === 0) {
        // Try fetching
        const fetched = await fsProvider.fetchTree();
        return fetched.map((node) => new RemoteFileItem(node));
      }
      return rootTree.map((node) => new RemoteFileItem(node));
    }

    // Subdirectory children
    if (element.node.isDirectory && element.node.children) {
      return element.node.children.map((child) => new RemoteFileItem(child));
    }

    return [];
  }
}
