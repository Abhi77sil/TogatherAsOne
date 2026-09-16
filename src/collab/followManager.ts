import * as vscode from 'vscode';
import * as path from 'path';
import { CursorPosition } from '../protocol/messages';
import { TogatherFileSystemProvider } from '../filesystem/togatherFileSystemProvider';

export class FollowManager {
  private followedParticipantId: string | null = null;
  private isHost: boolean;
  private workspaceRoot?: string;

  constructor(isHost: boolean, workspaceRoot?: string) {
    this.isHost = isHost;
    this.workspaceRoot = workspaceRoot;
  }

  public follow(participantId: string): void {
    this.followedParticipantId = participantId;
    vscode.window.showInformationMessage(`Now following participant.`);
  }

  public unfollow(): void {
    if (this.followedParticipantId) {
      this.followedParticipantId = null;
      vscode.window.showInformationMessage(`Stopped following.`);
    }
  }

  public isFollowing(participantId?: string): boolean {
    if (!participantId) return this.followedParticipantId !== null;
    return this.followedParticipantId === participantId;
  }

  public getFollowedId(): string | null {
    return this.followedParticipantId;
  }

  public async handleParticipantMoved(
    participantId: string,
    filePath: string,
    cursor?: CursorPosition
  ): Promise<void> {
    if (this.followedParticipantId !== participantId) return;

    let targetUri: vscode.Uri;
    if (this.isHost && this.workspaceRoot) {
      targetUri = vscode.Uri.file(path.join(this.workspaceRoot, filePath));
    } else {
      targetUri = vscode.Uri.parse(`${TogatherFileSystemProvider.SCHEME}:/${filePath}`);
    }

    try {
      const doc = await vscode.workspace.openTextDocument(targetUri);
      const editor = await vscode.window.showTextDocument(doc, {
        preview: true,
        preserveFocus: true,
      });

      if (cursor) {
        const pos = new vscode.Position(cursor.line, cursor.character);
        const range = new vscode.Range(pos, pos);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
    } catch (err) {
      console.error('[Togather] Error following participant into document:', err);
    }
  }
}
