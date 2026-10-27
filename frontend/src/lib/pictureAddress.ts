/** IPv4 ranges that are not the public internet: this machine, private and shared networks, link-local, benchmark, multicast and reserved. */
const PRIVATE_V4: ReadonlyArray<[number, number]> = [
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16], [0xac100000, 12],
  [0xc0000000, 24], [0xc0a80000, 16], [0xc6120000, 15], [0xe0000000, 4], [0xf0000000, 4],
];

function v4Number(host: string): number | null {
  const parts = host.split('.');
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return null;
  return parts.reduce((sum, part) => sum * 256 + Number(part), 0);
}

const inV4Range = (value: number) => PRIVATE_V4.some(([base, bits]) => Math.floor(value / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)));

/** Names that only this machine or its network resolve. */
const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.intranet'];

/**
 * Hosts on this machine or its network: a picture there is never fetched from
 * a page. Takes a URL's hostname, which the URL parser has already normalized
 * (IPv4 in dotted decimal, IPv6 compressed). A name that resolves to a private
 * address cannot be told from its spelling.
 */
export function isPrivateImageHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!host) return true;
  const v4 = v4Number(host);
  if (v4 !== null) return inV4Range(v4);
  if (host.includes(':')) {
    return host === '::' || host === '::1'
      || /^f[cd][0-9a-f]{2}:/.test(host) // unique local
      || /^fe[89a-f][0-9a-f]:/.test(host) // link-local, and the old site-local
      || /^ff[0-9a-f]{2}:/.test(host) // multicast
      || host.startsWith('::ffff:') // IPv4-mapped
      || /^::[0-9a-f]{1,4}(:[0-9a-f]{1,4})?$/.test(host) // IPv4-compatible
      || host.startsWith('64:ff9b:'); // NAT64, which reaches IPv4
  }
  // A single label (`printer`, `nas`) is a name on the local network.
  return !host.includes('.') || host === 'localhost' || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Where a picture may load from: an https address on the internet, returned
 * trimmed. Anything else (http, this machine, the local network) is null and
 * is shown as its caption and address instead.
 */
export function loadableImageUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const href = value.trim();
  try {
    const url = new URL(href);
    return url.protocol === 'https:' && url.hostname && !isPrivateImageHost(url.hostname) ? href : null;
  } catch {
    return null;
  }
}
