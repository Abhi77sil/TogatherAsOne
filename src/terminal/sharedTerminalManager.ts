import * as vscode from 'vscode';
import * as os from 'os';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { SharedTerminalInfo, AccessLevel } from '../protocol/types';
import {
  TerminalDataMessage,
  TerminalListMessage,
  TerminalResizeMessage,
} from '../protocol/messages';
import { generateId } from '../utils/networkUtils';

export interface TerminalBroadcaster {
  broadcastTerminal(msg: any): void;
  sendTo(participantId: string, msg: any): void;
}

export class SharedTerminalManager {
  private isHost: boolean;
  private broadcaster?: TerminalBroadcaster;
  private hostShellProcesses: Map<
    string,
    {
      process: ChildProcessWithoutNullStreams;
      info: SharedTerminalInfo;
      terminal: vscode.Terminal;
      writeEmitter: vscode.EventEmitter<string>;
    }
  > = new Map();

  private guestTerminals: Map<
    string,
    {
      terminal: vscode.Terminal;
      writeEmitter: vscode.EventEmitter<string>;
    }
  > = new Map();

  private onSendInputToHost?: (terminalId: string, data: string) => void;

  constructor(
    isHost: boolean,
    broadcaster?: TerminalBroadcaster,
    onSendInputToHost?: (terminalId: string, data: string) => void
  ) {
    this.isHost = isHost;
    this.broadcaster = broadcaster;
    this.onSendInputToHost = onSendInputToHost;
  }

  // --- HOST METHODS ---

  public createHostSharedTerminal(name = 'Shared Terminal', access: AccessLevel = 'read-write'): SharedTerminalInfo {
    const terminalId = generateId('term');
    const shell = process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : 'bash');

    const shellProcess = spawn(shell, [], {
      env: { ...process.env, TERM: 'xterm-256color' },
    });

    const writeEmitter = new vscode.EventEmitter<string>();

    const pty: vscode.Pseudoterminal = {
      onDidWrite: writeEmitter.event,
      open: () => {
        writeEmitter.fire(`\r\n=== Togather LAN Shared Terminal (${access}) ===\r\n\r\n`);
      },
      close: () => {
        shellProcess.kill();
      },
      handleInput: (data: string) => {
        shellProcess.stdin.write(data);
      },
    };

    const terminal = vscode.window.createTerminal({
      name: `Togather: ${name}`,
      pty,
    });
    terminal.show();

    // Stream process stdout/stderr
    shellProcess.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      writeEmitter.fire(text);
      this.broadcaster?.broadcastTerminal({
        type: 'terminal_data',
        terminalId,
        data: Buffer.from(text).toString('base64'),
      });
    });

    shellProcess.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      writeEmitter.fire(text);
      this.broadcaster?.broadcastTerminal({
        type: 'terminal_data',
        terminalId,
        data: Buffer.from(text).toString('base64'),
      });
    });

    shellProcess.on('exit', () => {
      writeEmitter.fire('\r\n[Process exited]\r\n');
      this.hostShellProcesses.delete(terminalId);
      this.broadcastTerminalList();
    });

    const info: SharedTerminalInfo = {
      terminalId,
      name,
      access,
    };

    this.hostShellProcesses.set(terminalId, {
      process: shellProcess,
      info,
      terminal,
      writeEmitter,
    });

    this.broadcastTerminalList();
    return info;
  }

  public handleGuestTerminalInput(
    terminalId: string,
    dataBase64: string,
    participantAccess: AccessLevel
  ): void {
    if (participantAccess === 'read-only') return;

    const term = this.hostShellProcesses.get(terminalId);
    if (!term) return;

    if (term.info.access === 'read-only') return;

    const decoded = Buffer.from(dataBase64, 'base64').toString();
    term.process.stdin.write(decoded);
  }

  public getSharedTerminalsList(): SharedTerminalInfo[] {
    return Array.from(this.hostShellProcesses.values()).map((t) => t.info);
  }

  private broadcastTerminalList(): void {
    const listMsg: TerminalListMessage = {
      type: 'terminal_list',
      terminals: this.getSharedTerminalsList(),
    };
    this.broadcaster?.broadcastTerminal(listMsg);
  }

  // --- GUEST METHODS ---

  public handleTerminalList(terminals: SharedTerminalInfo[]): void {
    for (const termInfo of terminals) {
      if (!this.guestTerminals.has(termInfo.terminalId)) {
        this.openGuestTerminal(termInfo);
      }
    }
  }

  public openGuestTerminal(info: SharedTerminalInfo): void {
    if (this.guestTerminals.has(info.terminalId)) {
      this.guestTerminals.get(info.terminalId)!.terminal.show();
      return;
    }

    const writeEmitter = new vscode.EventEmitter<string>();

    const pty: vscode.Pseudoterminal = {
      onDidWrite: writeEmitter.event,
      open: () => {
        writeEmitter.fire(
          `\r\n=== Connected to Host Terminal: ${info.name} [${info.access}] ===\r\n\r\n`
        );
      },
      close: () => {},
      handleInput: (data: string) => {
        if (info.access === 'read-only') {
          writeEmitter.fire('\r\n[Terminal is in Read-Only mode]\r\n');
          return;
        }
        if (this.onSendInputToHost) {
          this.onSendInputToHost(info.terminalId, Buffer.from(data).toString('base64'));
        }
      },
    };

    const terminal = vscode.window.createTerminal({
      name: `Remote: ${info.name}`,
      pty,
    });
    terminal.show();

    this.guestTerminals.set(info.terminalId, {
      terminal,
      writeEmitter,
    });
  }

  public handleTerminalData(terminalId: string, dataBase64: string): void {
    const term = this.guestTerminals.get(terminalId);
    if (term) {
      const text = Buffer.from(dataBase64, 'base64').toString();
      term.writeEmitter.fire(text);
    }
  }

  public dispose(): void {
    for (const term of this.hostShellProcesses.values()) {
      term.process.kill();
      term.terminal.dispose();
    }
    this.hostShellProcesses.clear();

    for (const term of this.guestTerminals.values()) {
      term.terminal.dispose();
    }
    this.guestTerminals.clear();
  }
}
