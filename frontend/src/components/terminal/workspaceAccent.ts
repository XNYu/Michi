const PALETTE = ['#b8451f', '#6d4aa8', '#2f6b4e', '#c48300', '#1a4d8f', '#a8261a', '#316e9a', '#7a5b2b'];

function hash(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function workspaceAccent(id: string): string {
  return PALETTE[hash(id) % PALETTE.length];
}

export function initialOf(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toUpperCase() : '?';
}
