import * as vscode from 'vscode';
import { SessionManager } from './session/sessionManager';
import {
  SessionViewProvider,
  DiscoveryViewProvider,
  TerminalsViewProvider,
  PortsViewProvider,
} from './ui/sidebarProvider';
import { RemoteFilesViewProvider } from './ui/remoteFilesProvider';
import { ActivityLogProvider } from './ui/activityLogProvider';
import { DiscoveredSession, SharedTerminalInfo, SharedPortInfo } from './protocol/types';

export function activate(context: vscode.ExtensionContext) {
  console.log('[TogatherAsOne] LAN Live Share extension activated.');

  const sessionManager = new SessionManager(context);

  // Tree View Providers
  const sessionViewProvider = new SessionViewProvider(sessionManager);
  const remoteFilesViewProvider = new RemoteFilesViewProvider(sessionManager);
  const discoveryViewProvider = new DiscoveryViewProvider(sessionManager);
  const terminalsViewProvider = new TerminalsViewProvider(sessionManager);
  const portsViewProvider = new PortsViewProvider(sessionManager);
  const activityLogProvider = new ActivityLogProvider(sessionManager);

  vscode.window.registerTreeDataProvider('togather.sessionView', sessionViewProvider);
  vscode.window.registerTreeDataProvider('togather.remoteFilesView', remoteFilesViewProvider);
  vscode.window.registerTreeDataProvider('togather.lanDiscoveryView', discoveryViewProvider);
  vscode.window.registerTreeDataProvider('togather.terminalsView', terminalsViewProvider);
  vscode.window.registerTreeDataProvider('togather.portsView', portsViewProvider);
  vscode.window.registerTreeDataProvider('togather.activityLogView', activityLogProvider);

  // Hook event changes to refresh views
  sessionManager.on('sessionChanged', () => {
    sessionViewProvider.refresh();
    remoteFilesViewProvider.refresh();
    terminalsViewProvider.refresh();
    portsViewProvider.refresh();
    activityLogProvider.refresh();
  });

  sessionManager.on('sessionsChanged', () => {
    discoveryViewProvider.refresh();
  });

  // Open remote file command
  context.subscriptions.push(
    vscode.commands.registerCommand('togather.openRemoteFile', async (filePath: string) => {
      const uri = vscode.Uri.parse(`togather:/${filePath}`);
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: false });
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to open remote file: ${err.message}`);
      }
    })
  );

  // Commands Registration

  // 1. Start Host
  context.subscriptions.push(
    vscode.commands.registerCommand('togather.startHostSession', async () => {
      await sessionManager.startHosting();
    })
  );

  // 2. Stop Session
  context.subscriptions.push(
    vscode.commands.registerCommand('togather.stopSession', () => {
      sessionManager.stopSession();
      vscode.window.showInformationMessage('Togather LAN session ended.');
    })
  );

  // 3. Join Session (Manual IP)
  context.subscriptions.push(
    vscode.commands.registerCommand('togather.joinSession', async () => {
      const target = await vscode.window.showInputBox({
        prompt: 'Enter Host LAN IP and Port (e.g. 192.168.1.45:7890)',
        placeHolder: '192.168.1.45:7890',
        validateInput: (val) => {
          if (!val.includes(':')) {
            return 'Format must be IP:PORT (e.g. 192.168.1.50:7890)';
          }
          return null;
        },
      });

      if (!target) return;

      const [ip, portStr] = target.split(':');
      const port = parseInt(portStr, 10);

      const pin = await vscode.window.showInputBox({
        prompt: 'Enter 4-digit PIN (leave empty if none)',
        password: true,
      });

      await sessionManager.joinSession(ip.trim(), port, pin?.trim() || undefined);
    })
  );

  // 4. Join Discovered Session
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'togather.joinDiscoveredSession',
      async (discovered: DiscoveredSession) => {
        let pin: string | undefined;
        if (discovered.requirePin) {
          pin = await vscode.window.showInputBox({
            prompt: `Session "${discovered.workspaceName}" requires a 4-digit PIN:`,
            password: true,
          });
          if (pin === undefined) return; // User cancelled
        }

        await sessionManager.joinSession(
          discovered.hostIp,
          discovered.port,
          pin?.trim() || undefined
        );
      }
    )
  );

  // 5. Copy Invite Info
  context.subscriptions.push(
    vscode.commands.registerCommand('togather.copyInviteInfo', () => {
      sessionManager.copyInviteInfo();
    })
  );

  // 6. Share Terminal
  context.subscriptions.push(
    vscode.commands.registerCommand('togather.shareTerminal', () => {
      sessionManager.shareTerminal();
    })
  );

  // 7. Share Port
  context.subscriptions.push(
    vscode.commands.registerCommand('togather.sharePort', () => {
      sessionManager.sharePort();
    })
  );

  // 8. Open Chat
  context.subscriptions.push(
    vscode.commands.registerCommand('togather.openChat', () => {
      sessionManager.openChat();
    })
  );

  // 9. Refresh Discovery Scan
  context.subscriptions.push(
    vscode.commands.registerCommand('togather.refreshDiscovery', () => {
      sessionManager.refreshDiscovery();
      vscode.window.showInformationMessage('Scanning local network for Togather sessions...');
    })
  );

  // 10. Open Shared Terminal
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'togather.openSharedTerminal',
      (termInfo: SharedTerminalInfo) => {
        // Terminal is automatically opened, but this brings it into focus
        vscode.window.showInformationMessage(`Active terminal: ${termInfo.name}`);
      }
    )
  );

  // 11. Open Browser Port
  context.subscriptions.push(
    vscode.commands.registerCommand('togather.openBrowserPort', (portInfo: SharedPortInfo) => {
      vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${portInfo.port}`));
    })
  );

  // 12. Quick Menu (from Status Bar)
  context.subscriptions.push(
    vscode.commands.registerCommand('togather.showQuickMenu', async () => {
      const active = sessionManager.getActiveSession();
      const items: { label: string; description?: string; action: () => void }[] = [];

      if (!active) {
        items.push({
          label: '$(broadcast) Start LAN Session (Host)',
          description: 'Share your current workspace over the local network',
          action: () => sessionManager.startHosting(),
        });
        items.push({
          label: '$(plug) Join LAN Session',
          description: 'Connect to a colleague on your Wi-Fi/LAN',
          action: () => vscode.commands.executeCommand('togather.joinSession'),
        });
        items.push({
          label: '$(refresh) Scan LAN for Sessions',
          description: 'Browse available sessions on local subnet',
          action: () => sessionManager.refreshDiscovery(),
        });
      } else {
        items.push({
          label: '$(comment-discussion) Open LAN Chat',
          description: 'Chat with connected participants and share snippets',
          action: () => sessionManager.openChat(),
        });
        items.push({
          label: '$(clippy) Copy Invite Info',
          description: 'Copy LAN IP, Port, and PIN to clipboard',
          action: () => sessionManager.copyInviteInfo(),
        });

        if (sessionManager.isHost()) {
          const autoApprove = sessionManager.isAutoApprove();
          items.push({
            label: `$(shield) Auto-Approve Joins: ${autoApprove ? 'ENABLED (Bypass)' : 'DISABLED (Prompt)'}`,
            description: 'Click to toggle auto-acceptance for incoming peers',
            action: () => sessionManager.toggleAutoApprove(),
          });
          items.push({
            label: '$(lock) Set All to Read-Only Mode',
            description: 'Lock workspace editing for all connected guests',
            action: () => sessionManager.setAllReadOnly(),
          });
          items.push({
            label: '$(edit) Set All to Read & Write Mode',
            description: 'Grant editing and terminal access to all guests',
            action: () => sessionManager.setAllReadWrite(),
          });
          items.push({
            label: '$(terminal) Share Terminal',
            description: 'Share a bash/zsh shell session (read-only or read-write)',
            action: () => sessionManager.shareTerminal(),
          });
          items.push({
            label: '$(globe) Share Local Port',
            description: 'Forward a local server (e.g. 3000) to peers',
            action: () => sessionManager.sharePort(),
          });
        }

        items.push({
          label: '$(circle-slash) End Collaboration Session (Stop Sharing)',
          description: 'Disconnect and close LAN sockets',
          action: () => sessionManager.stopSession(),
        });
      }

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Togather LAN Live Share Menu',
      });

      if (selected) {
        selected.action();
      }
    })
  );

  // Host Quick Controls Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('togather.toggleAutoApprove', () => {
      sessionManager.toggleAutoApprove();
    }),
    vscode.commands.registerCommand('togather.openFirewallPort', async () => {
      await sessionManager.openFirewallPort();
    }),
    vscode.commands.registerCommand('togather.setAllReadOnly', () => {
      sessionManager.setAllReadOnly();
    }),
    vscode.commands.registerCommand('togather.setAllReadWrite', () => {
      sessionManager.setAllReadWrite();
    }),
    vscode.commands.registerCommand('togather.manageParticipant', async (participantId: string) => {
      if (!sessionManager.isHost()) return;
      const p = sessionManager.getParticipants().find((x) => x.id === participantId);
      if (!p || p.role === 'host') return;

      const action = await vscode.window.showQuickPick(
        [
          {
            label:
              p.access === 'read-write'
                ? '$(lock) Switch to Read-Only'
                : '$(edit) Switch to Read & Write',
            description: `Current: ${p.access}`,
            action: 'toggle_access',
          },
          {
            label: '$(history) Revert All Changes by this User',
            description: 'Rollback all edits made by this participant',
            action: 'revert_all',
          },
          {
            label: '$(trash) Kick from Session',
            description: 'Remove user from LAN session immediately',
            action: 'kick',
          },
        ],
        { placeHolder: `Manage Participant: ${p.name}` }
      );

      if (action?.action === 'toggle_access') {
        sessionManager.changeParticipantAccess(participantId);
      } else if (action?.action === 'revert_all') {
        const confirm = await vscode.window.showWarningMessage(
          `Are you sure you want to revert ALL edits made by ${p.name}?`,
          { modal: true },
          'Revert All Edits'
        );
        if (confirm === 'Revert All Edits') {
          await sessionManager.revertAllParticipantChanges(participantId);
        }
      } else if (action?.action === 'kick') {
        sessionManager.kickParticipant(participantId);
      }
    }),
    vscode.commands.registerCommand('togather.openChangedLocation', async (entry) => {
      if (!entry || !entry.filePath) return;
      let uri: vscode.Uri;
      if (sessionManager.isHost()) {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) return;
        uri = vscode.Uri.joinPath(folders[0].uri, entry.filePath);
      } else {
        uri = vscode.Uri.parse(`togather:/${entry.filePath}`);
      }

      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc, { preview: false });
        const line = Math.max(0, (entry.startLine || 1) - 1);
        const pos = new vscode.Position(line, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to open changed file: ${err.message}`);
      }
    }),
    vscode.commands.registerCommand('togather.revertChange', async (itemOrEntry) => {
      if (!sessionManager.isHost()) {
        vscode.window.showWarningMessage('Only the host can revert collaborative changes.');
        return;
      }
      const entry = itemOrEntry?.entry || itemOrEntry;
      if (!entry) return;

      const confirm = await vscode.window.showWarningMessage(
        `Revert change by ${entry.authorName} in ${entry.filePath}?`,
        { modal: true },
        'Revert Change'
      );
      if (confirm === 'Revert Change') {
        await sessionManager.revertChange(entry);
      }
    }),
    vscode.commands.registerCommand('togather.revertUserChanges', async (item) => {
      if (!sessionManager.isHost()) {
        vscode.window.showWarningMessage('Only the host can revert collaborative changes.');
        return;
      }

      let targetParticipantId = item?.entry?.authorId;
      let targetName = item?.entry?.authorName;

      if (!targetParticipantId) {
        const participants = sessionManager.getParticipants().filter((p) => p.role !== 'host');
        if (participants.length === 0) {
          vscode.window.showInformationMessage('No connected guests to revert changes for.');
          return;
        }

        const picked = await vscode.window.showQuickPick(
          participants.map((p) => ({
            label: `$(account) ${p.name}`,
            description: `ID: ${p.id} (${p.access})`,
            participantId: p.id,
            name: p.name,
          })),
          { placeHolder: 'Select participant whose changes you want to revert' }
        );

        if (!picked) return;
        targetParticipantId = picked.participantId;
        targetName = picked.name;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to revert ALL edits made by ${targetName}? This will roll back all their changes across all files.`,
        { modal: true },
        'Revert All Edits'
      );

      if (confirm === 'Revert All Edits') {
        await sessionManager.revertAllParticipantChanges(targetParticipantId);
      }
    }),
    vscode.commands.registerCommand('togather.clearActivityLog', () => {
      sessionManager.clearActivityLog();
    })
  );

  // Check if a new window was launched specifically to connect to a collaborative session
  const pendingConnect = context.globalState.get<{ hostIp: string; port: number; pin?: string }>(
    'togather.pendingAutoConnect'
  );
  if (pendingConnect) {
    context.globalState.update('togather.pendingAutoConnect', undefined);
    // Defer slightly to ensure window and providers have fully loaded
    setTimeout(() => {
      sessionManager.joinSession(pendingConnect.hostIp, pendingConnect.port, pendingConnect.pin, {
        skipNewWindowCheck: true,
      });
    }, 600);
  }

  context.subscriptions.push(sessionManager);
}

export function deactivate() {
  console.log('[TogatherAsOne] Deactivated.');
}
