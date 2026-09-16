import * as vscode from 'vscode';

/**
 * Retrieves the currently signed-in GitHub username from VS Code's authentication provider.
 * Does not prompt the user or force login if not already signed in.
 */
export async function getGitHubUsername(): Promise<string | null> {
  try {
    const session = await vscode.authentication.getSession('github', ['read:user'], {
      createIfNone: false,
    });
    if (session && session.account && session.account.label) {
      return session.account.label;
    }
  } catch (err) {
    // User is not signed in to GitHub in VS Code
  }
  return null;
}

export function formatDisplayName(githubUser: string | null, fallbackGuestName: string): string {
  if (githubUser) {
    return `@${githubUser}`;
  }
  return fallbackGuestName;
}
