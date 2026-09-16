import * as os from 'os';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface FirewallStatus {
  isAllowed: boolean;
  isFirewallActive: boolean;
  type: 'ufw' | 'windows' | 'none' | 'unknown';
}

/**
 * Check if the target port is already allowed in the local firewall.
 */
export async function isPortAllowed(port: number): Promise<FirewallStatus> {
  const platform = os.platform();

  if (platform === 'linux') {
    try {
      // Check if UFW is active
      const { stdout: ufwStatus } = await execAsync('systemctl is-active ufw 2>/dev/null || echo "inactive"');
      const isUfwActive = ufwStatus.trim() === 'active';

      if (!isUfwActive) {
        return { isAllowed: true, isFirewallActive: false, type: 'ufw' };
      }

      // Check /etc/ufw/user.rules (readable by users)
      if (fs.existsSync('/etc/ufw/user.rules')) {
        const rules = fs.readFileSync('/etc/ufw/user.rules', 'utf8');
        const regex = new RegExp(`--dport\\s+${port}\\b.*-j\\s+ACCEPT`);
        const isAllowed = regex.test(rules);
        return { isAllowed, isFirewallActive: true, type: 'ufw' };
      }

      // Fallback: check iptables or assume false if ufw is active
      return { isAllowed: false, isFirewallActive: true, type: 'ufw' };
    } catch {
      return { isAllowed: true, isFirewallActive: false, type: 'none' };
    }
  }

  if (platform === 'win32') {
    try {
      const { stdout } = await execAsync(`netsh advfirewall firewall show rule name="Togather LAN Share"`);
      return { isAllowed: stdout.includes(port.toString()), isFirewallActive: true, type: 'windows' };
    } catch {
      return { isAllowed: false, isFirewallActive: true, type: 'windows' };
    }
  }

  return { isAllowed: true, isFirewallActive: false, type: 'none' };
}

/**
 * Automatically open the specified TCP port in the OS firewall using native privilege elevation.
 * - On Linux: Uses PolicyKit pkexec (triggers native GUI authorization prompt)
 * - On Windows: Uses PowerShell RunAs elevation
 */
export async function automateOpenPort(port: number): Promise<{ success: boolean; message: string }> {
  const platform = os.platform();

  // 1. Verify if already allowed
  const status = await isPortAllowed(port);
  if (status.isAllowed) {
    return { success: true, message: `Port ${port}/tcp is already open and allowed in your firewall.` };
  }

  if (platform === 'linux') {
    try {
      // Try pkexec ufw allow <port>/tcp
      // pkexec triggers standard PolicyKit graphical password prompt in desktop environments
      await execAsync(`pkexec ufw allow ${port}/tcp`, { timeout: 30000 });
      return { success: true, message: `Firewall port ${port}/tcp opened successfully via UFW!` };
    } catch (err: any) {
      return {
        success: false,
        message: `Could not automatically authorize firewall via pkexec: ${err.message}. Run "sudo ufw allow ${port}/tcp" manually.`,
      };
    }
  }

  if (platform === 'win32') {
    try {
      const psCmd = `Start-Process netsh -ArgumentList 'advfirewall firewall add rule name="Togather LAN Share" dir=in action=allow protocol=TCP localport=${port}' -Verb RunAs -WindowStyle Hidden`;
      await execAsync(`powershell -NoProfile -Command "${psCmd}"`);
      return { success: true, message: `Windows Firewall rule requested for port ${port}/tcp.` };
    } catch (err: any) {
      return { success: false, message: `Failed to elevate on Windows: ${err.message}` };
    }
  }

  return { success: true, message: 'No firewall adjustment needed on this operating system.' };
}
