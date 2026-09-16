import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import {
  Participant,
  SessionInfo,
  DiscoveredSession,
  SharedTerminalInfo,
  SharedPortInfo,
  ActivityLogEntry,
} from '../protocol/types';
import { LANServer } from '../network/lanServer';
import { LANClient } from '../network/lanClient';
import { LANDiscoveryService } from '../network/discovery';
import { HostFileManager } from '../filesystem/hostFileManager';
import { TogatherFileSystemProvider } from '../filesystem/togatherFileSystemProvider';
import * as Y from 'yjs';
import { CRDTDocManager } from '../collab/crdtDocManager';
import { ActivityLogger } from '../collab/activityLogger';
import { CursorManager } from '../collab/cursorManager';
import { FollowManager } from '../collab/followManager';
import { SharedTerminalManager } from '../terminal/sharedTerminalManager';
import { PortForwardManager } from '../ports/portForwardManager';
import { ChatManager } from '../chat/chatManager';
import { TogatherStatusBar } from '../ui/statusBar';
import { ChatWebviewPanel } from '../ui/chatWebview';
import {
  getLocalLanIps,
  generatePin,
  generateId,
  uint8ArrayToBase64,
} from '../utils/networkUtils';
import { getGitHubUsername } from '../utils/githubUtils';
import { AccessLevel } from '../protocol/types';
import { isPortAllowed, automateOpenPort } from '../utils/firewallUtils';

export class SessionManager extends EventEmitter {
  private extensionContext: vscode.ExtensionContext;
  private statusBar: TogatherStatusBar;
  private discoveryService: LANDiscoveryService;

  private hostServer: LANServer | null = null;
  private guestClient: LANClient | null = null;
  private hostFileManager: HostFileManager | null = null;
  private fileSystemProvider: TogatherFileSystemProvider;

  private crdtDocManager: CRDTDocManager | null = null;
  private cursorManager: CursorManager | null = null;
  private followManager: FollowManager | null = null;
  private terminalManager: SharedTerminalManager | null = null;
  private portManager: PortForwardManager | null = null;
  private chatManager: ChatManager | null = null;

  private currentSession: SessionInfo | null = null;
  private currentParticipant: Participant | null = null;

  constructor(context: vscode.ExtensionContext) {
    super();
    this.extensionContext = context;
    this.statusBar = new TogatherStatusBar();
    this.discoveryService = new LANDiscoveryService();
    this.fileSystemProvider = new TogatherFileSystemProvider();

    // Register File System Provider globally once
    context.subscriptions.push(
      vscode.workspace.registerFileSystemProvider(
        TogatherFileSystemProvider.SCHEME,
        this.fileSystemProvider,
        { isCaseSensitive: true }
      )
    );

    this.discoveryService.on('sessionsChanged', () => {
      this.emit('sessionsChanged');
    });

    // Auto-discover on startup if enabled
    const config = vscode.workspace.getConfiguration('togather');
    if (config.get<boolean>('autoDiscover', true)) {
      this.discoveryService.startScanning();
    }
  }

  public getFileSystemProvider(): TogatherFileSystemProvider {
    return this.fileSystemProvider;
  }

  public isHost(): boolean {
    return this.hostServer !== null;
  }

  public isConnected(): boolean {
    return this.currentSession !== null;
  }

  public getActiveSession(): SessionInfo | null {
    return this.currentSession;
  }

  public getCurrentParticipant(): Participant | null {
    return this.currentParticipant;
  }

  public getParticipants(): Participant[] {
    if (this.hostServer) {
      const guests = this.hostServer.getConnectedParticipants();
      const host: Participant = {
        id: 'host',
        name: this.currentSession?.hostName || 'Host',
        role: 'host',
        access: 'read-write',
        color: '#22c55e',
      };
      return [host, ...guests];
    }
    if (this.guestClient) {
      return Array.from(this.guestClient.participants.values());
    }
    return [];
  }

  public getDiscoveredSessions(): DiscoveredSession[] {
    return this.discoveryService.getDiscoveredSessions();
  }

  public getSharedTerminals(): SharedTerminalInfo[] {
    return this.terminalManager?.getSharedTerminalsList() || [];
  }

  public getSharedPorts(): SharedPortInfo[] {
    return this.portManager?.getSharedPortsList() || [];
  }

  public getChatManager(): ChatManager | null {
    return this.chatManager;
  }

  // ==========================================
  // HOST SESSION
  // ==========================================

  public async startHosting(port?: number, requirePin?: boolean): Promise<void> {
    if (this.currentSession) {
      vscode.window.showWarningMessage('A session is already running. Please end it first.');
      return;
    }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      vscode.window.showErrorMessage('Please open a folder or workspace before hosting a session.');
      return;
    }

    const rootPath = folders[0].uri.fsPath;
    const workspaceName = folders[0].name;

    const config = vscode.workspace.getConfiguration('togather');
    const configuredPort = port || config.get<number>('defaultPort', 7890);
    const shouldRequirePin =
      requirePin !== undefined ? requirePin : config.get<boolean>('requirePin', true);

    const githubUser = await getGitHubUsername();
    const configuredUserName =
      config.get<string>('userName', '') ||
      (githubUser ? `@${githubUser}` : os.userInfo().username || 'Host');

    const lanIps = getLocalLanIps();
    const primaryIp = lanIps[0];
    const pin = shouldRequirePin ? generatePin() : undefined;
    const sessionId = generateId('sess');

    const session: SessionInfo = {
      sessionId,
      hostName: configuredUserName,
      workspaceName,
      hostIp: primaryIp,
      port: configuredPort,
      requirePin: shouldRequirePin,
      pin,
      createdAt: Date.now(),
    };

    try {
      this.hostServer = new LANServer();
      this.hostServer.autoApprove = config.get<boolean>('autoApprove', true);

      // Host connection approval prompt
      this.hostServer.onApprovalPrompt = async (guestName, guestIp) => {
        const choice = await vscode.window.showInformationMessage(
          `Participant "${guestName}" (${guestIp}) wants to join your LAN session.`,
          'Allow Read & Write',
          'Allow Read-Only',
          'Reject'
        );
        if (choice === 'Allow Read & Write') return 'read-write';
        if (choice === 'Allow Read-Only') return 'read-only';
        return null;
      };

      const actualPort = await this.hostServer.start(session);
      session.port = actualPort;
      this.currentSession = session;

      this.currentParticipant = {
        id: 'host',
        name: configuredUserName,
        role: 'host',
        access: 'read-write',
        color: '#22c55e',
      };

      // Initialize CRDT Doc Manager first so file manager can check active docs
      this.crdtDocManager = new CRDTDocManager({
        isHost: () => true,
        canWrite: () => true,
        getCurrentParticipant: () => this.currentParticipant,
        getParticipant: (id: string) =>
          this.hostServer?.getConnectedParticipants().find((p) => p.id === id),
        broadcastDocUpdate: (filePath, update) => {
          this.hostServer?.broadcast({
            type: 'doc_update',
            filePath,
            update: uint8ArrayToBase64(update),
          });
        },
        sendDocMessage: (participantId, msg) => {
          this.hostServer?.sendTo(participantId, msg);
        },
        onSaveToDisk: async (filePath, content) => {
          if (this.hostFileManager) {
            await this.hostFileManager.saveDocumentContent(filePath, content);
          }
        },
        onReadFromDisk: async (filePath) => {
          if (this.hostFileManager) {
            try {
              return await this.hostFileManager.readDocumentText(filePath);
            } catch (err) {
              console.error(`[Togather] Error reading document ${filePath} from disk:`, err);
              return '';
            }
          }
          return '';
        },
        markRecentSave: (filePath) => {
          this.hostFileManager?.recentSaves.set(filePath, Date.now());
        },
        onActivityLogEntry: (entry) => {
          this.hostServer?.broadcast({
            type: 'activity_log_entry',
            entry,
          });
          this.emit('activityLoggerChanged');
        },
      });

      this.crdtDocManager.activityLogger.on('changed', () => {
        this.emit('activityLoggerChanged');
      });

      // Initialize Host File Manager with isDocActive guard
      this.hostFileManager = new HostFileManager(
        rootPath,
        this.hostServer,
        (filePath) => this.crdtDocManager?.hasDoc(filePath) || false
      );

      // Pre-seed CRDT manager with all currently open workspace text documents
      this.crdtDocManager.seedOpenDocuments();

      // Handle CRDT messages from guests
      this.hostServer.on('docMessage', async ({ client, msg }) => {
        if (!this.crdtDocManager) return;
        if (msg.type === 'doc_update') {
          // If guest has read-only permission, reject update and re-sync them
          if (client.participant.access === 'read-only') {
            const ydoc = this.crdtDocManager.getOrCreateYDoc(msg.filePath);
            const state = Y.encodeStateAsUpdate(ydoc);
            this.hostServer?.sendTo(client.participant.id, {
              type: 'doc_sync_step2',
              filePath: msg.filePath,
              update: uint8ArrayToBase64(state),
            });
            return;
          }

          // Broadcast to other guests
          this.hostServer?.broadcast(msg, client.participant.id);
          await this.crdtDocManager.handleRemoteUpdate(msg.filePath, msg.update, client.participant.id);
        } else if (msg.type === 'doc_sync_step1') {
          await this.crdtDocManager.handleSyncStep1(msg.filePath, msg.vector, client.participant.id);
        } else if (msg.type === 'doc_sync_step2') {
          this.crdtDocManager.handleSyncStep2(msg.filePath, msg.update);
        }
      });

      // Initialize Cursor Manager
      this.cursorManager = new CursorManager(
        (uri) => this.crdtDocManager?.getNormalizedFilePath(uri) || null,
        (cursorData) => {
          this.hostServer?.broadcast({
            type: 'cursor_update',
            senderId: 'host',
            ...cursorData,
          });
        },
        (filePath) => {
          this.hostServer?.broadcast({
            type: 'active_file_update',
            senderId: 'host',
            filePath,
          });
        }
      );

      this.hostServer.on('cursorUpdate', ({ participant, msg }) => {
        this.cursorManager?.updateRemoteCursor(
          participant,
          msg.filePath,
          msg.cursor,
          msg.selection,
          (uri) => this.crdtDocManager?.getNormalizedFilePath(uri) || null
        );
      });

      // Initialize Terminal Manager
      this.terminalManager = new SharedTerminalManager(true, {
        broadcastTerminal: (msg) => this.hostServer?.broadcast(msg),
        sendTo: (pId, msg) => this.hostServer?.sendTo(pId, msg),
      });

      this.hostServer.on('terminalInput', ({ client, msg }) => {
        if (msg.type === 'terminal_data') {
          this.terminalManager?.handleGuestTerminalInput(
            msg.terminalId,
            msg.data,
            client.participant.access
          );
        }
      });

      // Initialize Port Forward Manager
      this.portManager = new PortForwardManager(true, {
        broadcastPorts: (msg) => this.hostServer?.broadcast(msg),
        sendTo: (pId, msg) => this.hostServer?.sendTo(pId, msg),
      });

      this.hostServer.on('portTunnel', ({ client, msg }) => {
        if (msg.type === 'port_tunnel_open') {
          this.portManager?.handleTunnelOpenOnHost(msg.tunnelId, msg.portId, client.participant.id);
        } else if (msg.type === 'port_tunnel_data') {
          this.portManager?.handleTunnelDataOnHost(msg.tunnelId, msg.data);
        } else if (msg.type === 'port_tunnel_close') {
          this.portManager?.handleTunnelCloseOnHost(msg.tunnelId);
        }
      });

      // Initialize Chat Manager
      this.chatManager = new ChatManager({
        isHost: () => true,
        broadcastChat: (msg) => this.hostServer?.broadcast(msg),
        sendChatToHost: () => {},
      });

      this.hostServer.on('chatSend', ({ client, msg }) => {
        this.chatManager?.sendMessage(
          client.participant.id,
          client.participant.name,
          client.participant.color,
          msg.text,
          msg.codeSnippet
        );
      });

      // Participant events
      this.hostServer.on('participantJoined', (p) => {
        // Send initial activity log sync to the joining participant
        const logger = this.crdtDocManager?.getActivityLogger();
        if (logger) {
          this.hostServer?.sendTo(p.id, {
            type: 'activity_log_sync',
            entries: logger.getEntries(),
          });
        }
        vscode.window.showInformationMessage(`Participant "${p.name}" joined the session.`);
        this.statusBar.updateHost(session, this.hostServer?.getConnectedParticipants().length || 0);
        this.emit('sessionChanged');
      });

      this.hostServer.on('participantLeft', (p) => {
        vscode.window.showInformationMessage(`Participant "${p.name}" left the session.`);
        this.cursorManager?.unregisterParticipant(p.id);
        this.statusBar.updateHost(session, this.hostServer?.getConnectedParticipants().length || 0);
        this.emit('sessionChanged');
      });

      // Advertise via mDNS
      this.discoveryService.advertise(session);

      // Update Status Bar & UI
      this.statusBar.updateHost(session, 0);
      this.emit('sessionChanged');

      const pinInfo = pin ? ` | PIN: ${pin}` : '';
      const actions = ['Copy Invite', 'Open Chat'];
      if (process.platform === 'linux') {
        actions.push('Firewall Allow Command');
      }

      vscode.window
        .showInformationMessage(
          `Hosting LAN Live Share on ${primaryIp}:${actualPort}${pinInfo}`,
          ...actions
        )
        .then((choice) => {
          if (choice === 'Copy Invite') this.copyInviteInfo();
          if (choice === 'Open Chat') this.openChat();
          if (choice === 'Firewall Allow Command') {
            const cmd = `sudo ufw allow ${actualPort}/tcp`;
            vscode.env.clipboard.writeText(cmd);
            vscode.window.showInformationMessage(
              `Copied to clipboard: "${cmd}". Run this in your terminal to allow other LAN laptops through your firewall.`
            );
          }
        });

      // Automated check and prompt to authorize firewall port if needed
      isPortAllowed(actualPort).then(async (fw) => {
        if (!fw.isAllowed) {
          const choice = await vscode.window.showWarningMessage(
            `Port ${actualPort} may be blocked by your firewall. Authorize it automatically?`,
            'Auto-Allow Port (Authorize)',
            'Copy Manual Command'
          );
          if (choice === 'Auto-Allow Port (Authorize)') {
            const res = await automateOpenPort(actualPort);
            if (res.success) {
              vscode.window.showInformationMessage(res.message);
            } else {
              vscode.window.showErrorMessage(res.message);
            }
          } else if (choice === 'Copy Manual Command') {
            const cmd = `sudo ufw allow ${actualPort}/tcp`;
            vscode.env.clipboard.writeText(cmd);
            vscode.window.showInformationMessage(`Copied: "${cmd}"`);
          }
        }
      });
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to start LAN host session: ${err.message}`);
      this.stopSession();
    }
  }

  // ==========================================
  // GUEST SESSION
  // ==========================================

  public async joinSession(
    hostIp: string,
    port: number,
    pin?: string,
    options?: { skipNewWindowCheck?: boolean }
  ): Promise<void> {
    if (this.currentSession) {
      vscode.window.showWarningMessage('A session is already running. Please leave it first.');
      return;
    }

    // Auto-open in new window if participant already has an existing project open
    const currentFolders = vscode.workspace.workspaceFolders;
    const hasExistingLocalFolder =
      currentFolders &&
      currentFolders.length > 0 &&
      currentFolders[0].uri.scheme !== 'togather';

    const autoOpenNewWindow = vscode.workspace
      .getConfiguration('togather')
      .get<boolean>('autoOpenNewWindowIfFolderOpen', true);

    if (hasExistingLocalFolder && autoOpenNewWindow && !options?.skipNewWindowCheck) {
      await this.extensionContext.globalState.update('togather.pendingAutoConnect', {
        hostIp,
        port,
        pin,
      });

      vscode.window.showInformationMessage(
        'Project folder already open. Launching collaborative session in a new window...'
      );

      const targetUri = vscode.Uri.parse('togather:/');
      await vscode.commands.executeCommand('vscode.openFolder', targetUri, {
        forceNewWindow: true,
      });
      return;
    }

    const config = vscode.workspace.getConfiguration('togather');
    const githubUser = await getGitHubUsername();
    const guestName =
      config.get<string>('userName', '') ||
      (githubUser ? `@${githubUser}` : '');

    try {
      const client = new LANClient();
      this.guestClient = client;

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Connecting to Togather host at ${hostIp}:${port}...`,
          cancellable: true,
        },
        async (progress, token) => {
          token.onCancellationRequested(() => {
            client.disconnect();
          });

          client.on('waitingForApproval', (statusMsg: string) => {
            progress.report({ message: statusMsg });
          });

          const joinRes = await client.connect(hostIp, port, guestName, pin);
          const session = joinRes.session!;
          this.currentSession = session;
          this.currentParticipant = joinRes.participant!;

          // Configure Virtual File System Provider
          progress.report({ message: 'Fetching remote workspace tree...' });
          this.statusBar.updateLoading('Fetching workspace...');
          this.fileSystemProvider.setClient(client);
          await this.fileSystemProvider.initialize();

          // Loading popup until all workspace files are loaded on participant
          this.statusBar.updateLoading('Synchronizing workspace files...');
          let lastReportedPct = 0;
          await this.fileSystemProvider.preloadAllFiles((loaded, total, currentPath) => {
            const pct = Math.round((loaded / total) * 100);
            const increment = pct - lastReportedPct;
            lastReportedPct = pct;
            const fileName = path.basename(currentPath);
            progress.report({
              message: `Loading files (${loaded}/${total}): ${fileName}`,
              increment: Math.max(0, increment),
            });
            this.statusBar.updateLoading(`Loading files (${loaded}/${total})`);
          });

          // If no workspace folder is open in current window, mount togather:/ as workspace root
          if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            vscode.workspace.updateWorkspaceFolders(0, 0, {
              uri: vscode.Uri.parse('togather:/'),
              name: `Togather: ${session.workspaceName} (${session.hostName})`,
            });
          }

          // Initialize CRDT Doc Manager
          this.crdtDocManager = new CRDTDocManager({
            isHost: () => false,
            canWrite: () => this.currentParticipant?.access !== 'read-only',
            getCurrentParticipant: () => this.currentParticipant,
            getParticipant: (id: string) => client.participants.get(id),
            broadcastDocUpdate: (filePath, update) => {
              client.send({
                type: 'doc_update',
                filePath,
                update: uint8ArrayToBase64(update),
              });
            },
            sendDocMessage: (_, msg) => {
              client.send(msg);
            },
          });

          this.crdtDocManager.activityLogger.on('changed', () => {
            this.emit('activityLoggerChanged');
          });

          client.on('activity_log_entry', (msg) => {
            this.crdtDocManager?.activityLogger.addEntry(msg.entry);
            this.emit('activityLoggerChanged');
          });

          client.on('activity_log_sync', (msg) => {
            this.crdtDocManager?.activityLogger.loadEntries(msg.entries);
            this.emit('activityLoggerChanged');
          });

          client.on('doc_update', async (msg) => {
            await this.crdtDocManager?.handleRemoteUpdate(msg.filePath, msg.update);
          });

          client.on('doc_sync_step2', (msg) => {
            this.crdtDocManager?.handleSyncStep2(msg.filePath, msg.update);
          });

          // Initialize Follow Manager
          this.followManager = new FollowManager(false);

          // Initialize Cursor Manager
          this.cursorManager = new CursorManager(
            (uri) => this.crdtDocManager?.getNormalizedFilePath(uri) || null,
            (cursorData) => {
              client.send({
                type: 'cursor_update',
                senderId: client.currentParticipant?.id,
                ...cursorData,
              });
            },
            (filePath) => {
              client.send({
                type: 'active_file_update',
                senderId: client.currentParticipant?.id,
                filePath,
              });
            }
          );

          client.on('cursor_update', (msg) => {
            const senderId = msg.senderId || 'host';
            let p = client.participants.get(senderId);
            if (!p && senderId === 'host' && this.currentSession) {
              p = {
                id: 'host',
                name: this.currentSession.hostName,
                role: 'host',
                access: 'read-write',
                color: '#22c55e',
              };
            }
            if (p) {
              this.cursorManager?.updateRemoteCursor(
                p,
                msg.filePath,
                msg.cursor,
                msg.selection,
                (uri) => this.crdtDocManager?.getNormalizedFilePath(uri) || null
              );
              this.followManager?.handleParticipantMoved(p.id, msg.filePath, msg.cursor);
            }
          });

          client.on('active_file_update', (msg) => {
            const senderId = msg.senderId || 'host';
            let p = client.participants.get(senderId);
            if (!p && senderId === 'host' && this.currentSession) {
              p = {
                id: 'host',
                name: this.currentSession.hostName,
                role: 'host',
                access: 'read-write',
                color: '#22c55e',
              };
            }
            if (p) {
              p.activeFile = msg.filePath;
              this.followManager?.handleParticipantMoved(p.id, msg.filePath);
            }
          });

          // Initialize Terminal Manager
          this.terminalManager = new SharedTerminalManager(
            false,
            undefined,
            (termId, data) => {
              client.send({
                type: 'terminal_data',
                terminalId: termId,
                data,
              });
            }
          );

          client.on('terminal_list', (msg) => {
            this.terminalManager?.handleTerminalList(msg.terminals);
            this.emit('sessionChanged');
          });

          client.on('terminal_data', (msg) => {
            this.terminalManager?.handleTerminalData(msg.terminalId, msg.data);
          });

          // Initialize Port Forward Manager
          this.portManager = new PortForwardManager(
            false,
            undefined,
            (tunnelMsg) => client.send(tunnelMsg)
          );

          client.on('port_list', (msg) => {
            this.portManager?.handlePortList(msg.ports);
            this.emit('sessionChanged');
          });

          client.on('port_tunnel_data', (msg) => {
            this.portManager?.handleTunnelDataOnGuest(msg.tunnelId, msg.data);
          });

          client.on('port_tunnel_close', (msg) => {
            this.portManager?.handleTunnelCloseOnGuest(msg.tunnelId);
          });

          // Initialize Chat Manager
          this.chatManager = new ChatManager({
            isHost: () => false,
            broadcastChat: () => {},
            sendChatToHost: (msg) => client.send(msg),
          });

          client.on('chat_broadcast', (msg) => {
            this.chatManager?.handleIncomingMessage(msg.message);
          });

          // Participant events
          client.on('participantJoined', (p) => {
            this.cursorManager?.registerParticipant(p);
            this.emit('sessionChanged');
          });

          client.on('participantLeft', (pId) => {
            this.cursorManager?.unregisterParticipant(pId);
            this.emit('sessionChanged');
          });

          client.on('participantUpdated', (p) => {
            if (this.currentParticipant && this.currentParticipant.id === p.id) {
              this.currentParticipant = p;
              vscode.window.showInformationMessage(
                `Host updated your permissions to: ${p.access.toUpperCase()}`
              );
            }
            this.emit('sessionChanged');
          });

          client.on('kicked', (reason) => {
            vscode.window.showWarningMessage(
              `You have been removed from the LAN session by the host.${reason ? ' Reason: ' + reason : ''}`
            );
            this.stopSession();
          });

          client.on('disconnected', () => {
            vscode.window.showWarningMessage('Disconnected from LAN collaboration session.');
            this.stopSession();
          });

          // Update Status Bar & UI
          this.statusBar.updateGuest(session, session.hostName, client.latency);
          this.emit('sessionChanged');

          client.on('latencyChanged', (ms: number) => {
            if (this.currentSession) {
              this.statusBar.updateGuest(this.currentSession, this.currentSession.hostName, ms);
            }
          });

          vscode.window.showInformationMessage(
            `Joined ${session.hostName}'s LAN session (${session.workspaceName})!`,
            'Open Remote Files',
            'Open Chat'
          ).then((c) => {
            if (c === 'Open Chat') this.openChat();
            if (c === 'Open Remote Files') {
              vscode.commands.executeCommand('togather.remoteFilesView.focus');
            }
          });
        }
      );
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to join LAN session: ${err.message}`);
      this.stopSession();
    }
  }

  // ==========================================
  // SHARED ACTIONS
  // ==========================================

  public shareTerminal(): void {
    if (!this.isHost()) {
      vscode.window.showWarningMessage('Only the session host can initiate sharing a terminal.');
      return;
    }

    vscode.window
      .showQuickPick(['Read & Write (Interactive)', 'Read-Only (Watch only)'], {
        placeHolder: 'Select access level for shared terminal',
      })
      .then((choice) => {
        if (!choice) return;
        const access = choice.includes('Read-Only') ? 'read-only' : 'read-write';
        this.terminalManager?.createHostSharedTerminal('Shared Shell', access);
        this.emit('sessionChanged');
      });
  }

  public sharePort(): void {
    if (!this.isHost()) {
      vscode.window.showWarningMessage('Only the session host can share ports.');
      return;
    }

    vscode.window
      .showInputBox({
        prompt: 'Enter local port to forward across LAN (e.g. 3000, 5173, 8080)',
        validateInput: (val) => {
          const num = parseInt(val, 10);
          if (isNaN(num) || num <= 0 || num > 65535) {
            return 'Please enter a valid port number between 1 and 65535';
          }
          return null;
        },
      })
      .then((portStr) => {
        if (!portStr) return;
        const port = parseInt(portStr, 10);
        this.portManager?.sharePort(port);
        this.emit('sessionChanged');
      });
  }

  // ==========================================
  // HOST QUICK CONTROLS
  // ==========================================

  public toggleAutoApprove(): void {
    if (!this.hostServer) return;
    this.hostServer.autoApprove = !this.hostServer.autoApprove;
    const status = this.hostServer.autoApprove ? 'ENABLED (Bypass prompt)' : 'DISABLED (Approval prompt active)';
    vscode.window.showInformationMessage(`Togather: Auto-Approve joins is now ${status}`);
    this.emit('sessionChanged');
  }

  public isAutoApprove(): boolean {
    return this.hostServer?.autoApprove || false;
  }

  public async openFirewallPort(): Promise<void> {
    const port =
      this.currentSession?.port ||
      vscode.workspace.getConfiguration('togather').get<number>('defaultPort', 7890);
    const res = await automateOpenPort(port);
    if (res.success) {
      vscode.window.showInformationMessage(res.message);
    } else {
      vscode.window.showErrorMessage(res.message);
    }
  }

  public setAllReadOnly(): void {
    if (!this.hostServer) {
      vscode.window.showWarningMessage('Only the host can set permissions.');
      return;
    }
    this.hostServer.setAllParticipantsAccess('read-only');
    vscode.window.showInformationMessage('All participants set to READ-ONLY mode.');
    this.emit('sessionChanged');
  }

  public setAllReadWrite(): void {
    if (!this.hostServer) {
      vscode.window.showWarningMessage('Only the host can set permissions.');
      return;
    }
    this.hostServer.setAllParticipantsAccess('read-write');
    vscode.window.showInformationMessage('All participants set to READ & WRITE mode.');
    this.emit('sessionChanged');
  }

  public async changeParticipantAccess(participantId: string): Promise<void> {
    if (!this.hostServer) return;
    const p = this.hostServer.getConnectedParticipants().find((x) => x.id === participantId);
    if (!p) return;

    const choice = await vscode.window.showQuickPick(
      [
        {
          label: '$(edit) Read & Write',
          description: 'Allow editing files and terminal input',
          value: 'read-write' as AccessLevel,
        },
        {
          label: '$(lock) Read-Only',
          description: 'Observer mode only (cannot edit or run commands)',
          value: 'read-only' as AccessLevel,
        },
      ],
      { placeHolder: `Set permissions for ${p.name} (Current: ${p.access})` }
    );

    if (choice) {
      this.hostServer.setParticipantAccess(participantId, choice.value);
      vscode.window.showInformationMessage(`Updated ${p.name}'s permissions to ${choice.value}.`);
      this.emit('sessionChanged');
    }
  }

  public async kickParticipant(participantId: string): Promise<void> {
    if (!this.hostServer) return;
    const p = this.hostServer.getConnectedParticipants().find((x) => x.id === participantId);
    if (!p) return;

    const choice = await vscode.window.showWarningMessage(
      `Kick ${p.name} from the collaboration session?`,
      'Yes, Kick',
      'Cancel'
    );

    if (choice === 'Yes, Kick') {
      this.hostServer.kickParticipant(participantId, 'Removed by host');
      vscode.window.showInformationMessage(`Kicked ${p.name} from session.`);
      this.emit('sessionChanged');
    }
  }

  public openChat(): void {
    if (!this.chatManager || !this.currentParticipant) {
      vscode.window.showWarningMessage('No active LAN session. Start or join one to chat.');
      return;
    }

    ChatWebviewPanel.createOrShow(
      this.extensionContext.extensionUri,
      this.chatManager,
      this.currentParticipant
    );
  }

  public copyInviteInfo(): void {
    if (!this.currentSession) return;
    const { hostIp, port, pin, workspaceName } = this.currentSession;
    const text = `Togather LAN Session:
Host IP: ${hostIp}
Port: ${port}
PIN: ${pin || 'None'}
Workspace: ${workspaceName}`;

    vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage('LAN invite details copied to clipboard!');
  }

  public stopSession(): void {
    this.discoveryService.stopAdvertising();

    if (this.hostServer) {
      this.hostServer.stop();
      this.hostServer = null;
    }

    if (this.guestClient) {
      this.guestClient.disconnect();
      this.guestClient = null;
    }

    if (this.hostFileManager) {
      this.hostFileManager.dispose();
      this.hostFileManager = null;
    }

    this.fileSystemProvider.setClient(null);

    if (this.crdtDocManager) {
      this.crdtDocManager.flushAllDiskSaves().catch(() => {});
      this.crdtDocManager.dispose();
      this.crdtDocManager = null;
    }

    if (this.cursorManager) {
      this.cursorManager.dispose();
      this.cursorManager = null;
    }

    if (this.terminalManager) {
      this.terminalManager.dispose();
      this.terminalManager = null;
    }

    if (this.portManager) {
      this.portManager.dispose();
      this.portManager = null;
    }

    this.chatManager = null;
    this.currentSession = null;
    this.currentParticipant = null;

    this.statusBar.updateOffline();
    this.emit('sessionChanged');
  }

  public getActivityLogger(): ActivityLogger | null {
    return this.crdtDocManager?.getActivityLogger() || null;
  }

  public async revertChange(entry: ActivityLogEntry): Promise<boolean> {
    if (!this.isHost()) {
      vscode.window.showWarningMessage('Only the host can revert collaborative changes.');
      return false;
    }
    if (!this.crdtDocManager) return false;

    const success = await this.crdtDocManager.revertChange(
      entry,
      this.currentParticipant?.name || 'Host'
    );
    if (success) {
      vscode.window.showInformationMessage(
        `Successfully reverted change by ${entry.authorName} in ${entry.filePath}`
      );
      this.emit('activityLoggerChanged');
    }
    return success;
  }

  public async revertAllParticipantChanges(participantId: string): Promise<number> {
    if (!this.isHost()) {
      vscode.window.showWarningMessage('Only the host can revert collaborative changes.');
      return 0;
    }
    if (!this.crdtDocManager) return 0;

    const count = await this.crdtDocManager.revertAllParticipantChanges(
      participantId,
      this.currentParticipant?.name || 'Host'
    );

    if (count > 0) {
      vscode.window.showInformationMessage(
        `Successfully reverted ${count} edits across files for participant.`
      );
      this.emit('activityLoggerChanged');
    } else {
      vscode.window.showInformationMessage('No active edits found to revert for this participant.');
    }
    return count;
  }

  public clearActivityLog(): void {
    if (this.crdtDocManager) {
      this.crdtDocManager.activityLogger.clear();
      this.emit('activityLoggerChanged');
      vscode.window.showInformationMessage('Activity log cleared.');
    }
  }

  public refreshDiscovery(): void {
    this.discoveryService.startScanning();
    this.emit('sessionsChanged');
  }

  public dispose(): void {
    this.stopSession();
    this.discoveryService.destroy();
    this.statusBar.dispose();
  }
}
