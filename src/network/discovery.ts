import Bonjour, { Service } from 'bonjour-service';
import { DiscoveredSession, SessionInfo } from '../protocol/types';
import { EventEmitter } from 'events';

export class LANDiscoveryService extends EventEmitter {
  private bonjour: Bonjour | null = null;
  private publishedService: Service | null = null;
  private browser: any = null;
  private discoveredSessions: Map<string, DiscoveredSession> = new Map();
  private isScanning = false;

  constructor() {
    super();
  }

  private initBonjour(): Bonjour | null {
    if (!this.bonjour) {
      try {
        this.bonjour = new Bonjour();
      } catch (err) {
        console.error('[Togather] Failed to initialize Bonjour mDNS service:', err);
        return null;
      }
    }
    return this.bonjour;
  }

  /**
   * Broadcast this machine as a Togather Host on the local network via mDNS.
   */
  public advertise(session: SessionInfo): void {
    const instance = this.initBonjour();
    if (!instance) return;

    this.stopAdvertising();

    try {
      this.publishedService = instance.publish({
        name: `Togather-${session.hostName}-${session.sessionId.substring(0, 6)}`,
        type: 'togather',
        port: session.port,
        disableIPv6: true,
        txt: {
          sessionId: session.sessionId,
          hostName: session.hostName,
          workspaceName: session.workspaceName,
          hostIp: session.hostIp,
          port: session.port.toString(),
          requirePin: session.requirePin ? '1' : '0',
        },
      });

      console.log(`[Togather] Broadcasting session on LAN via mDNS: ${session.workspaceName}`);
    } catch (err) {
      console.error('[Togather] Error publishing mDNS service:', err);
    }
  }

  public stopAdvertising(): void {
    if (this.publishedService) {
      try {
        this.publishedService.stop();
      } catch (err) {
        console.error('[Togather] Error stopping published mDNS service:', err);
      }
      this.publishedService = null;
    }
  }

  /**
   * Start actively scanning for Togather hosts on the local network.
   */
  public startScanning(): void {
    if (this.isScanning) return;
    const instance = this.initBonjour();
    if (!instance) return;

    this.isScanning = true;
    this.discoveredSessions.clear();

    try {
      this.browser = instance.find({ type: 'togather' }, (service: any) => {
        this.handleDiscoveredService(service);
      });

      console.log('[Togather] Started LAN scanning for collaborative sessions.');
    } catch (err) {
      console.error('[Togather] Failed to start mDNS browser:', err);
      this.isScanning = false;
    }
  }

  private handleDiscoveredService(service: any): void {
    try {
      const txt = service.txt || {};

      const decodeVal = (val: any): string => {
        if (!val) return '';
        if (Buffer.isBuffer(val)) return val.toString('utf8').trim();
        return String(val).trim();
      };

      const sessionId = decodeVal(txt.sessionId) || service.name;
      const rawTxtIp = decodeVal(txt.hostIp);
      const rawPort = decodeVal(txt.port);
      const port = parseInt(rawPort, 10) || service.port;
      const hostName = decodeVal(txt.hostName) || service.name;
      const workspaceName = decodeVal(txt.workspaceName) || 'Shared Workspace';
      const requirePin = decodeVal(txt.requirePin) === '1';

      // Robust IP resolution: prioritize explicit IPv4, then sender referer address, then address list
      let hostIp = rawTxtIp;
      if (!hostIp) {
        if (service.referer?.family === 'IPv4' && service.referer.address) {
          hostIp = service.referer.address;
        } else if (Array.isArray(service.addresses)) {
          // Find first valid IPv4 address (e.g. 192.168.x.x, 10.x.x.x)
          const ipv4 = service.addresses.find(
            (addr: string) => addr && addr.includes('.') && !addr.includes(':') && !addr.startsWith('127.')
          );
          if (ipv4) {
            hostIp = ipv4;
          } else if (service.addresses.length > 0) {
            const first = service.addresses[0];
            hostIp = first.includes(':') && !first.startsWith('[') ? `[${first}]` : first;
          }
        } else if (service.host) {
          hostIp = service.host;
        }
      }

      if (!hostIp || !port) return;

      const discovered: DiscoveredSession = {
        sessionId,
        hostName,
        workspaceName,
        hostIp,
        port,
        requirePin,
        lastSeen: Date.now(),
      };

      this.discoveredSessions.set(sessionId, discovered);
      this.emit('sessionDiscovered', discovered);
      this.emit('sessionsChanged', Array.from(this.discoveredSessions.values()));
    } catch (err) {
      console.error('[Togather] Error parsing discovered service:', err);
    }
  }

  public stopScanning(): void {
    if (this.browser) {
      try {
        this.browser.stop();
      } catch (err) {
        console.error('[Togather] Error stopping mDNS browser:', err);
      }
      this.browser = null;
    }
    this.isScanning = false;
  }

  public getDiscoveredSessions(): DiscoveredSession[] {
    // Purge sessions older than 60 seconds
    const now = Date.now();
    for (const [id, session] of this.discoveredSessions.entries()) {
      if (now - session.lastSeen > 60000) {
        this.discoveredSessions.delete(id);
      }
    }
    return Array.from(this.discoveredSessions.values());
  }

  public destroy(): void {
    this.stopAdvertising();
    this.stopScanning();
    if (this.bonjour) {
      try {
        this.bonjour.destroy();
      } catch (err) {
        console.error('[Togather] Error destroying bonjour instance:', err);
      }
      this.bonjour = null;
    }
  }
}
