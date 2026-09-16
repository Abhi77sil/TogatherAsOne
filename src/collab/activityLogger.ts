import { EventEmitter } from 'events';
import { ActivityLogEntry } from '../protocol/types';
import { generateId } from '../utils/networkUtils';

export class ActivityLogger extends EventEmitter {
  private entries: ActivityLogEntry[] = [];
  private maxEntries = 500;

  constructor() {
    super();
  }

  public getEntries(): ActivityLogEntry[] {
    return [...this.entries];
  }

  public getEntry(id: string): ActivityLogEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  /**
   * Logs a text edit made in a document.
   */
  public logTextEdit(params: {
    authorId: string;
    authorName: string;
    authorColor: string;
    filePath: string;
    beforeText: string;
    afterText: string;
  }): ActivityLogEntry | null {
    const { authorId, authorName, authorColor, filePath, beforeText, afterText } = params;

    if (beforeText === afterText) {
      return null;
    }

    const diff = this.computeDiff(beforeText, afterText);

    const entry: ActivityLogEntry = {
      id: generateId('act'),
      timestamp: Date.now(),
      authorId,
      authorName,
      authorColor,
      filePath,
      changeType: 'text_edit',
      summary: diff.summary,
      startLine: diff.startLine,
      endLine: diff.endLine,
      addedLinesCount: diff.addedLinesCount,
      removedLinesCount: diff.removedLinesCount,
      addedText: diff.addedText,
      removedText: diff.removedText,
      snapshotBefore: beforeText,
      snapshotAfter: afterText,
      reverted: false,
    };

    this.addEntry(entry);
    return entry;
  }

  /**
   * Logs a file creation or deletion.
   */
  public logFileOperation(params: {
    authorId: string;
    authorName: string;
    authorColor: string;
    filePath: string;
    changeType: 'file_created' | 'file_deleted';
    contentSnapshot?: string;
  }): ActivityLogEntry {
    const { authorId, authorName, authorColor, filePath, changeType, contentSnapshot = '' } = params;

    const summary =
      changeType === 'file_created' ? `Created file ${filePath}` : `Deleted file ${filePath}`;

    const entry: ActivityLogEntry = {
      id: generateId('act'),
      timestamp: Date.now(),
      authorId,
      authorName,
      authorColor,
      filePath,
      changeType,
      summary,
      startLine: 1,
      endLine: 1,
      addedLinesCount: changeType === 'file_created' ? contentSnapshot.split('\n').length : 0,
      removedLinesCount: changeType === 'file_deleted' ? contentSnapshot.split('\n').length : 0,
      addedText: changeType === 'file_created' ? contentSnapshot : '',
      removedText: changeType === 'file_deleted' ? contentSnapshot : '',
      snapshotBefore: changeType === 'file_deleted' ? contentSnapshot : '',
      snapshotAfter: changeType === 'file_created' ? contentSnapshot : '',
      reverted: false,
    };

    this.addEntry(entry);
    return entry;
  }

  public addEntry(entry: ActivityLogEntry): void {
    // Avoid duplicate IDs if receiving sync
    if (this.entries.some((e) => e.id === entry.id)) return;

    this.entries.unshift(entry); // Newest first

    if (this.entries.length > this.maxEntries) {
      this.entries.length = this.maxEntries;
    }

    this.emit('entryAdded', entry);
    this.emit('changed');
  }

  public markReverted(id: string, revertedBy: string): ActivityLogEntry | undefined {
    const entry = this.entries.find((e) => e.id === id);
    if (entry) {
      entry.reverted = true;
      entry.revertedAt = Date.now();
      entry.revertedBy = revertedBy;
      this.emit('entryUpdated', entry);
      this.emit('changed');
      return entry;
    }
    return undefined;
  }

  public clear(): void {
    this.entries = [];
    this.emit('cleared');
    this.emit('changed');
  }

  public loadEntries(entries: ActivityLogEntry[]): void {
    this.entries = [...entries];
    this.emit('changed');
  }

  /**
   * Computes human-readable diff metrics between two text strings.
   */
  private computeDiff(
    before: string,
    after: string
  ): {
    startLine: number;
    endLine: number;
    addedLinesCount: number;
    removedLinesCount: number;
    addedText: string;
    removedText: string;
    summary: string;
  } {
    let prefix = 0;
    while (
      prefix < before.length &&
      prefix < after.length &&
      before[prefix] === after[prefix]
    ) {
      prefix++;
    }

    let suffixBefore = before.length;
    let suffixAfter = after.length;
    while (
      suffixBefore > prefix &&
      suffixAfter > prefix &&
      before[suffixBefore - 1] === after[suffixAfter - 1]
    ) {
      suffixBefore--;
      suffixAfter--;
    }

    const removedText = before.substring(prefix, suffixBefore);
    const addedText = after.substring(prefix, suffixAfter);

    // Calculate line numbers
    const linesBeforePrefix = before.substring(0, prefix).split('\n');
    const startLine = linesBeforePrefix.length;
    const linesInRemoved = removedText.split('\n').length - 1;
    const endLine = startLine + linesInRemoved;

    const addedLinesCount = addedText ? addedText.split('\n').length - 1 : 0;
    const removedLinesCount = linesInRemoved;

    // Generate summary
    const parts: string[] = [];
    if (addedLinesCount > 0) parts.push(`+${addedLinesCount} line${addedLinesCount > 1 ? 's' : ''}`);
    if (removedLinesCount > 0) parts.push(`-${removedLinesCount} line${removedLinesCount > 1 ? 's' : ''}`);

    if (parts.length === 0) {
      if (addedText.length > 0 && removedText.length > 0) {
        parts.push(`Changed ${addedText.length} chars`);
      } else if (addedText.length > 0) {
        parts.push(`Added ${addedText.length} chars`);
      } else if (removedText.length > 0) {
        parts.push(`Deleted ${removedText.length} chars`);
      } else {
        parts.push('Edited line');
      }
    }

    const summary = parts.join(', ') || 'Edited text';

    return {
      startLine,
      endLine,
      addedLinesCount,
      removedLinesCount,
      addedText,
      removedText,
      summary,
    };
  }
}
