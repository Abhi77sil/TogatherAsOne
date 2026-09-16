import * as vscode from 'vscode';
import { Participant, DiscoveredSession, SharedTerminalInfo, SharedPortInfo } from '../protocol/types';
import { SessionManager } from '../session/sessionManager';

export class SessionTreeItem extends vscode.TreeItem {
  constructor(
    public label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly participant?: Participant,
    public readonly isAction = false,
    public readonly commandId?: string,
    public readonly commandArgs?: any[]
  ) {
    super(label, collapsibleState);

    if (participant) {
      const isHost = participant.role === 'host';
      const isGithub = participant.name.startsWith('@');
      const badgeIcon = isHost ? '👑 ' : isGithub ? '★ ' : '👤 ';
      this.label = `${badgeIcon}${participant.name}`;
      this.description = isHost ? '[Host]' : `[${participant.access}]`;
      this.tooltip = new vscode.MarkdownString(
        `### ${badgeIcon} ${participant.name}\n\n- **Role**: \`${participant.role.toUpperCase()}\`\n- **Permissions**: \`${participant.access}\`\n- **IP**: \`${participant.ip || 'Local'}\`\n- **Active File**: \`${participant.activeFile || 'None'}\`\n\nClick to manage permissions or kick.`
      );
      this.iconPath = new vscode.ThemeIcon(
        isHost ? 'crown' : isGithub ? 'github' : 'account',
        new vscode.ThemeColor(isHost ? 'charts.green' : 'charts.blue')
      );
      this.contextValue = isHost ? 'host' : 'guest';

      if (!isHost) {
        this.command = {
          command: 'togather.manageParticipant',
          title: 'Manage Participant',
          arguments: [participant.id],
        };
      }
    }

    if (commandId) {
      this.command = {
        command: commandId,
        title: label,
        arguments: commandArgs,
      };
    }
  }
}

export class SessionViewProvider implements vscode.TreeDataProvider<SessionTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SessionTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private sessionManager: SessionManager) {}

  public refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SessionTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SessionTreeItem): Promise<SessionTreeItem[]> {
    if (element) return [];

    const activeSession = this.sessionManager.getActiveSession();
    if (!activeSession) {
      const statusItem = new SessionTreeItem(
        'Status: NOT CONNECTED (Offline)',
        vscode.TreeItemCollapsibleState.None
      );
      statusItem.iconPath = new vscode.ThemeIcon('circle-slash');
      statusItem.description = 'No active LAN session';

      return [
        statusItem,
        new SessionTreeItem(
          'Start LAN Session (Host)',
          vscode.TreeItemCollapsibleState.None,
          undefined,
          true,
          'togather.startHostSession'
        ),
        new SessionTreeItem(
          'Join LAN Session (Manual IP)',
          vscode.TreeItemCollapsibleState.None,
          undefined,
          true,
          'togather.joinSession'
        ),
      ];
    }

    const items: SessionTreeItem[] = [];

    // 1. Prominent Stop Sharing / Leave Button
    const stopActionLabel = this.sessionManager.isHost()
      ? '⛔ Stop Sharing Session'
      : '⛔ Disconnect & Leave Session';
    const stopBtn = new SessionTreeItem(
      stopActionLabel,
      vscode.TreeItemCollapsibleState.None,
      undefined,
      true,
      'togather.stopSession'
    );
    stopBtn.iconPath = new vscode.ThemeIcon('debug-stop', new vscode.ThemeColor('errorForeground'));
    stopBtn.tooltip = 'Immediately disconnect from the LAN session and close network sockets.';
    items.push(stopBtn);

    // 2. Clear Status Indicator
    const isHost = this.sessionManager.isHost();
    const statusLabel = isHost
      ? '● Status: HOSTING (LAN Active)'
      : `● Status: CONNECTED to ${activeSession.hostName}`;
    const statusItem = new SessionTreeItem(statusLabel, vscode.TreeItemCollapsibleState.None);
    statusItem.iconPath = new vscode.ThemeIcon(
      isHost ? 'broadcast' : 'pass-filled',
      new vscode.ThemeColor('charts.green')
    );
    statusItem.description = `[${activeSession.hostIp}:${activeSession.port}]`;
    items.push(statusItem);

    // 3. Host Quick Controls (Only visible to Host)
    if (isHost) {
      const autoApprove = this.sessionManager.isAutoApprove();
      const autoApproveItem = new SessionTreeItem(
        `Auto-Approve: ${autoApprove ? 'ON (Bypass)' : 'OFF (Prompt)'}`,
        vscode.TreeItemCollapsibleState.None,
        undefined,
        true,
        'togather.toggleAutoApprove'
      );
      autoApproveItem.iconPath = new vscode.ThemeIcon(
        autoApprove ? 'shield' : 'workspace-trusted',
        new vscode.ThemeColor(autoApprove ? 'charts.green' : 'charts.orange')
      );
      autoApproveItem.tooltip = 'Click to toggle whether peers automatically join without prompting for approval.';
      items.push(autoApproveItem);

      const readOnlyAllItem = new SessionTreeItem(
        'Set All to Read-Only',
        vscode.TreeItemCollapsibleState.None,
        undefined,
        true,
        'togather.setAllReadOnly'
      );
      readOnlyAllItem.iconPath = new vscode.ThemeIcon('lock');
      readOnlyAllItem.tooltip = 'Change all connected guests to read-only mode.';
      items.push(readOnlyAllItem);

      const readWriteAllItem = new SessionTreeItem(
        'Set All to Read & Write',
        vscode.TreeItemCollapsibleState.None,
        undefined,
        true,
        'togather.setAllReadWrite'
      );
      readWriteAllItem.iconPath = new vscode.ThemeIcon('edit');
      readWriteAllItem.tooltip = 'Grant all connected guests read & write editing permissions.';
      items.push(readWriteAllItem);
    }

    // 4. Session info & PIN
    if (activeSession.requirePin && activeSession.pin) {
      const pinItem = new SessionTreeItem(
        `PIN Code: ${activeSession.pin}`,
        vscode.TreeItemCollapsibleState.None
      );
      pinItem.iconPath = new vscode.ThemeIcon('key');
      items.push(pinItem);
    }

    // 5. Copy invite item
    const copyItem = new SessionTreeItem(
      'Copy LAN Invite Details',
      vscode.TreeItemCollapsibleState.None,
      undefined,
      true,
      'togather.copyInviteInfo'
    );
    copyItem.iconPath = new vscode.ThemeIcon('copy');
    items.push(copyItem);

    // 6. Open Chat item
    const chatItem = new SessionTreeItem(
      'Open LAN Chat Room',
      vscode.TreeItemCollapsibleState.None,
      undefined,
      true,
      'togather.openChat'
    );
    chatItem.iconPath = new vscode.ThemeIcon('comment-discussion');
    items.push(chatItem);

    // 7. Participants header and list
    const participants = this.sessionManager.getParticipants();
    for (const p of participants) {
      items.push(new SessionTreeItem(p.name, vscode.TreeItemCollapsibleState.None, p));
    }

    return items;
  }
}

export class DiscoveryViewProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private sessionManager: SessionManager) {}

  public refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element) return [];

    const discovered = this.sessionManager.getDiscoveredSessions();
    if (discovered.length === 0) {
      const item = new vscode.TreeItem('No LAN sessions found. Click refresh to scan.');
      item.iconPath = new vscode.ThemeIcon('search');
      return [item];
    }

    return discovered.map((s) => {
      const item = new vscode.TreeItem(
        `${s.hostName}'s Session (${s.workspaceName})`,
        vscode.TreeItemCollapsibleState.None
      );
      item.description = `${s.hostIp}:${s.port}${s.requirePin ? ' 🔒 PIN' : ' 🔓 Direct'}`;
      const md = new vscode.MarkdownString(
        `### 🚀 ${s.workspaceName}\n\n- **Host**: \`${s.hostName}\`\n- **LAN Address**: \`${s.hostIp}:${s.port}\`\n- **Access**: ${s.requirePin ? '🔒 4-Digit PIN Required' : '🔓 Instant Join'}\n\n*Click to connect and collaborate in real-time!*`
      );
      md.isTrusted = true;
      item.tooltip = md;
      item.iconPath = new vscode.ThemeIcon(s.requirePin ? 'shield' : 'radio-tower');
      item.command = {
        command: 'togather.joinDiscoveredSession',
        title: 'Join Session',
        arguments: [s],
      };
      return item;
    });
  }
}

export class TerminalsViewProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private sessionManager: SessionManager) {}

  public refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element) return [];

    const terminals = this.sessionManager.getSharedTerminals();
    const items: vscode.TreeItem[] = [];

    if (this.sessionManager.isHost()) {
      const shareItem = new vscode.TreeItem('Share a Terminal...');
      shareItem.iconPath = new vscode.ThemeIcon('add');
      shareItem.command = {
        command: 'togather.shareTerminal',
        title: 'Share a Terminal',
      };
      items.push(shareItem);
    }

    if (terminals.length === 0) {
      if (!this.sessionManager.isHost()) {
        const item = new vscode.TreeItem('No terminals shared by host.');
        item.iconPath = new vscode.ThemeIcon('terminal');
        items.push(item);
      }
      return items;
    }

    for (const t of terminals) {
      const item = new vscode.TreeItem(t.name, vscode.TreeItemCollapsibleState.None);
      item.description = `[${t.access}]`;
      item.iconPath = new vscode.ThemeIcon('terminal');
      item.command = {
        command: 'togather.openSharedTerminal',
        title: 'Open Terminal',
        arguments: [t],
      };
      items.push(item);
    }

    return items;
  }
}

export class PortsViewProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private sessionManager: SessionManager) {}

  public refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element) return [];

    const ports = this.sessionManager.getSharedPorts();
    const items: vscode.TreeItem[] = [];

    if (this.sessionManager.isHost()) {
      const shareItem = new vscode.TreeItem('Share a Port...');
      shareItem.iconPath = new vscode.ThemeIcon('add');
      shareItem.command = {
        command: 'togather.sharePort',
        title: 'Share a Port',
      };
      items.push(shareItem);
    }

    if (ports.length === 0) {
      if (!this.sessionManager.isHost()) {
        const item = new vscode.TreeItem('No ports shared by host.');
        item.iconPath = new vscode.ThemeIcon('globe');
        items.push(item);
      }
      return items;
    }

    for (const p of ports) {
      const item = new vscode.TreeItem(`${p.name} (Port ${p.port})`, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('globe');
      item.command = {
        command: 'togather.openBrowserPort',
        title: 'Open in Browser',
        arguments: [p],
      };
      items.push(item);
    }

    return items;
  }
}
