import * as vscode from 'vscode';
import * as path from 'path';
import * as Y from 'yjs';
import { EventEmitter } from 'events';
import {
  DocUpdateMessage,
  DocSyncStep1Message,
  DocSyncStep2Message,
} from '../protocol/messages';
import { Participant, ActivityLogEntry } from '../protocol/types';
import { uint8ArrayToBase64, base64ToUint8Array } from '../utils/networkUtils';
import { ActivityLogger } from './activityLogger';

export interface DocBroadcaster {
  broadcastDocUpdate(filePath: string, update: Uint8Array): void;
  sendDocMessage(participantId: string, msg: any): void;
  isHost(): boolean;
  canWrite?: () => boolean;
  onSaveToDisk?: (filePath: string, content: string) => Promise<void>;
  onReadFromDisk?: (filePath: string) => Promise<string>;
  markRecentSave?: (filePath: string) => void;
  getCurrentParticipant?: () => Participant | null;
  getParticipant?: (id: string) => Participant | undefined;
  onActivityLogEntry?: (entry: ActivityLogEntry) => void;
}

export class CRDTDocManager extends EventEmitter {
  private ydocs: Map<string, Y.Doc> = new Map();
  private isApplyingRemoteChange: Map<string, boolean> = new Map();
  private isSavingCollaborativeDoc: Set<string> = new Set();
  private initializedDocs: Set<string> = new Set();
  private pendingSyncs: Set<string> = new Set();
  private saveDebounceTimers: Map<string, NodeJS.Timeout> = new Map();

  public readonly activityLogger: ActivityLogger;
  private broadcaster: DocBroadcaster;
  private disposables: vscode.Disposable[] = [];

  constructor(broadcaster: DocBroadcaster) {
    super();
    this.broadcaster = broadcaster;
    this.activityLogger = new ActivityLogger();
    this.setupEditorListeners();
  }

  public getActivityLogger(): ActivityLogger {
    return this.activityLogger;
  }

  public hasDoc(filePath: string): boolean {
    return this.ydocs.has(filePath);
  }

  /**
   * Get or create a Y.Doc for a normalized file path.
   * Host initializes with initial content; Guest waits for sync from Host.
   */
  public getOrCreateYDoc(filePath: string, initialContent = ''): Y.Doc {
    if (this.ydocs.has(filePath)) {
      const existing = this.ydocs.get(filePath)!;
      if (this.broadcaster.isHost() && initialContent && existing.getText('codetext').length === 0) {
        existing.getText('codetext').insert(0, initialContent);
        this.initializedDocs.add(filePath);
      }
      return existing;
    }

    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('codetext');

    // ONLY the Host is allowed to seed initial content into the Yjs doc.
    // Guests MUST receive the seeded state vector from the Host to avoid duplication!
    if (this.broadcaster.isHost() && initialContent && !this.initializedDocs.has(filePath)) {
      ytext.insert(0, initialContent);
      this.initializedDocs.add(filePath);
    }

    ydoc.on('update', (update: Uint8Array, origin: any) => {
      if (origin !== 'remote') {
        this.broadcaster.broadcastDocUpdate(filePath, update);
      }

      // If on Host, trigger debounced background disk auto-save (overwriting traditional autosave)
      if (this.broadcaster.isHost()) {
        this.scheduleDiskSave(filePath);
      }
    });

    this.ydocs.set(filePath, ydoc);

    // If Guest, initiate synchronization from Host
    if (!this.broadcaster.isHost() && !this.pendingSyncs.has(filePath)) {
      this.pendingSyncs.add(filePath);
      this.initiateSyncForFile(filePath);
    }

    return ydoc;
  }

  private setupEditorListeners(): void {
    // 1. Listen for local text document keystrokes
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        const filePath = this.getNormalizedFilePath(event.document.uri);
        if (!filePath) return;

        // Skip if this change was triggered by our own remote CRDT apply
        if (this.isApplyingRemoteChange.get(filePath)) {
          return;
        }

        // Check if write permissions are granted
        if (this.broadcaster.canWrite && !this.broadcaster.canWrite()) {
          vscode.window.showWarningMessage('You have Read-Only permissions in this session.');
          this.applyYjsToVscodeDocument(filePath);
          return;
        }

        // On host, seed doc if needed; on guest, ensure doc exists
        const ydoc = this.getOrCreateYDoc(
          filePath,
          this.broadcaster.isHost() ? event.document.getText() : ''
        );
        const ytext = ydoc.getText('codetext');

        // If Guest is still awaiting initial sync from host, don't corrupt ytext
        if (!this.broadcaster.isHost() && !this.initializedDocs.has(filePath)) {
          return;
        }

        // CRITICAL: If the document text already matches CRDT state, it's a save or reload no-op.
        // DO NOT re-insert or transact to avoid duplicate text!
        const docText = event.document.getText();
        if (docText === ytext.toString()) {
          return;
        }

        const beforeText = ytext.toString();

        // Apply local changes in a single Yjs transaction
        ydoc.transact(() => {
          // Sort changes in descending order of range offset
          const changes = [...event.contentChanges].sort(
            (a, b) => b.rangeOffset - a.rangeOffset
          );

          for (const change of changes) {
            const safeOffset = Math.min(change.rangeOffset, ytext.length);
            const safeLength = Math.min(change.rangeLength, ytext.length - safeOffset);

            if (safeLength > 0) {
              ytext.delete(safeOffset, safeLength);
            }
            if (change.text.length > 0) {
              ytext.insert(safeOffset, change.text);
            }
          }

          // Reconcile if there is any minor discrepancy (e.g. CRLF/LF or multi-cursor offset shift)
          if (ytext.toString() !== docText) {
            this.reconcileYTextWithDoc(ytext, docText);
          }
        }, 'local');

        const afterText = ytext.toString();

        // Log this edit in the Activity Logger
        if (beforeText !== afterText) {
          const currentP = this.broadcaster.getCurrentParticipant?.();
          const authorName = currentP?.name || (this.broadcaster.isHost() ? 'Host' : 'Guest');
          const authorId = currentP?.id || (this.broadcaster.isHost() ? 'host' : 'guest');
          const authorColor = currentP?.color || '#3b82f6';

          const entry = this.activityLogger.logTextEdit({
            authorId,
            authorName,
            authorColor,
            filePath,
            beforeText,
            afterText,
          });

          if (entry && this.broadcaster.onActivityLogEntry) {
            this.broadcaster.onActivityLogEntry(entry);
          }
        }
      })
    );

    // 2. Intercept save events: Overwrite traditional autosave behavior cleanly
    this.disposables.push(
      vscode.workspace.onWillSaveTextDocument((event) => {
        const filePath = this.getNormalizedFilePath(event.document.uri);
        if (!filePath) return;

        // If already being saved by our collaborative persistence engine, skip
        if (this.isSavingCollaborativeDoc.has(filePath)) {
          return;
        }

        // If host user manually pressed Ctrl+S, mark save and clear pending debounce
        if (this.broadcaster.isHost()) {
          this.broadcaster.markRecentSave?.(filePath);
          if (this.saveDebounceTimers.has(filePath)) {
            clearTimeout(this.saveDebounceTimers.get(filePath)!);
            this.saveDebounceTimers.delete(filePath);
          }
        }
      })
    );

    // 3. Mark recent saves on successful save to prevent watcher echo
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        const filePath = this.getNormalizedFilePath(doc.uri);
        if (filePath && this.broadcaster.isHost()) {
          this.broadcaster.markRecentSave?.(filePath);
        }
      })
    );

    // 4. When active editor changes, ensure document is synced
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (!editor) return;
        const filePath = this.getNormalizedFilePath(editor.document.uri);
        if (!filePath) return;

        if (!this.ydocs.has(filePath)) {
          this.getOrCreateYDoc(filePath, editor.document.getText());
        }
      })
    );
  }

  /**
   * Mathematically reconciles Y.Text with the target text using minimal prefix/suffix diff.
   * Guarantees ytext.toString() === targetText without full document clobbering or duplication.
   */
  private reconcileYTextWithDoc(ytext: Y.Text, targetText: string): void {
    const currentText = ytext.toString();
    if (currentText === targetText) return;

    let start = 0;
    while (
      start < currentText.length &&
      start < targetText.length &&
      currentText[start] === targetText[start]
    ) {
      start++;
    }

    let endOld = currentText.length;
    let endNew = targetText.length;
    while (
      endOld > start &&
      endNew > start &&
      currentText[endOld - 1] === targetText[endNew - 1]
    ) {
      endOld--;
      endNew--;
    }

    const delLen = endOld - start;
    const insertStr = targetText.substring(start, endNew);

    if (delLen > 0) {
      ytext.delete(start, delLen);
    }
    if (insertStr.length > 0) {
      ytext.insert(start, insertStr);
    }
  }

  /**
   * Handles incoming remote doc updates.
   */
  public async handleRemoteUpdate(
    filePath: string,
    updateBase64: string,
    senderId?: string
  ): Promise<void> {
    const ydoc = this.getOrCreateYDoc(filePath);
    const ytext = ydoc.getText('codetext');
    const beforeText = ytext.toString();
    const update = base64ToUint8Array(updateBase64);

    Y.applyUpdate(ydoc, update, 'remote');

    // Apply minimal diff to visible VS Code editors
    await this.applyYjsToVscodeDocument(filePath);

    const afterText = ytext.toString();

    // Log the remote change in Activity Logger
    if (beforeText !== afterText) {
      const p = senderId ? this.broadcaster.getParticipant?.(senderId) : undefined;
      const authorName = p?.name || senderId || 'Remote';
      const authorId = senderId || 'remote';
      const authorColor = p?.color || '#ec4899';

      const entry = this.activityLogger.logTextEdit({
        authorId,
        authorName,
        authorColor,
        filePath,
        beforeText,
        afterText,
      });

      if (entry && this.broadcaster.isHost() && this.broadcaster.onActivityLogEntry) {
        this.broadcaster.onActivityLogEntry(entry);
      }
    }

    // If host, debounced continuous background persistence (overriding traditional autosave)
    if (this.broadcaster.isHost()) {
      this.scheduleDiskSave(filePath);
    }
  }

  /**
   * Reverts a specific change log entry across all peers.
   */
  public async revertChange(entry: ActivityLogEntry, revertedBy = 'host'): Promise<boolean> {
    if (entry.reverted) {
      vscode.window.showWarningMessage(`Change #${entry.id.slice(-6)} is already reverted.`);
      return false;
    }

    const ydoc = this.getOrCreateYDoc(entry.filePath);
    const ytext = ydoc.getText('codetext');

    if (entry.changeType === 'text_edit') {
      const currentText = ytext.toString();

      // Invert diff slice if still cleanly present, otherwise restore snapshotBefore
      if (entry.addedText && currentText.includes(entry.addedText)) {
        ydoc.transact(() => {
          const index = currentText.indexOf(entry.addedText);
          ytext.delete(index, entry.addedText.length);
          if (entry.removedText) {
            ytext.insert(index, entry.removedText);
          }
        }, 'local');
      } else {
        ydoc.transact(() => {
          this.reconcileYTextWithDoc(ytext, entry.snapshotBefore);
        }, 'local');
      }

      await this.applyYjsToVscodeDocument(entry.filePath);
      this.activityLogger.markReverted(entry.id, revertedBy);

      // Log revert in activity log
      const revertLog = this.activityLogger.logTextEdit({
        authorId: 'host',
        authorName: `👑 Revert (#${entry.id.slice(-6)})`,
        authorColor: '#ef4444',
        filePath: entry.filePath,
        beforeText: currentText,
        afterText: ytext.toString(),
      });

      if (revertLog && this.broadcaster.onActivityLogEntry) {
        this.broadcaster.onActivityLogEntry(revertLog);
      }

      if (this.broadcaster.isHost()) {
        this.scheduleDiskSave(entry.filePath);
      }

      return true;
    }

    return false;
  }

  /**
   * Reverts all non-reverted changes made by a specific participant.
   */
  public async revertAllParticipantChanges(
    participantId: string,
    revertedBy = 'host'
  ): Promise<number> {
    const allEntries = this.activityLogger.getEntries();
    const userEntries = allEntries.filter(
      (e) => e.authorId === participantId && !e.reverted
    );

    if (userEntries.length === 0) {
      return 0;
    }

    // Group by file path
    const filesMap = new Map<string, ActivityLogEntry[]>();
    for (const e of userEntries) {
      const list = filesMap.get(e.filePath) || [];
      list.push(e);
      filesMap.set(e.filePath, list);
    }

    let revertedCount = 0;

    for (const [filePath, entries] of filesMap.entries()) {
      // Find oldest entry's snapshotBefore (last in list since newest is first)
      const oldestEntry = entries[entries.length - 1];
      const targetSnapshot = oldestEntry.snapshotBefore;

      const ydoc = this.getOrCreateYDoc(filePath);
      const ytext = ydoc.getText('codetext');
      const currentText = ytext.toString();

      ydoc.transact(() => {
        this.reconcileYTextWithDoc(ytext, targetSnapshot);
      }, 'local');

      await this.applyYjsToVscodeDocument(filePath);

      for (const e of entries) {
        this.activityLogger.markReverted(e.id, revertedBy);
        revertedCount++;
      }

      // Log revert action in activity log
      const revertLog = this.activityLogger.logTextEdit({
        authorId: 'host',
        authorName: `👑 Revert All by ${oldestEntry.authorName}`,
        authorColor: '#ef4444',
        filePath,
        beforeText: currentText,
        afterText: ytext.toString(),
      });

      if (revertLog && this.broadcaster.onActivityLogEntry) {
        this.broadcaster.onActivityLogEntry(revertLog);
      }

      if (this.broadcaster.isHost()) {
        this.scheduleDiskSave(filePath);
      }
    }

    return revertedCount;
  }

  /**
   * Ensures the host document has authoritative initial content from open editors or disk.
   */
  public async ensureHostDocInitialized(filePath: string): Promise<Y.Doc> {
    const existing = this.ydocs.get(filePath);
    if (existing && existing.getText('codetext').length > 0) {
      return existing;
    }

    let content = '';

    // 1. Check open documents in host's VS Code workspace
    const openDoc = vscode.workspace.textDocuments.find(
      (d) => this.getNormalizedFilePath(d.uri) === filePath
    );
    if (openDoc) {
      content = openDoc.getText();
    } else if (this.broadcaster.onReadFromDisk) {
      // 2. Read from disk if not open
      try {
        content = await this.broadcaster.onReadFromDisk(filePath);
      } catch (err) {
        console.error(`[Togather] Error reading ${filePath} from disk:`, err);
      }
    }

    if (existing) {
      const ytext = existing.getText('codetext');
      if (ytext.length === 0 && content.length > 0) {
        ytext.insert(0, content);
        this.initializedDocs.add(filePath);
      }
      return existing;
    }

    return this.getOrCreateYDoc(filePath, content);
  }

  /**
   * Pre-seeds all currently open text documents on session start.
   */
  public seedOpenDocuments(): void {
    if (!this.broadcaster.isHost()) return;
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.isClosed) continue;
      const filePath = this.getNormalizedFilePath(doc.uri);
      if (filePath && (!this.ydocs.has(filePath) || this.ydocs.get(filePath)!.getText('codetext').length === 0)) {
        this.getOrCreateYDoc(filePath, doc.getText());
      }
    }
  }

  /**
   * Sync protocol step 1: Receiver sends missing updates.
   */
  public async handleSyncStep1(filePath: string, vectorBase64: string, senderId: string): Promise<void> {
    let ydoc: Y.Doc;
    if (this.broadcaster.isHost()) {
      ydoc = await this.ensureHostDocInitialized(filePath);
    } else {
      ydoc = this.getOrCreateYDoc(filePath);
    }

    const remoteVector = base64ToUint8Array(vectorBase64);
    const missingUpdates = Y.encodeStateAsUpdate(ydoc, remoteVector);

    const step2: DocSyncStep2Message = {
      type: 'doc_sync_step2',
      filePath,
      update: uint8ArrayToBase64(missingUpdates),
    };
    this.broadcaster.sendDocMessage(senderId, step2);
  }

  /**
   * Sync protocol step 2: Apply authoritative updates from host.
   */
  public async handleSyncStep2(filePath: string, updateBase64: string): Promise<void> {
    const ydoc = this.getOrCreateYDoc(filePath);
    const update = base64ToUint8Array(updateBase64);

    Y.applyUpdate(ydoc, update, 'remote');
    this.initializedDocs.add(filePath);
    this.pendingSyncs.delete(filePath);

    await this.applyYjsToVscodeDocument(filePath);
  }

  public initiateSyncForFile(filePath: string): void {
    const ydoc = this.getOrCreateYDoc(filePath);
    const stateVector = Y.encodeStateVector(ydoc);
    const step1: DocSyncStep1Message = {
      type: 'doc_sync_step1',
      filePath,
      vector: uint8ArrayToBase64(stateVector),
    };
    this.broadcaster.sendDocMessage('host', step1);
  }

  /**
   * Applies Yjs document state to open VS Code text editors using a minimal prefix/suffix diff.
   * This prevents cursor jumping and avoids document clobbering.
   */
  private async applyYjsToVscodeDocument(filePath: string): Promise<void> {
    const editors = vscode.window.visibleTextEditors.filter(
      (ed) => this.getNormalizedFilePath(ed.document.uri) === filePath
    );

    if (editors.length === 0) return;

    const ydoc = this.ydocs.get(filePath);
    if (!ydoc) return;

    const expectedText = ydoc.getText('codetext').toString();

    for (const editor of editors) {
      const doc = editor.document;
      const currentText = doc.getText();
      if (currentText === expectedText) continue;

      // SAFETY GUARD: If the collaborative document is completely empty,
      // but the local editor already has content (e.g. freshly loaded via VFS),
      // DO NOT wipe out the editor!
      if (expectedText.length === 0 && currentText.length > 0 && !this.initializedDocs.has(filePath)) {
        console.warn(`[Togather] Guarded against blanking document ${filePath}`);
        continue;
      }

      // Compute minimal diff range using common prefix and suffix
      let start = 0;
      while (
        start < currentText.length &&
        start < expectedText.length &&
        currentText[start] === expectedText[start]
      ) {
        start++;
      }

      let endOld = currentText.length;
      let endNew = expectedText.length;
      while (
        endOld > start &&
        endNew > start &&
        currentText[endOld - 1] === expectedText[endNew - 1]
      ) {
        endOld--;
        endNew--;
      }

      if (start === endOld && start === endNew) {
        continue;
      }

      const rangeToReplace = new vscode.Range(
        doc.positionAt(start),
        doc.positionAt(endOld)
      );
      const textToInsert = expectedText.substring(start, endNew);

      this.isApplyingRemoteChange.set(filePath, true);
      try {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, rangeToReplace, textToInsert);
        await vscode.workspace.applyEdit(edit);
      } finally {
        // Retain guard briefly to catch any delayed microtasks
        setTimeout(() => {
          this.isApplyingRemoteChange.set(filePath, false);
        }, 50);
      }
    }
  }

  private scheduleDiskSave(filePath: string): void {
    if (this.saveDebounceTimers.has(filePath)) {
      clearTimeout(this.saveDebounceTimers.get(filePath)!);
    }

    const timer = setTimeout(() => {
      this.flushDiskSave(filePath);
    }, 500);

    this.saveDebounceTimers.set(filePath, timer);
  }

  /**
   * Flushes collaborative CRDT state to disk, seamlessly superseding traditional auto-save.
   */
  public async flushDiskSave(filePath: string): Promise<void> {
    if (this.saveDebounceTimers.has(filePath)) {
      clearTimeout(this.saveDebounceTimers.get(filePath)!);
      this.saveDebounceTimers.delete(filePath);
    }

    if (!this.broadcaster.isHost()) return;

    const ydoc = this.ydocs.get(filePath);
    if (!ydoc) return;

    const text = ydoc.getText('codetext').toString();

    // Check if document is currently open in VS Code on Host
    const openDoc = vscode.workspace.textDocuments.find(
      (d) => this.getNormalizedFilePath(d.uri) === filePath
    );

    if (openDoc) {
      if (openDoc.isDirty) {
        // Save directly through VS Code to clear dirty indicator without file conflict warnings
        this.isSavingCollaborativeDoc.add(filePath);
        this.broadcaster.markRecentSave?.(filePath);
        try {
          await openDoc.save();
        } catch (err) {
          console.error(`[Togather] Error saving open document ${filePath}:`, err);
        } finally {
          this.isSavingCollaborativeDoc.delete(filePath);
        }
      }
      // If open in VS Code, never write raw bytes to disk behind VS Code's back!
      return;
    }

    if (this.broadcaster.onSaveToDisk) {
      this.broadcaster.markRecentSave?.(filePath);
      await this.broadcaster.onSaveToDisk(filePath, text).catch((err) => {
        console.error(`[Togather] Error auto-saving ${filePath} to disk:`, err);
      });
    }
  }

  public async flushAllDiskSaves(): Promise<void> {
    for (const filePath of this.ydocs.keys()) {
      await this.flushDiskSave(filePath);
    }
  }

  public getNormalizedFilePath(uri: vscode.Uri): string | null {
    if (uri.scheme === 'file') {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) return null;
      const rootPath = folders[0].uri.fsPath;
      const rel = path.relative(rootPath, uri.fsPath).replace(/\\/g, '/');
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return null;
      }
      return rel;
    } else if (uri.scheme === 'togather') {
      return uri.path.replace(/^\/+/, '');
    }
    return null;
  }

  public dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    for (const timer of this.saveDebounceTimers.values()) {
      clearTimeout(timer);
    }
    this.saveDebounceTimers.clear();
    this.ydocs.clear();
    this.initializedDocs.clear();
    this.pendingSyncs.clear();
    this.isSavingCollaborativeDoc.clear();
    this.activityLogger.clear();
  }
}
