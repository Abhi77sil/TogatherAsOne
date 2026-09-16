# TogatherAsOne (LAN Live Share for VS Code)

> **All the features of Visual Studio Live Share, built strictly for your Local Area Network (LAN) — 100% offline, zero cloud servers, zero account sign-ins, and zero telemetry.**

---

## Highlights

- **Zero Cloud & Air-Gapped**: Works seamlessly on private Wi-Fi, Ethernet, ad-hoc hotspot, airplanes, high-security enterprise intranets, or air-gapped networks.
- **LAN Auto-Discovery (mDNS / Bonjour)**: Automatically detects colleagues hosting sessions on your local subnet without having to manually lookup IP addresses.
- **Direct LAN Connection**: Connect via `IP:PORT` with an optional 4-digit PIN for access control and host approval prompts.
- **Virtual Remote File System**: Guests do **not** need git repo access or files cloned locally. The remote workspace is streamed on-demand into VS Code using a custom `togather://` FileSystemProvider.
- **Real-Time CRDT Collaborative Editing**: Powered by `Yjs` for conflict-free, concurrent keystroke synchronization with mathematical convergence.
- **Collaborator Cursors & Presence**:
  - Live cursor tracking with distinct participant colors.
  - Live selection highlight boxes.
  - Name badges displaying who is working where.
- **Follow Mode**:
  - Automatically track a colleague's viewport and jump to their active file and cursor position in real time.
- **Shared Terminals**:
  - Stream host terminal sessions (bash, zsh, powershell).
  - Configurable permissions: **Read-Only** (watch commands/tests) or **Read-Write** (interactive pair-terminal).
- **Shared Local Ports (Port Forwarding)**:
  - Forward localhost servers (e.g. Vite on `:5173`, Express on `:3000`, Flask on `:5000`) across the LAN.
  - Guests can open `http://localhost:<port>` in their browser to preview the host's running application.
- **Built-in LAN Chat**:
  - Real-time peer chat with one-click code snippet sharing directly from editor selections.

---

## Architecture

```
  Host Machine (VS Code)                          Guest Machine (VS Code)
  ======================                          =======================
┌────────────────────────┐                      ┌────────────────────────┐
│   Togather LAN Host    │                      │   Togather LAN Guest   │
├────────────────────────┤                      ├────────────────────────┤
│ • WebSocket Server     │ <=== LAN Socket ===> │ • WebSocket Client     │
│ • mDNS Broadcaster     │ ···· mDNS Beacon ···>│ • mDNS Auto-Scanner    │
│ • Host File System     │ <--- File I/O -----> │ • togather:// Provider │
│ • Yjs Document CRDT    │ <--- Doc Deltas ---> │ • Yjs Local Replica    │
│ • Terminal PTY Stream  │ <--- Terminal I/O -> │ • Pseudoterminal       │
│ • TCP Port Forwarder   │ <--- TCP Tunnel ---> │ • Local TCP Proxy      │
│ • Chat Hub             │ <--- LAN Messages -> │ • Chat Webview         │
└────────────────────────┘                      └────────────────────────┘
```

---

## Getting Started

### 1. Launching in Development
1. Open this repository in VS Code.
2. Press **`F5`** (or select **Run > Start Debugging**) to launch an **Extension Development Host** window.
3. In the new window, click the **Togather LAN Share** icon in the Activity Bar (or status bar).

### 2. Hosting a Session
1. Open any project folder in VS Code.
2. Click **Start LAN Session (Host)** from the Togather sidebar or run command `Togather: Start LAN Session (Host)`.
3. Your local LAN IP and a random 4-digit PIN will be generated and displayed in the status bar (e.g., `192.168.1.50:7890 | PIN: 4812`).
4. Share the details with your teammates or let them find your session automatically via discovery.

### 3. Joining a Session (Guest)
- **Auto-Discovery**: Open the **Discovered LAN Sessions** panel in the Togather sidebar. If your colleague is on the same LAN/Wi-Fi, their session will appear automatically. Click to join.
- **Manual IP**: Click **Join LAN Session (Manual IP)**, enter the host's LAN IP and port (e.g., `192.168.1.50:7890`), and enter the PIN if prompted.
- The remote project folder will load in your VS Code workspace under `togather:/` without cloning any code.

### 4. Collaborative Features
- **Open LAN Chat**: Click **Open LAN Chat** in the sidebar to chat with all connected peers and share selected code blocks.
- **Share a Terminal**: Click **Share a Terminal** to launch a shared shell session for guests.
- **Share a Local Server**: Click **Share Local Server Port** and enter `3000` or `5173`. Guests will receive a notification allowing them to open the dev server in their browser.

---

## Extension Settings

You can customize Togather behavior in **Settings (`Ctrl+,`) > Extensions > Togather LAN Share**:

| Setting | Default | Description |
|---|---|---|
| `togather.defaultPort` | `7890` | TCP port used by the host WebSocket server. |
| `togather.userName` | `""` | Display name for sessions (defaults to OS user). |
| `togather.autoDiscover` | `true` | Broadcast and scan for sessions via mDNS. |
| `togather.requirePin` | `true` | Require a 4-digit PIN when guests join. |

---

## Packaging as VSIX

To create a distributable `.vsix` installer for your team:
```bash
npx @vscode/vsce package
```
Then install into VS Code:
```bash
code --install-extension togather-as-one-0.1.0.vsix
```

---

## License
MIT
# TogatherAsOne
