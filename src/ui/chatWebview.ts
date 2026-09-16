import * as vscode from 'vscode';
import { ChatManager } from '../chat/chatManager';
import { Participant } from '../protocol/types';

export class ChatWebviewPanel {
  public static currentPanel: ChatWebviewPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _chatManager: ChatManager;
  private _currentUser: Participant;
  private _disposables: vscode.Disposable[] = [];

  public static createOrShow(
    extensionUri: vscode.Uri,
    chatManager: ChatManager,
    currentUser: Participant
  ): ChatWebviewPanel {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (ChatWebviewPanel.currentPanel) {
      ChatWebviewPanel.currentPanel._panel.reveal(column);
      return ChatWebviewPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      'togatherChat',
      'Togather LAN Chat',
      column || vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    ChatWebviewPanel.currentPanel = new ChatWebviewPanel(
      panel,
      extensionUri,
      chatManager,
      currentUser
    );
    return ChatWebviewPanel.currentPanel;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    chatManager: ChatManager,
    currentUser: Participant
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._chatManager = chatManager;
    this._currentUser = currentUser;

    this._panel.webview.html = this._getHtmlForWebview();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Handle messages from the webview
    this._panel.webview.onDidReceiveMessage(
      (message) => {
        switch (message.command) {
          case 'sendMessage':
            this._chatManager.sendMessage(
              this._currentUser.id,
              this._currentUser.name,
              this._currentUser.color,
              message.text
            );
            return;
          case 'sendSnippet': {
            const editor = vscode.window.activeTextEditor;
            if (editor && !editor.selection.isEmpty) {
              const text = editor.document.getText(editor.selection);
              const filePath = editor.document.uri.path;
              this._chatManager.sendMessage(
                this._currentUser.id,
                this._currentUser.name,
                this._currentUser.color,
                message.text || 'Shared code snippet:',
                {
                  filePath,
                  lineStart: editor.selection.start.line + 1,
                  lineEnd: editor.selection.end.line + 1,
                  code: text,
                }
              );
            }
            return;
          }
        }
      },
      null,
      this._disposables
    );

    // Forward incoming chat messages to the webview
    const messageHandler = (chatMsg: any) => {
      this._panel.webview.postMessage({ command: 'newMessage', message: chatMsg });
    };

    this._chatManager.on('messageReceived', messageHandler);
    this._disposables.push({
      dispose: () => {
        this._chatManager.removeListener('messageReceived', messageHandler);
      },
    });

    // Send existing messages
    const existing = this._chatManager.getMessages();
    for (const msg of existing) {
      this._panel.webview.postMessage({ command: 'newMessage', message: msg });
    }
  }

  public dispose(): void {
    ChatWebviewPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }

  private _getHtmlForWebview(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Togather LAN Chat</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --border: var(--vscode-panel-border, #333);
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
      --btn-bg: var(--vscode-button-background);
      --btn-fg: var(--vscode-button-foreground);
      --badge-bg: var(--vscode-badge-background);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--fg);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }
    .header {
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: rgba(255, 255, 255, 0.02);
    }
    .header h2 {
      font-size: 14px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .lan-badge {
      background: #10b98122;
      color: #10b981;
      border: 1px solid #10b98144;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .messages-container {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .message-item {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-width: 85%;
    }
    .message-item.own {
      align-self: flex-end;
    }
    .message-header {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      opacity: 0.8;
    }
    .avatar-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }
    .author-name {
      font-weight: 600;
    }
    .bubble {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.08);
      padding: 8px 12px;
      border-radius: 8px;
      font-size: 13px;
      line-height: 1.4;
      word-break: break-word;
    }
    .message-item.own .bubble {
      background: var(--btn-bg);
      color: var(--btn-fg);
      border-color: transparent;
    }
    .snippet-box {
      margin-top: 6px;
      background: rgba(0, 0, 0, 0.3);
      border-radius: 6px;
      border: 1px solid var(--border);
      overflow: hidden;
      font-family: monospace;
      font-size: 11px;
    }
    .snippet-header {
      background: rgba(255, 255, 255, 0.05);
      padding: 6px 10px;
      font-size: 11px;
      opacity: 0.85;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--border);
    }
    .snippet-copy-btn {
      background: transparent;
      border: 1px solid rgba(255, 255, 255, 0.15);
      color: var(--fg);
      border-radius: 4px;
      padding: 2px 6px;
      font-size: 10px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 3px;
    }
    .snippet-copy-btn:hover {
      background: rgba(255, 255, 255, 0.1);
    }
    .snippet-body {
      padding: 8px 10px;
      white-space: pre-wrap;
      overflow-x: auto;
      line-height: 1.4;
    }
    .input-area {
      padding: 12px 16px;
      border-top: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      gap: 8px;
      background: rgba(255, 255, 255, 0.02);
    }
    .input-row {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    input[type="text"] {
      flex: 1;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--border);
      padding: 9px 14px;
      border-radius: 8px;
      font-size: 13px;
      outline: none;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    input[type="text"]:focus {
      border-color: #4285F4;
      box-shadow: 0 0 0 1px #4285F4;
    }
    button {
      background: #4285F4;
      color: #ffffff;
      border: none;
      padding: 9px 16px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.2s ease;
    }
    button:hover {
      background: #3367D6;
      box-shadow: 0 2px 6px rgba(66, 133, 244, 0.3);
    }
    button.secondary {
      background: rgba(255, 255, 255, 0.08);
      color: var(--fg);
      border: 1px solid rgba(255, 255, 255, 0.1);
    }
    button.secondary:hover {
      background: rgba(255, 255, 255, 0.14);
      box-shadow: none;
    }
    .material-symbols-outlined {
      font-family: 'Material Symbols Outlined';
      font-weight: normal;
      font-style: normal;
      font-size: 18px;
      line-height: 1;
      letter-spacing: normal;
      text-transform: none;
      display: inline-block;
      white-space: nowrap;
      word-wrap: normal;
      direction: ltr;
      vertical-align: middle;
    }
  </style>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" />
</head>
<body>
  <div class="header">
    <h2>
      <span class="material-symbols-outlined" style="color: #4285F4; font-size: 20px;">forum</span>
      Togather Room
      <span class="lan-badge">
        <span class="material-symbols-outlined" style="font-size: 12px;">wifi</span>
        LAN Active
      </span>
    </h2>
    <button class="secondary" id="shareSnippetBtn">
      <span class="material-symbols-outlined" style="font-size: 16px;">code</span>
      Share Selection
    </button>
  </div>

  <div class="messages-container" id="messages"></div>

  <div class="input-area">
    <div class="input-row">
      <input type="text" id="chatInput" placeholder="Type a collaborative message..." />
      <button id="sendBtn">
        <span>Send</span>
        <span class="material-symbols-outlined" style="font-size: 16px;">send</span>
      </button>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const messagesContainer = document.getElementById('messages');
    const chatInput = document.getElementById('chatInput');
    const sendBtn = document.getElementById('sendBtn');
    const shareSnippetBtn = document.getElementById('shareSnippetBtn');

    function appendMessage(msg) {
      const isOwn = msg.senderId === '${this._currentUser.id}';
      const item = document.createElement('div');
      item.className = 'message-item' + (isOwn ? ' own' : '');

      const timeStr = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const snippetId = 'snip_' + Math.random().toString(36).substring(2, 9);

      let snippetHtml = '';
      if (msg.codeSnippet) {
        snippetHtml = \`
          <div class="snippet-box">
            <div class="snippet-header">
              <span>\${escapeHtml(msg.codeSnippet.filePath)} (L\${msg.codeSnippet.lineStart}-\${msg.codeSnippet.lineEnd})</span>
              <button class="snippet-copy-btn" onclick="copySnippet('\${snippetId}')">
                <span class="material-symbols-outlined" style="font-size: 13px;">content_copy</span>
                Copy
              </button>
            </div>
            <div class="snippet-body" id="\${snippetId}">\${escapeHtml(msg.codeSnippet.code)}</div>
          </div>
        \`;
      }

      item.innerHTML = \`
        <div class="message-header">
          <span class="avatar-dot" style="background: \${msg.senderColor}"></span>
          <span class="author-name">\${escapeHtml(msg.senderName)}</span>
          <span>\${timeStr}</span>
        </div>
        <div class="bubble">
          \${escapeHtml(msg.text)}
          \${snippetHtml}
        </div>
      \`;

      messagesContainer.appendChild(item);
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    function copySnippet(id) {
      const el = document.getElementById(id);
      if (!el) return;
      navigator.clipboard.writeText(el.innerText).then(() => {
        // Temporary feedback toast
      });
    }

    function escapeHtml(unsafe) {
      return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    sendBtn.addEventListener('click', () => {
      const text = chatInput.value.trim();
      if (!text) return;
      vscode.postMessage({ command: 'sendMessage', text });
      chatInput.value = '';
    });

    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendBtn.click();
      }
    });

    shareSnippetBtn.addEventListener('click', () => {
      const text = chatInput.value.trim();
      vscode.postMessage({ command: 'sendSnippet', text });
      chatInput.value = '';
    });

    window.addEventListener('message', (event) => {
      const data = event.data;
      if (data.command === 'newMessage') {
        appendMessage(data.message);
      }
    });
  </script>
</body>
</html>`;
  }
}
