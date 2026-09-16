import * as vscode from 'vscode';
import * as net from 'net';
import { SharedPortInfo } from '../protocol/types';
import {
  PortListMessage,
  PortTunnelOpenMessage,
  PortTunnelDataMessage,
  PortTunnelCloseMessage,
} from '../protocol/messages';
import { generateId } from '../utils/networkUtils';

export interface PortBroadcaster {
  broadcastPorts(msg: any): void;
  sendTo(participantId: string, msg: any): void;
}

export class PortForwardManager {
  private isHost: boolean;
  private broadcaster?: PortBroadcaster;
  private sharedPorts: Map<string, SharedPortInfo> = new Map();

  // Host: Map<tunnelId, net.Socket connected to localhost:port>
  private hostActiveSockets: Map<string, net.Socket> = new Map();

  // Guest: Map<portId, net.Server listening on localhost>
  private guestLocalServers: Map<string, { server: net.Server; localPort: number }> = new Map();
  // Guest: Map<tunnelId, net.Socket connected from guest browser>
  private guestBrowserSockets: Map<string, net.Socket> = new Map();

  private onSendTunnelMessage?: (msg: any) => void;

  constructor(
    isHost: boolean,
    broadcaster?: PortBroadcaster,
    onSendTunnelMessage?: (msg: any) => void
  ) {
    this.isHost = isHost;
    this.broadcaster = broadcaster;
    this.onSendTunnelMessage = onSendTunnelMessage;
  }

  // --- HOST METHODS ---

  public sharePort(port: number, name = `Service on ${port}`): SharedPortInfo {
    const portId = generateId('port');
    const info: SharedPortInfo = {
      portId,
      port,
      name,
      hostAddress: '127.0.0.1',
    };

    this.sharedPorts.set(portId, info);
    this.broadcastPortList();

    vscode.window.showInformationMessage(`Shared port ${port} (${name}) over LAN.`);
    return info;
  }

  public unsharePort(portId: string): void {
    this.sharedPorts.delete(portId);
    this.broadcastPortList();
  }

  public getSharedPortsList(): SharedPortInfo[] {
    return Array.from(this.sharedPorts.values());
  }

  private broadcastPortList(): void {
    const msg: PortListMessage = {
      type: 'port_list',
      ports: this.getSharedPortsList(),
    };
    this.broadcaster?.broadcastPorts(msg);
  }

  public handleTunnelOpenOnHost(
    tunnelId: string,
    portId: string,
    participantId: string
  ): void {
    const portInfo = this.sharedPorts.get(portId);
    if (!portInfo) return;

    const socket = net.createConnection({
      port: portInfo.port,
      host: '127.0.0.1',
    });

    this.hostActiveSockets.set(tunnelId, socket);

    socket.on('data', (chunk) => {
      const msg: PortTunnelDataMessage = {
        type: 'port_tunnel_data',
        tunnelId,
        data: chunk.toString('base64'),
      };
      this.broadcaster?.sendTo(participantId, msg);
    });

    socket.on('close', () => {
      this.hostActiveSockets.delete(tunnelId);
      const closeMsg: PortTunnelCloseMessage = {
        type: 'port_tunnel_close',
        tunnelId,
      };
      this.broadcaster?.sendTo(participantId, closeMsg);
    });

    socket.on('error', (err) => {
      console.error(`[Togather] Error in host port tunnel ${tunnelId}:`, err);
    });
  }

  public handleTunnelDataOnHost(tunnelId: string, dataBase64: string): void {
    const socket = this.hostActiveSockets.get(tunnelId);
    if (socket && !socket.destroyed) {
      socket.write(Buffer.from(dataBase64, 'base64'));
    }
  }

  public handleTunnelCloseOnHost(tunnelId: string): void {
    const socket = this.hostActiveSockets.get(tunnelId);
    if (socket) {
      socket.end();
      this.hostActiveSockets.delete(tunnelId);
    }
  }

  // --- GUEST METHODS ---

  public handlePortList(ports: SharedPortInfo[]): void {
    for (const p of ports) {
      if (!this.guestLocalServers.has(p.portId)) {
        this.startGuestProxyServer(p);
      }
    }
  }

  private startGuestProxyServer(portInfo: SharedPortInfo): void {
    const server = net.createServer((browserSocket) => {
      const tunnelId = generateId('tun');
      this.guestBrowserSockets.set(tunnelId, browserSocket);

      // Open tunnel on host
      const openMsg: PortTunnelOpenMessage = {
        type: 'port_tunnel_open',
        tunnelId,
        portId: portInfo.portId,
      };
      this.onSendTunnelMessage?.(openMsg);

      browserSocket.on('data', (chunk) => {
        const dataMsg: PortTunnelDataMessage = {
          type: 'port_tunnel_data',
          tunnelId,
          data: chunk.toString('base64'),
        };
        this.onSendTunnelMessage?.(dataMsg);
      });

      browserSocket.on('close', () => {
        this.guestBrowserSockets.delete(tunnelId);
        const closeMsg: PortTunnelCloseMessage = {
          type: 'port_tunnel_close',
          tunnelId,
        };
        this.onSendTunnelMessage?.(closeMsg);
      });

      browserSocket.on('error', (err) => {
        console.error(`[Togather] Guest tunnel socket error:`, err);
      });
    });

    // Try listening on the same port, or let OS choose random available port
    server.listen(portInfo.port, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      const localPort = addr.port;
      this.guestLocalServers.set(portInfo.portId, { server, localPort });

      vscode.window
        .showInformationMessage(
          `Port ${portInfo.port} (${portInfo.name}) forwarded to http://localhost:${localPort}`,
          'Open Browser'
        )
        .then((selection) => {
          if (selection === 'Open Browser') {
            vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${localPort}`));
          }
        });
    });

    server.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        // Fallback to random free port
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address() as net.AddressInfo;
          const localPort = addr.port;
          this.guestLocalServers.set(portInfo.portId, { server, localPort });
          vscode.window.showInformationMessage(
            `Port ${portInfo.port} forwarded to http://localhost:${localPort} (fallback)`
          );
        });
      }
    });
  }

  public handleTunnelDataOnGuest(tunnelId: string, dataBase64: string): void {
    const socket = this.guestBrowserSockets.get(tunnelId);
    if (socket && !socket.destroyed) {
      socket.write(Buffer.from(dataBase64, 'base64'));
    }
  }

  public handleTunnelCloseOnGuest(tunnelId: string): void {
    const socket = this.guestBrowserSockets.get(tunnelId);
    if (socket) {
      socket.end();
      this.guestBrowserSockets.delete(tunnelId);
    }
  }

  public dispose(): void {
    for (const socket of this.hostActiveSockets.values()) {
      socket.destroy();
    }
    this.hostActiveSockets.clear();

    for (const { server } of this.guestLocalServers.values()) {
      server.close();
    }
    this.guestLocalServers.clear();

    for (const socket of this.guestBrowserSockets.values()) {
      socket.destroy();
    }
    this.guestBrowserSockets.clear();
  }
}
