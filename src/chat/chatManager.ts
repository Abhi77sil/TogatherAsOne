import { EventEmitter } from 'events';
import { ChatMessage } from '../protocol/types';
import { ChatSendMessage, ChatBroadcastMessage } from '../protocol/messages';
import { generateId } from '../utils/networkUtils';

export interface ChatBroadcaster {
  broadcastChat(msg: ChatBroadcastMessage): void;
  sendChatToHost(msg: ChatSendMessage): void;
  isHost(): boolean;
}

export class ChatManager extends EventEmitter {
  private messages: ChatMessage[] = [];
  private broadcaster: ChatBroadcaster;

  constructor(broadcaster: ChatBroadcaster) {
    super();
    this.broadcaster = broadcaster;
  }

  public sendMessage(
    senderId: string,
    senderName: string,
    senderColor: string,
    text: string,
    codeSnippet?: ChatMessage['codeSnippet']
  ): void {
    const chatMsg: ChatMessage = {
      id: generateId('chat'),
      senderId,
      senderName,
      senderColor,
      timestamp: Date.now(),
      text,
      codeSnippet,
    };

    if (this.broadcaster.isHost()) {
      this.messages.push(chatMsg);
      this.emit('messageReceived', chatMsg);
      this.broadcaster.broadcastChat({
        type: 'chat_broadcast',
        message: chatMsg,
      });
    } else {
      this.broadcaster.sendChatToHost({
        type: 'chat_send',
        text,
        codeSnippet,
      });
    }
  }

  public handleIncomingMessage(chatMsg: ChatMessage): void {
    this.messages.push(chatMsg);
    this.emit('messageReceived', chatMsg);
  }

  public getMessages(): ChatMessage[] {
    return this.messages;
  }

  public clear(): void {
    this.messages = [];
  }
}
