import * as vscode from 'vscode';
import { Participant } from '../protocol/types';
import { CursorPosition, SelectionRange, CursorUpdateMessage } from '../protocol/messages';

interface ParticipantDecorations {
  cursorType: vscode.TextEditorDecorationType;
  selectionType: vscode.TextEditorDecorationType;
  nameTagType: vscode.TextEditorDecorationType;
}

export class CursorManager {
  private decorations: Map<string, ParticipantDecorations> = new Map();
  private lastCursorPositions: Map<
    string,
    {
      filePath: string;
      cursor: CursorPosition;
      selection?: SelectionRange;
    }
  > = new Map();

  private onCursorChangeEmitter: ((data: {
    filePath: string;
    cursor: CursorPosition;
    selection?: SelectionRange;
  }) => void) | null = null;

  private onActiveFileChangeEmitter: ((filePath: string) => void) | null = null;
  private disposables: vscode.Disposable[] = [];

  constructor(
    getNormalizedPath: (uri: vscode.Uri) => string | null,
    onCursorChange: (data: {
      filePath: string;
      cursor: CursorPosition;
      selection?: SelectionRange;
    }) => void,
    onActiveFileChange: (filePath: string) => void
  ) {
    this.onCursorChangeEmitter = onCursorChange;
    this.onActiveFileChangeEmitter = onActiveFileChange;

    // Listen to local cursor/selection changes
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection((event) => {
        const filePath = getNormalizedPath(event.textEditor.document.uri);
        if (!filePath || event.selections.length === 0) return;

        const sel = event.selections[0];
        const cursor: CursorPosition = {
          line: sel.active.line,
          character: sel.active.character,
        };

        let selection: SelectionRange | undefined;
        if (!sel.isEmpty) {
          selection = {
            anchor: { line: sel.anchor.line, character: sel.anchor.character },
            active: { line: sel.active.line, character: sel.active.character },
          };
        }

        if (this.onCursorChangeEmitter) {
          this.onCursorChangeEmitter({ filePath, cursor, selection });
        }
      })
    );

    // Listen to local active file changes
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (!editor) return;
        const filePath = getNormalizedPath(editor.document.uri);
        if (filePath && this.onActiveFileChangeEmitter) {
          this.onActiveFileChangeEmitter(filePath);
        }
        this.refreshDecorationsForEditor(editor, getNormalizedPath);
      })
    );
  }

  public registerParticipant(participant: Participant): void {
    if (this.decorations.has(participant.id)) return;

    const color = participant.color || '#3b82f6';
    const isHost = participant.role === 'host';
    const isGithub = participant.name.startsWith('@');
    const badgeIcon = isHost ? '👑 ' : isGithub ? ' ' : '👤 ';
    const badgeText = ` ${badgeIcon}${participant.name} `;

    const cursorType = vscode.window.createTextEditorDecorationType({
      borderStyle: 'solid',
      borderWidth: '0 0 0 2.5px',
      borderColor: color,
    });

    const selectionType = vscode.window.createTextEditorDecorationType({
      backgroundColor: `${color}28`,
      border: `1px solid ${color}80`,
    });

    const nameTagType = vscode.window.createTextEditorDecorationType({
      after: {
        contentText: badgeText,
        color: '#ffffff',
        backgroundColor: color,
        fontWeight: '600',
        margin: '0 0 0 4px',
        border: '1px solid rgba(255, 255, 255, 0.35)',
      },
    });

    this.decorations.set(participant.id, {
      cursorType,
      selectionType,
      nameTagType,
    });
  }

  public unregisterParticipant(participantId: string): void {
    const dec = this.decorations.get(participantId);
    if (dec) {
      dec.cursorType.dispose();
      dec.selectionType.dispose();
      dec.nameTagType.dispose();
      this.decorations.delete(participantId);
    }
    this.lastCursorPositions.delete(participantId);
  }

  public updateRemoteCursor(
    participant: Participant,
    filePath: string,
    cursor: CursorPosition,
    selection?: SelectionRange,
    getNormalizedPath?: (uri: vscode.Uri) => string | null
  ): void {
    this.registerParticipant(participant);
    this.lastCursorPositions.set(participant.id, { filePath, cursor, selection });

    const dec = this.decorations.get(participant.id);
    if (!dec) return;

    for (const editor of vscode.window.visibleTextEditors) {
      const editorPath = getNormalizedPath
        ? getNormalizedPath(editor.document.uri)
        : null;

      if (editorPath === filePath) {
        const cursorPosition = new vscode.Position(cursor.line, cursor.character);
        const cursorRange = new vscode.Range(cursorPosition, cursorPosition);

        const isHost = participant.role === 'host';
        const isGithub = participant.name.startsWith('@');
        const badgeIcon = isHost ? '👑 ' : isGithub ? ' ' : '👤 ';

        const hoverMessage = new vscode.MarkdownString(
          `### ${badgeIcon} ${participant.name}\n\n- **Role**: \`${participant.role.toUpperCase()}\`\n- **Permissions**: \`${participant.access}\`\n- **File**: \`${filePath}\``
        );

        const decorationOption: vscode.DecorationOptions = {
          range: cursorRange,
          hoverMessage,
        };

        // Apply cursor line marker and name tag
        editor.setDecorations(dec.cursorType, [decorationOption]);
        editor.setDecorations(dec.nameTagType, [decorationOption]);

        // Apply selection if non-empty
        if (selection) {
          const anchor = new vscode.Position(selection.anchor.line, selection.anchor.character);
          const active = new vscode.Position(selection.active.line, selection.active.character);
          const selRange = new vscode.Range(anchor, active);
          editor.setDecorations(dec.selectionType, [selRange]);
        } else {
          editor.setDecorations(dec.selectionType, []);
        }
      } else {
        // Clear decorations in other files for this participant
        editor.setDecorations(dec.cursorType, []);
        editor.setDecorations(dec.selectionType, []);
        editor.setDecorations(dec.nameTagType, []);
      }
    }
  }

  private refreshDecorationsForEditor(
    editor: vscode.TextEditor,
    getNormalizedPath: (uri: vscode.Uri) => string | null
  ): void {
    const editorPath = getNormalizedPath(editor.document.uri);
    if (!editorPath) return;

    for (const [pId, pos] of this.lastCursorPositions.entries()) {
      const dec = this.decorations.get(pId);
      if (!dec) continue;

      if (pos.filePath === editorPath) {
        const cursorPosition = new vscode.Position(pos.cursor.line, pos.cursor.character);
        const cursorRange = new vscode.Range(cursorPosition, cursorPosition);
        editor.setDecorations(dec.cursorType, [cursorRange]);
        editor.setDecorations(dec.nameTagType, [cursorRange]);

        if (pos.selection) {
          const anchor = new vscode.Position(
            pos.selection.anchor.line,
            pos.selection.anchor.character
          );
          const active = new vscode.Position(
            pos.selection.active.line,
            pos.selection.active.character
          );
          editor.setDecorations(dec.selectionType, [new vscode.Range(anchor, active)]);
        }
      }
    }
  }

  public dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    for (const dec of this.decorations.values()) {
      dec.cursorType.dispose();
      dec.selectionType.dispose();
      dec.nameTagType.dispose();
    }
    this.decorations.clear();
    this.lastCursorPositions.clear();
  }
}
