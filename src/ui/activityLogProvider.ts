import * as vscode from 'vscode';
import { ActivityLogEntry } from '../protocol/types';
import { ActivityLogger } from '../collab/activityLogger';
import { SessionManager } from '../session/sessionManager';

export class ActivityLogItem extends vscode.TreeItem {
  constructor(
    public readonly entry: ActivityLogEntry,
    public readonly isHost: boolean
  ) {
    const timeStr = new Date(entry.timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    const label = `${entry.authorName}: ${entry.filePath.split('/').pop()}`;
    super(label, vscode.TreeItemCollapsibleState.None);

    this.description = `L${entry.startLine} (${entry.summary}) • ${timeStr}`;

    if (entry.reverted) {
      this.iconPath = new vscode.ThemeIcon('history', new vscode.ThemeColor('disabledForeground'));
      this.contextValue = 'activityItemReverted';
      this.description = `[REVERTED] • ${this.description}`;
    } else {
      let iconName = 'edit';
      if (entry.changeType === 'file_created') iconName = 'diff-added';
      if (entry.changeType === 'file_deleted') iconName = 'diff-removed';

      this.iconPath = new vscode.ThemeIcon(iconName);
      // Only host has the revert action available
      this.contextValue = isHost ? 'activityItem' : 'activityItemGuest';
    }

    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.appendMarkdown(`### ${entry.authorName} (${entry.changeType})\n\n`);
    md.appendMarkdown(`- **File**: \`${entry.filePath}\` (Lines: ${entry.startLine}-${entry.endLine})\n`);
    md.appendMarkdown(`- **Time**: ${timeStr}\n`);
    md.appendMarkdown(`- **Summary**: ${entry.summary}\n`);

    if (entry.addedText) {
      md.appendMarkdown(`\n**Added:**\n\`\`\`\n${entry.addedText.slice(0, 300)}${entry.addedText.length > 300 ? '...' : ''}\n\`\`\`\n`);
    }
    if (entry.removedText) {
      md.appendMarkdown(`\n**Removed:**\n\`\`\`\n${entry.removedText.slice(0, 300)}${entry.removedText.length > 300 ? '...' : ''}\n\`\`\`\n`);
    }
    if (entry.reverted) {
      md.appendMarkdown(`\n> [!NOTE]\n> Reverted by ${entry.revertedBy || 'Host'}\n`);
    }

    this.tooltip = md;

    this.command = {
      command: 'togather.openChangedLocation',
      title: 'Jump to Change',
      arguments: [entry],
    };
  }
}

export class ActivityLogProvider implements vscode.TreeDataProvider<ActivityLogItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ActivityLogItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private sessionManager: SessionManager) {
    this.sessionManager.on('activityLoggerChanged', () => {
      this.refresh();
    });
    this.sessionManager.on('sessionChanged', () => {
      this.refresh();
    });
  }

  public refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ActivityLogItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ActivityLogItem): Promise<ActivityLogItem[]> {
    if (element) return [];

    if (!this.sessionManager.isConnected()) {
      const item = new vscode.TreeItem('No active session');
      item.description = 'Offline';
      item.iconPath = new vscode.ThemeIcon('circle-slash');
      return [item as any];
    }

    const logger = this.sessionManager.getActivityLogger();
    if (!logger) return [];

    const entries = logger.getEntries();
    if (entries.length === 0) {
      const empty = new vscode.TreeItem('No edits recorded yet');
      empty.description = 'Live change tracker active';
      empty.iconPath = new vscode.ThemeIcon('history');
      return [empty as any];
    }

    const isHost = this.sessionManager.isHost();
    return entries.map((entry) => new ActivityLogItem(entry, isHost));
  }
}
