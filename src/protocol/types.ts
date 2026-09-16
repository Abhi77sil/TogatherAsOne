export type ParticipantRole = 'host' | 'guest';
export type AccessLevel = 'read-write' | 'read-only';

export interface Participant {
  id: string;
  name: string;
  role: ParticipantRole;
  access: AccessLevel;
  color: string;
  ip?: string;
  activeFile?: string;
  cursor?: {
    line: number;
    character: number;
  };
}

export interface SessionInfo {
  sessionId: string;
  hostName: string;
  workspaceName: string;
  hostIp: string;
  port: number;
  requirePin: boolean;
  pin?: string;
  createdAt: number;
}

export interface DiscoveredSession {
  sessionId: string;
  hostName: string;
  workspaceName: string;
  hostIp: string;
  port: number;
  requirePin: boolean;
  lastSeen: number;
}

export interface FileTreeNode {
  name: string;
  path: string; // relative to workspace root (e.g. "src/index.ts")
  isDirectory: boolean;
  size?: number;
  mtime?: number;
  children?: FileTreeNode[];
}

export interface SharedTerminalInfo {
  terminalId: string;
  name: string;
  access: AccessLevel;
}

export interface SharedPortInfo {
  portId: string;
  port: number;
  name: string;
  hostAddress: string; // e.g. "localhost" or "127.0.0.1"
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  senderColor: string;
  timestamp: number;
  text: string;
  codeSnippet?: {
    filePath: string;
    lineStart: number;
    lineEnd: number;
    code: string;
  };
}

export interface ActivityLogEntry {
  id: string;
  timestamp: number;
  authorId: string;
  authorName: string;
  authorColor: string;
  filePath: string;
  changeType: 'text_edit' | 'file_created' | 'file_deleted';
  summary: string;
  startLine: number;
  endLine: number;
  addedLinesCount: number;
  removedLinesCount: number;
  addedText: string;
  removedText: string;
  snapshotBefore: string;
  snapshotAfter: string;
  reverted: boolean;
  revertedAt?: number;
  revertedBy?: string;
}
