import { WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { Participant, SessionInfo } from '../protocol/types';
import {
  TogatherMessage,
  JoinRequestMessage,
  JoinResponseMessage,
  BaseMessage,
} from '../protocol/messages';
import { generateId } from '../utils/networkUtils';

export class LANClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private pendingRequests: Map<
    string,
    {
      resolve: (data: any) => void;
      reject: (err: any) => void;
      timeout: NodeJS.Timeout;
    }
  > = new Map();

  public currentParticipant: Participant | null = null;
  public sessionInfo: SessionInfo | null = null;
  public participants: Map<string, Participant> = new Map();
  private isConnected = false;

  constructor() {
    super();
  }

  public async connect(
    hostIp: string,
    port: number,
    name: string,
    pin?: string
  ): Promise<JoinResponseMessage> {
    return new Promise((resolve, reject) => {
      try {
        const normalizedHost =
          hostIp.includes(':') && !hostIp.startsWith('[') ? `[${hostIp}]` : hostIp;
        const url = `ws://${normalizedHost}:${port}`;
        console.log(`[Togather] Connecting to LAN Host at ${url}...`);

        this.ws = new WebSocket(url);

        const connectionTimeout = setTimeout(() => {
          if (!this.isConnected) {
            this.disconnect();
            reject(
              new Error(
                `Connection to ${url} timed out. Ensure both laptops are on the same Wi-Fi/LAN and the host's firewall allows port ${port} (e.g., 'sudo ufw allow ${port}/tcp').`
              )
            );
          }
        }, 30000);

        this.ws.on('ping', () => {
          try {
            this.ws?.pong();
          } catch (e) {}
        });

        this.ws.on('open', () => {
          console.log('[Togather] WebSocket connected, sending Join Request...');
          this.startClientHeartbeat();
          const joinReq: JoinRequestMessage = {
            type: 'join_request',
            name,
            pin,
            clientVersion: '0.1.0',
          };
          this.send(joinReq);
        });

        this.ws.on('message', (data: Buffer | string) => {
          try {
            const msg: TogatherMessage = JSON.parse(data.toString());

            if (msg.type === 'join_approval_prompt') {
              this.emit('waitingForApproval', (msg as any).message || 'Waiting for host approval...');
              return;
            }

            if (msg.type === 'join_response') {
              clearTimeout(connectionTimeout);
              const joinRes = msg as JoinResponseMessage;
              if (joinRes.success && joinRes.participant && joinRes.session) {
                this.isConnected = true;
                this.currentParticipant = joinRes.participant;
                this.sessionInfo = joinRes.session;

                this.participants.clear();
                if (joinRes.participants) {
                  for (const p of joinRes.participants) {
                    this.participants.set(p.id, p);
                  }
                }

                this.emit('connected', joinRes);
                resolve(joinRes);
              } else {
                this.disconnect();
                reject(new Error(joinRes.error || 'Join request rejected by host.'));
              }
              return;
            }

            this.handleMessage(msg);
          } catch (err) {
            console.error('[Togather] Error processing message on client:', err);
          }
        });

        this.ws.on('close', () => {
          this.isConnected = false;
          this.emit('disconnected');
          this.cleanupPendingRequests('Connection closed');
        });

        this.ws.on('error', (err) => {
          clearTimeout(connectionTimeout);
          this.emit('error', err);
          if (!this.isConnected) {
            reject(err);
          }
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  private handleMessage(msg: TogatherMessage): void {
    // If correlated request response
    if (msg.requestId && this.pendingRequests.has(msg.requestId)) {
      const pending = this.pendingRequests.get(msg.requestId)!;
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(msg.requestId);
      pending.resolve(msg);
      return;
    }

    switch (msg.type) {
      case 'participant_joined':
        this.participants.set(msg.participant.id, msg.participant);
        this.emit('participantJoined', msg.participant);
        break;

      case 'participant_left':
        this.participants.delete(msg.participantId);
        this.emit('participantLeft', msg.participantId);
        break;

      case 'participant_updated':
        this.participants.set(msg.participant.id, msg.participant);
        if (this.currentParticipant && this.currentParticipant.id === msg.participant.id) {
          this.currentParticipant = msg.participant;
        }
        this.emit('participantUpdated', msg.participant);
        break;

      case 'kick_participant':
        this.emit('kicked', msg.reason);
        this.currentParticipant = null;
        this.disconnect();
        break;

      default:
        this.emit(msg.type, msg);
        break;
    }
  }

  public send(msg: TogatherMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  public async sendRequest<T extends TogatherMessage>(
    msg: TogatherMessage,
    timeoutMs = 15000
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('WebSocket is not connected'));
      }

      const requestId = generateId('req');
      msg.requestId = requestId;

      const timeout = setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
          reject(new Error(`Request timed out after ${timeoutMs}ms: ${msg.type}`));
        }
      }, timeoutMs);

      this.pendingRequests.set(requestId, {
        resolve: (data) => resolve(data as T),
        reject,
        timeout,
      });

      this.ws.send(JSON.stringify(msg));
    });
  }

  private cleanupPendingRequests(reason: string): void {
    for (const [, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }

  private heartbeatInterval: NodeJS.Timeout | null = null;
  public latency = 1;

  private lastPingTime = 0;
  private missedPings = 0;

  private startClientHeartbeat(): void {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.missedPings = 0;
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        if (this.missedPings >= 3) {
          console.warn('[Togather] Host heartbeat timed out, disconnecting...');
          this.disconnect();
          this.emit('disconnected');
          return;
        }
        this.missedPings++;
        this.lastPingTime = Date.now();
        try {
          this.ws.ping();
        } catch (e) {}
      }
    }, 10000);

    this.ws?.on('pong', () => {
      this.missedPings = 0;
      if (this.lastPingTime > 0) {
        this.latency = Math.max(1, Date.now() - this.lastPingTime);
        this.emit('latencyChanged', this.latency);
      }
    });
  }

  public disconnect(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch (e) {}
      this.ws = null;
    }
    this.isConnected = false;
    this.currentParticipant = null;
    this.sessionInfo = null;
    this.participants.clear();
    this.cleanupPendingRequests('Disconnected');
  }
}
