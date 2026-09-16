import { WebSocketServer, WebSocket } from 'ws';
import { EventEmitter } from 'events';
import {
  Participant,
  SessionInfo,
  AccessLevel,
  SharedTerminalInfo,
  SharedPortInfo,
} from '../protocol/types';
import {
  TogatherMessage,
  JoinRequestMessage,
  JoinResponseMessage,
  JoinApprovalPromptMessage,
  ParticipantJoinedMessage,
  ParticipantLeftMessage,
  ParticipantUpdatedMessage,
  CursorUpdateMessage,
  ActiveFileUpdateMessage,
  DocUpdateMessage,
  DocSyncStep1Message,
  DocSyncStep2Message,
  TerminalDataMessage,
  TerminalResizeMessage,
  PortTunnelDataMessage,
  PortTunnelOpenMessage,
  PortTunnelCloseMessage,
  ChatBroadcastMessage,
} from '../protocol/messages';
import { generateId, getCollaboratorColor } from '../utils/networkUtils';

export interface ClientConnection {
  ws: WebSocket;
  participant: Participant;
  isAlive: boolean;
}

export interface JoinApprovalHandler {
  (guestName: string, guestIp: string): Promise<AccessLevel | null>;
}

export class LANServer extends EventEmitter {
  private wss: WebSocketServer | null = null;
  private clients: Map<string, ClientConnection> = new Map();
  private sessionInfo: SessionInfo | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private colorIndex = 1; // 0 reserved for host
  private guestCounter = 1;
  public autoApprove = false;
  public onApprovalPrompt?: JoinApprovalHandler;

  constructor() {
    super();
  }

  public async start(session: SessionInfo): Promise<number> {
    this.sessionInfo = session;

    return new Promise((resolve, reject) => {
      const tryBind = (portToTry: number, attemptsLeft: number) => {
        try {
          const wss = new WebSocketServer({
            port: portToTry,
            host: '0.0.0.0', // Listen on all network interfaces for LAN access
          });

          wss.once('listening', () => {
            this.wss = wss;
            const address = wss.address();
            const actualPort = typeof address === 'object' && address ? address.port : portToTry;
            if (this.sessionInfo) {
              this.sessionInfo.port = actualPort;
            }
            console.log(`[Togather] LAN WebSocket Server listening on port ${actualPort}`);
            this.startHeartbeat();

            wss.on('connection', (ws, req) => {
              this.handleNewConnection(ws, req);
            });

            wss.on('error', (err) => {
              console.error('[Togather] WebSocket Server error:', err);
            });

            resolve(actualPort);
          });

          wss.once('error', (err: any) => {
            if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
              console.warn(`[Togather] Port ${portToTry} in use, attempting port ${portToTry + 1}...`);
              tryBind(portToTry + 1, attemptsLeft - 1);
            } else {
              console.error('[Togather] WebSocket Server error:', err);
              reject(err);
            }
          });
        } catch (err) {
          reject(err);
        }
      };

      tryBind(session.port, 10);
    });
  }

  private handleNewConnection(ws: WebSocket, req: any): void {
    const guestIp =
      (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || 'unknown';

    let participantId: string | null = null;

    ws.on('pong', () => {
      const pId = (ws as any).participantId || participantId;
      if (pId && this.clients.has(pId)) {
        this.clients.get(pId)!.isAlive = true;
      }
    });

    ws.on('message', async (data: Buffer | string) => {
      try {
        const msg: TogatherMessage = JSON.parse(data.toString());

        if (msg.type === 'join_request') {
          const participant = await this.handleJoinRequest(ws, msg as JoinRequestMessage, guestIp);
          if (participant) {
            participantId = participant.id;
            (ws as any).participantId = participant.id;
          }
          return;
        }

        const activeId = (ws as any).participantId || participantId;
        if (!activeId || !this.clients.has(activeId)) {
          console.warn('[Togather] Message received from unauthenticated client');
          return;
        }

        const client = this.clients.get(activeId)!;
        client.isAlive = true; // Mark alive on any message

        // Forward message to appropriate listeners or broadcast
        this.handleAuthenticatedMessage(client, msg);
      } catch (err) {
        console.error('[Togather] Error handling incoming client message:', err);
      }
    });

    ws.on('close', () => {
      const activeId = (ws as any).participantId || participantId;
      if (activeId && this.clients.has(activeId)) {
        const client = this.clients.get(activeId)!;
        this.clients.delete(activeId);
        console.log(`[Togather] Participant disconnected: ${client.participant.name}`);

        // Broadcast left message
        const leftMsg: ParticipantLeftMessage = {
          type: 'participant_left',
          participantId: activeId,
        };
        this.broadcast(leftMsg);
        this.emit('participantLeft', client.participant);
      }
    });

    ws.on('error', (err) => {
      console.error('[Togather] Client socket error:', err);
    });
  }

  private async handleJoinRequest(
    ws: WebSocket,
    msg: JoinRequestMessage,
    guestIp: string
  ): Promise<Participant | null> {
    if (!this.sessionInfo) return null;

    // Check PIN if required
    if (this.sessionInfo.requirePin && this.sessionInfo.pin) {
      if (msg.pin !== this.sessionInfo.pin) {
        const rejectMsg: JoinResponseMessage = {
          type: 'join_response',
          success: false,
          error: 'Incorrect session PIN code.',
        };
        ws.send(JSON.stringify(rejectMsg));
        ws.close();
        return null;
      }
    }

    // Format guest display name (assign Guest 1, Guest 2 if not provided)
    let guestName = msg.name?.trim();
    if (!guestName || guestName.toLowerCase() === 'guest' || guestName.toLowerCase() === 'anonymous guest') {
      guestName = `Guest ${this.guestCounter++}`;
    }

    // Host approval check if configured (bypass if autoApprove is enabled)
    let access: AccessLevel = 'read-write';
    if (!this.autoApprove && this.onApprovalPrompt) {
      // Notify guest that request reached host and is awaiting approval
      const waitingNotice: JoinApprovalPromptMessage = {
        type: 'join_approval_prompt',
        message: 'Waiting for host to approve your join request...',
      };
      try {
        ws.send(JSON.stringify(waitingNotice));
      } catch (e) {}

      const approvedAccess = await this.onApprovalPrompt(guestName, guestIp);
      if (!approvedAccess) {
        const rejectMsg: JoinResponseMessage = {
          type: 'join_response',
          success: false,
          error: 'Host declined connection request.',
        };
        ws.send(JSON.stringify(rejectMsg));
        ws.close();
        return null;
      }
      access = approvedAccess;
    }

    const participantId = generateId('guest');
    const color = getCollaboratorColor(this.colorIndex++);

    const participant: Participant = {
      id: participantId,
      name: guestName,
      role: 'guest',
      access,
      color,
      ip: guestIp,
    };

    const clientConn: ClientConnection = {
      ws,
      participant,
      isAlive: true,
    };

    this.clients.set(participantId, clientConn);

    // Send success response
    const existingParticipants = Array.from(this.clients.values()).map((c) => c.participant);
    // Include host
    const hostParticipant: Participant = {
      id: 'host',
      name: this.sessionInfo.hostName,
      role: 'host',
      access: 'read-write',
      color: '#22c55e',
    };

    const response: JoinResponseMessage = {
      type: 'join_response',
      success: true,
      participant,
      session: this.sessionInfo,
      participants: [hostParticipant, ...existingParticipants],
    };

    ws.send(JSON.stringify(response));

    // Announce to all other participants
    const announceMsg: ParticipantJoinedMessage = {
      type: 'participant_joined',
      participant,
    };
    this.broadcast(announceMsg, participantId);

    this.emit('participantJoined', participant);
    console.log(`[Togather] Guest successfully joined: ${participant.name} (${participantId})`);
    return participant;
  }

  private handleAuthenticatedMessage(client: ClientConnection, msg: TogatherMessage): void {
    msg.senderId = client.participant.id;

    switch (msg.type) {
      // Direct file system operations handled on host
      case 'file_tree_request':
      case 'read_file_request':
      case 'write_file_request':
      case 'delete_file_request':
      case 'create_dir_request':
        this.emit('fileSystemRequest', { client, msg });
        break;

      // Real-time Collaborative Editing (Yjs CRDT)
      case 'doc_open':
      case 'doc_close':
      case 'doc_sync_step1':
      case 'doc_sync_step2':
      case 'doc_update':
        this.emit('docMessage', { client, msg });
        break;

      // Presence: broadcast cursor and active file to everyone else
      case 'cursor_update': {
        const cursorMsg = msg as CursorUpdateMessage;
        client.participant.activeFile = cursorMsg.filePath;
        client.participant.cursor = cursorMsg.cursor;
        this.broadcast(msg, client.participant.id);
        this.emit('cursorUpdate', { participant: client.participant, msg: cursorMsg });
        break;
      }

      case 'active_file_update': {
        const fileMsg = msg as ActiveFileUpdateMessage;
        client.participant.activeFile = fileMsg.filePath;
        this.broadcast(msg, client.participant.id);
        this.emit('activeFileUpdate', { participant: client.participant, msg: fileMsg });
        break;
      }

      // Shared Terminals
      case 'terminal_data':
      case 'terminal_resize':
        this.emit('terminalInput', { client, msg });
        break;

      // Shared Ports
      case 'port_tunnel_open':
      case 'port_tunnel_data':
      case 'port_tunnel_close':
        this.emit('portTunnel', { client, msg });
        break;

      // Chat
      case 'chat_send':
        this.emit('chatSend', { client, msg });
        break;

      default:
        this.emit('customMessage', { client, msg });
        break;
    }
  }

  public broadcast(msg: TogatherMessage, excludeParticipantId?: string): void {
    const data = JSON.stringify(msg);
    for (const [pId, client] of this.clients.entries()) {
      if (excludeParticipantId && pId === excludeParticipantId) continue;
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    }
  }

  public sendTo(participantId: string, msg: TogatherMessage): boolean {
    const client = this.clients.get(participantId);
    if (client && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  public kickParticipant(participantId: string, reason?: string): void {
    const client = this.clients.get(participantId);
    if (client) {
      client.ws.send(
        JSON.stringify({
          type: 'kick_participant',
          participantId,
          reason: reason || 'Removed by host',
        })
      );
      client.ws.close();
      this.clients.delete(participantId);
      this.broadcast({
        type: 'participant_left',
        participantId,
      });
      this.emit('participantLeft', client.participant);
    }
  }

  public setAllParticipantsAccess(access: AccessLevel): void {
    for (const client of this.clients.values()) {
      client.participant.access = access;
      const updateMsg: ParticipantUpdatedMessage = {
        type: 'participant_updated',
        participant: client.participant,
      };
      this.broadcast(updateMsg);
      this.emit('participantUpdated', client.participant);
    }
  }

  public setParticipantAccess(participantId: string, access: AccessLevel): boolean {
    const client = this.clients.get(participantId);
    if (client) {
      client.participant.access = access;
      const updateMsg: ParticipantUpdatedMessage = {
        type: 'participant_updated',
        participant: client.participant,
      };
      this.broadcast(updateMsg);
      this.emit('participantUpdated', client.participant);
      return true;
    }
    return false;
  }

  public getConnectedParticipants(): Participant[] {
    return Array.from(this.clients.values()).map((c) => c.participant);
  }

  private startHeartbeat(): void {
    this.pingInterval = setInterval(() => {
      for (const [pId, client] of this.clients.entries()) {
        if (!client.isAlive) {
          console.log(`[Togather] Client timed out: ${client.participant.name}`);
          client.ws.terminate();
          this.clients.delete(pId);
          this.broadcast({ type: 'participant_left', participantId: pId });
          this.emit('participantLeft', client.participant);
          continue;
        }
        client.isAlive = false;
        client.ws.ping();
      }
    }, 30000);
  }

  public stop(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    if (this.wss) {
      for (const client of this.clients.values()) {
        try {
          client.ws.close();
        } catch (e) {}
      }
      this.clients.clear();
      this.wss.close();
      this.wss = null;
      console.log('[Togather] LAN Server stopped');
    }
  }
}
