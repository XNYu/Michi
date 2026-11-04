import net from "node:net";

/**
 * Which network addresses fetch_content may connect to.
 *
 * Michi can run with remote access, so the backend may sit inside a private
 * network or on a cloud host with a metadata service. A model-chosen URL must
 * never reach those: only public unicast addresses are allowed. Everything
 * else (loopback, private, link-local, CGNAT, multicast, reserved and
 * documentation ranges, and IPv6 forms that embed such an IPv4 address) is
 * refused.
 */

interface Ipv4Range { base: number; bits: number }

const BLOCKED_IPV4: readonly Ipv4Range[] = [
    "0.0.0.0/8",        // "this network", includes the unspecified address
    "10.0.0.0/8",       // private
    "100.64.0.0/10",    // carrier-grade NAT
    "127.0.0.0/8",      // loopback
    "169.254.0.0/16",   // link-local, includes 169.254.169.254 (cloud metadata)
    "172.16.0.0/12",    // private
    "192.0.0.0/24",     // IETF protocol assignments
    "192.0.2.0/24",     // documentation
    "192.88.99.0/24",   // 6to4 relay anycast
    "192.168.0.0/16",   // private
    "198.18.0.0/15",    // benchmarking
    "198.51.100.0/24",  // documentation
    "203.0.113.0/24",   // documentation
    "224.0.0.0/4",      // multicast
    "240.0.0.0/4",      // reserved, includes 255.255.255.255
].map((cidr) => {
    const [address, bits] = cidr.split("/");
    return { base: ipv4ToNumber(address)!, bits: Number(bits) };
});

interface Ipv6Range { base: bigint; bits: number }

/** Blocked ranges inside 2000::/3, the only IPv6 space that is otherwise allowed. */
const BLOCKED_GLOBAL_IPV6: readonly Ipv6Range[] = [
    "2001::/23",        // IETF protocol assignments: Teredo, benchmarking, ORCHID
    "2001:db8::/32",    // documentation
    "3fff::/20",        // documentation
].map((cidr) => {
    const [address, bits] = cidr.split("/");
    return { base: ipv6ToBigInt(address)!, bits: Number(bits) };
});

const IPV6_GLOBAL_UNICAST: Ipv6Range = { base: ipv6ToBigInt("2000::")!, bits: 3 };
const IPV4_MAPPED: Ipv6Range = { base: ipv6ToBigInt("::ffff:0:0")!, bits: 96 };
const NAT64: Ipv6Range = { base: ipv6ToBigInt("64:ff9b::")!, bits: 96 };
const SIX_TO_FOUR: Ipv6Range = { base: ipv6ToBigInt("2002::")!, bits: 16 };

/**
 * True when fetch_content must not connect to the address. Anything that is
 * not a well-formed IPv4 or IPv6 literal is treated as blocked.
 */
export function isBlockedAddress(address: string): boolean {
    const literal = stripBrackets(address);
    if (net.isIPv4(literal)) return isBlockedIpv4(ipv4ToNumber(literal)!);
    if (!net.isIPv6(literal) || literal.includes("%")) return true;
    const value = ipv6ToBigInt(literal);
    if (value === null) return true;
    // IPv4 embedded in IPv6 is judged by its IPv4 address: a mapped address
    // reaches the IPv4 host directly, and NAT64 / 6to4 gateways forward to it.
    if (inIpv6Range(value, IPV4_MAPPED) || inIpv6Range(value, NAT64)) {
        return isBlockedIpv4(Number(value & 0xffffffffn));
    }
    if (inIpv6Range(value, SIX_TO_FOUR)) {
        return isBlockedIpv4(Number((value >> 80n) & 0xffffffffn));
    }
    // ::, ::1, IPv4-compatible ::/96, ULA fc00::/7, link-local fe80::/10,
    // site-local fec0::/10, multicast ff00::/8 and discard 100::/64 all lie
    // outside global unicast.
    if (!inIpv6Range(value, IPV6_GLOBAL_UNICAST)) return true;
    return BLOCKED_GLOBAL_IPV6.some((range) => inIpv6Range(value, range));
}

/** The URL hostname as an address or DNS name: lower case, no brackets, no trailing dot. */
export function normalizeHostname(hostname: string): string {
    return stripBrackets(hostname).toLowerCase().replace(/\.+$/, "");
}

function stripBrackets(value: string): string {
    return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

function isBlockedIpv4(value: number): boolean {
    return BLOCKED_IPV4.some((range) => inIpv4Range(value, range));
}

function inIpv4Range(value: number, range: Ipv4Range): boolean {
    if (range.bits === 0) return true;
    const shift = 32 - range.bits;
    return (value >>> shift) === (range.base >>> shift);
}

function inIpv6Range(value: bigint, range: Ipv6Range): boolean {
    const shift = BigInt(128 - range.bits);
    return (value >> shift) === (range.base >> shift);
}

function ipv4ToNumber(address: string): number | null {
    const parts = address.split(".");
    if (parts.length !== 4) return null;
    let value = 0;
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) return null;
        const octet = Number(part);
        if (octet > 255) return null;
        value = value * 256 + octet;
    }
    return value;
}

function ipv6ToBigInt(address: string): bigint | null {
    let text = address;
    // A trailing dotted quad (::ffff:1.2.3.4) supplies the last two groups.
    const lastColon = text.lastIndexOf(":");
    const tail = text.slice(lastColon + 1);
    if (tail.includes(".")) {
        const v4 = ipv4ToNumber(tail);
        if (v4 === null) return null;
        text = `${text.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
    }
    const halves = text.split("::");
    if (halves.length > 2) return null;
    const head = halves[0] ? halves[0].split(":") : [];
    const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    const missing = 8 - head.length - rest.length;
    if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
    const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
    let value = 0n;
    for (const group of groups) {
        if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
        value = (value << 16n) | BigInt(parseInt(group, 16));
    }
    return value;
}
