import {
  Participant,
  SessionInfo,
  FileTreeNode,
  SharedTerminalInfo,
  SharedPortInfo,
  ChatMessage,
  AccessLevel,
  ActivityLogEntry,
} from './types';

export type MessageType =
  // Handshake & Auth
  | 'join_request'
  | 'join_response'
  | 'join_approval_prompt'
  | 'participant_joined'
  | 'participant_left'
  | 'participant_updated'
  | 'kick_participant'
  // File System
  | 'file_tree_request'
  | 'file_tree_response'
  | 'read_file_request'
  | 'read_file_response'
  | 'write_file_request'
  | 'write_file_response'
  | 'delete_file_request'
  | 'delete_file_response'
  | 'create_dir_request'
  | 'create_dir_response'
  | 'file_changed_event'
  // Collaborative Editing (Yjs CRDT)
  | 'doc_open'
  | 'doc_close'
  | 'doc_sync_step1'
  | 'doc_sync_step2'
  | 'doc_update'
  // Presence & Cursors
  | 'cursor_update'
  | 'active_file_update'
  // Shared Terminals
  | 'terminal_list'
  | 'terminal_create'
  | 'terminal_close'
  | 'terminal_data'
  | 'terminal_resize'
  // Shared Ports
  | 'port_list'
  | 'port_tunnel_open'
  | 'port_tunnel_data'
  | 'port_tunnel_close'
  // Chat
  | 'chat_send'
  | 'chat_broadcast'
  // Activity Log
  | 'activity_log_entry'
  | 'activity_log_sync';

export interface BaseMessage {
  type: MessageType;
  id?: string;
  requestId?: string; // For req/res correlation
  senderId?: string;
}

// Handshake
export interface JoinRequestMessage extends BaseMessage {
  type: 'join_request';
  name: string;
  pin?: string;
  clientVersion: string;
}

export interface JoinApprovalPromptMessage extends BaseMessage {
  type: 'join_approval_prompt';
  message?: string;
}

export interface JoinResponseMessage extends BaseMessage {
  type: 'join_response';
  success: boolean;
  error?: string;
  participant?: Participant;
  session?: SessionInfo;
  participants?: Participant[];
  sharedTerminals?: SharedTerminalInfo[];
  sharedPorts?: SharedPortInfo[];
}

export interface ParticipantJoinedMessage extends BaseMessage {
  type: 'participant_joined';
  participant: Participant;
}

export interface ParticipantLeftMessage extends BaseMessage {
  type: 'participant_left';
  participantId: string;
}

export interface ParticipantUpdatedMessage extends BaseMessage {
  type: 'participant_updated';
  participant: Participant;
}

export interface KickParticipantMessage extends BaseMessage {
  type: 'kick_participant';
  participantId: string;
  reason?: string;
}

// File System
export interface FileTreeRequestMessage extends BaseMessage {
  type: 'file_tree_request';
}

export interface FileTreeResponseMessage extends BaseMessage {
  type: 'file_tree_response';
  tree: FileTreeNode[];
}

export interface ReadFileRequestMessage extends BaseMessage {
  type: 'read_file_request';
  path: string;
}

export interface ReadFileResponseMessage extends BaseMessage {
  type: 'read_file_response';
  path: string;
  content?: string; // base64 encoded
  error?: string;
}

export interface WriteFileRequestMessage extends BaseMessage {
  type: 'write_file_request';
  path: string;
  content: string; // base64 encoded
}

export interface WriteFileResponseMessage extends BaseMessage {
  type: 'write_file_response';
  path: string;
  success: boolean;
  error?: string;
}

export interface DeleteFileRequestMessage extends BaseMessage {
  type: 'delete_file_request';
  path: string;
  recursive?: boolean;
}

export interface DeleteFileResponseMessage extends BaseMessage {
  type: 'delete_file_response';
  path: string;
  success: boolean;
  error?: string;
}

export interface CreateDirRequestMessage extends BaseMessage {
  type: 'create_dir_request';
  path: string;
}

export interface CreateDirResponseMessage extends BaseMessage {
  type: 'create_dir_response';
  path: string;
  success: boolean;
  error?: string;
}

export interface FileChangedEventMessage extends BaseMessage {
  type: 'file_changed_event';
  changeType: 'created' | 'changed' | 'deleted';
  path: string;
}

// Collaborative Editing (Yjs CRDT)
export interface DocOpenMessage extends BaseMessage {
  type: 'doc_open';
  filePath: string;
}

export interface DocCloseMessage extends BaseMessage {
  type: 'doc_close';
  filePath: string;
}

export interface DocSyncStep1Message extends BaseMessage {
  type: 'doc_sync_step1';
  filePath: string;
  vector: string; // Base64 encoded Uint8Array
}

export interface DocSyncStep2Message extends BaseMessage {
  type: 'doc_sync_step2';
  filePath: string;
  update: string; // Base64 encoded Uint8Array
}

export interface DocUpdateMessage extends BaseMessage {
  type: 'doc_update';
  filePath: string;
  update: string; // Base64 encoded Uint8Array
}

// Presence & Cursors
export interface CursorPosition {
  line: number;
  character: number;
}

export interface SelectionRange {
  anchor: CursorPosition;
  active: CursorPosition;
}

export interface CursorUpdateMessage extends BaseMessage {
  type: 'cursor_update';
  filePath: string;
  cursor: CursorPosition;
  selection?: SelectionRange;
}

export interface ActiveFileUpdateMessage extends BaseMessage {
  type: 'active_file_update';
  filePath: string;
}

// Shared Terminals
export interface TerminalListMessage extends BaseMessage {
  type: 'terminal_list';
  terminals: SharedTerminalInfo[];
}

export interface TerminalDataMessage extends BaseMessage {
  type: 'terminal_data';
  terminalId: string;
  data: string; // base64 or raw string
}

export interface TerminalResizeMessage extends BaseMessage {
  type: 'terminal_resize';
  terminalId: string;
  cols: number;
  rows: number;
}

export interface TerminalCloseMessage extends BaseMessage {
  type: 'terminal_close';
  terminalId: string;
}

// Shared Ports
export interface PortListMessage extends BaseMessage {
  type: 'port_list';
  ports: SharedPortInfo[];
}

export interface PortTunnelOpenMessage extends BaseMessage {
  type: 'port_tunnel_open';
  tunnelId: string;
  portId: string;
}

export interface PortTunnelDataMessage extends BaseMessage {
  type: 'port_tunnel_data';
  tunnelId: string;
  data: string; // base64 encoded bytes
}

export interface PortTunnelCloseMessage extends BaseMessage {
  type: 'port_tunnel_close';
  tunnelId: string;
}

// Chat
export interface ChatSendMessage extends BaseMessage {
  type: 'chat_send';
  text: string;
  codeSnippet?: ChatMessage['codeSnippet'];
}

export interface ChatBroadcastMessage extends BaseMessage {
  type: 'chat_broadcast';
  message: ChatMessage;
}

// Activity Log
export interface ActivityLogEntryMessage extends BaseMessage {
  type: 'activity_log_entry';
  entry: ActivityLogEntry;
}

export interface ActivityLogSyncMessage extends BaseMessage {
  type: 'activity_log_sync';
  entries: ActivityLogEntry[];
}

export type TogatherMessage =
  | JoinRequestMessage
  | JoinResponseMessage
  | JoinApprovalPromptMessage
  | ParticipantJoinedMessage
  | ParticipantLeftMessage
  | ParticipantUpdatedMessage
  | KickParticipantMessage
  | FileTreeRequestMessage
  | FileTreeResponseMessage
  | ReadFileRequestMessage
  | ReadFileResponseMessage
  | WriteFileRequestMessage
  | WriteFileResponseMessage
  | DeleteFileRequestMessage
  | DeleteFileResponseMessage
  | CreateDirRequestMessage
  | CreateDirResponseMessage
  | FileChangedEventMessage
  | DocOpenMessage
  | DocCloseMessage
  | DocSyncStep1Message
  | DocSyncStep2Message
  | DocUpdateMessage
  | CursorUpdateMessage
  | ActiveFileUpdateMessage
  | TerminalListMessage
  | TerminalDataMessage
  | TerminalResizeMessage
  | TerminalCloseMessage
  | PortListMessage
  | PortTunnelOpenMessage
  | PortTunnelDataMessage
  | PortTunnelCloseMessage
  | ChatSendMessage
  | ChatBroadcastMessage
  | ActivityLogEntryMessage
  | ActivityLogSyncMessage;
