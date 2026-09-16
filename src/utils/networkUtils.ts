import * as os from 'os';

export function getLocalLanIps(): string[] {
  const interfaces = os.networkInterfaces();
  const ips: string[] = [];

  for (const name of Object.keys(interfaces)) {
    const ifaceList = interfaces[name];
    if (!ifaceList) continue;

    for (const iface of ifaceList) {
      // Skip internal loopback and non-IPv4
      if (iface.family === 'IPv4' && !iface.internal) {
        // Skip common virtual interfaces like docker, br-, veth
        if (
          name.startsWith('docker') ||
          name.startsWith('br-') ||
          name.startsWith('veth') ||
          name.startsWith('virbr')
        ) {
          continue;
        }
        ips.push(iface.address);
      }
    }
  }

  // Sort prioritizing standard home/office LANs: 192.168.x.x, 10.x.x.x, 172.16-31.x.x
  ips.sort((a, b) => {
    if (a.startsWith('192.168.')) return -1;
    if (b.startsWith('192.168.')) return 1;
    if (a.startsWith('10.')) return -1;
    if (b.startsWith('10.')) return 1;
    return 0;
  });

  return ips.length > 0 ? ips : ['127.0.0.1'];
}

export function generatePin(): string {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

export function generateId(prefix = 'id'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`;
}

const COLLABORATOR_COLORS = [
  '#3b82f6', // blue
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ec4899', // pink
  '#8b5cf6', // violet
  '#06b6d4', // cyan
  '#f97316', // orange
  '#14b8a6', // teal
  '#e11d48', // rose
  '#6366f1', // indigo
];

export function getCollaboratorColor(index: number): string {
  return COLLABORATOR_COLORS[index % COLLABORATOR_COLORS.length];
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

export function base64ToUint8Array(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}
