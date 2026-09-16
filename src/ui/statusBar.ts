import * as vscode from 'vscode';
import { SessionInfo } from '../protocol/types';

export class TogatherStatusBar {
  private statusBarItem: vscode.StatusBarItem;

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      1000 // High priority to be prominently displayed on the bottom left
    );
    this.statusBarItem.command = 'togather.showQuickMenu';
    this.updateOffline();
    this.statusBarItem.show();
  }

  public updateOffline(): void {
    this.statusBarItem.text = '$(circle-slash) Togather: Disconnected (Offline)';
    this.statusBarItem.tooltip = new vscode.MarkdownString(
      `### Togather LAN Collaboration\n\n**Status**: ⚪ Offline (Not Connected)\n\nClick to start hosting or join a LAN session.`
    );
    this.statusBarItem.backgroundColor = undefined;
    this.statusBarItem.color = undefined;
  }

  public updateLoading(message: string): void {
    this.statusBarItem.text = `$(sync~spin) Togather: ${message}`;
    this.statusBarItem.tooltip = new vscode.MarkdownString(
      `### Togather LAN Collaboration\n\n**Status**: ⏳ ${message}`
    );
    this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }

  public updateHost(session: SessionInfo, participantCount: number): void {
    const pinStr = session.pin ? ` | PIN: ${session.pin}` : '';
    this.statusBarItem.text = `$(radio-tower) Togather: HOSTING [${session.hostIp}:${session.port}${pinStr}] $(organization) ${participantCount}`;
    this.statusBarItem.tooltip = new vscode.MarkdownString(
      `### Togather LAN Session (HOST)\n\n- **Status**: 🟢 **HOSTING**\n- **LAN IP**: \`${session.hostIp}\`\n- **Port**: \`${session.port}\`\n- **PIN**: \`${session.pin || 'None'}\`\n- **Workspace**: \`${session.workspaceName}\`\n- **Peers Connected**: \`${participantCount}\`\n\nClick to manage session or Stop Sharing.`
    );
    this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
  }

  public updateGuest(session: SessionInfo, hostName: string, latencyMs = 1): void {
    this.statusBarItem.text = `$(pulse) Togather: CONNECTED [${hostName}] ~${latencyMs}ms`;
    this.statusBarItem.tooltip = new vscode.MarkdownString(
      `### Togather LAN Session (CONNECTED)\n\n- **Status**: 🟢 **CONNECTED TO HOST**\n- **Host**: \`${hostName}\`\n- **Address**: \`${session.hostIp}:${session.port}\`\n- **Workspace**: \`${session.workspaceName}\`\n- **LAN Latency**: \`~${latencyMs}ms\`\n\nClick to open LAN Chat, Remote Files, or Leave Session.`
    );
    this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
  }

  public dispose(): void {
    this.statusBarItem.dispose();
  }
}
