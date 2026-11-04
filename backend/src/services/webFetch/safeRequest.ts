import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { LookupFunction, Socket } from "node:net";
import type { Readable } from "node:stream";
import zlib from "node:zlib";
import { isBlockedAddress, normalizeHostname } from "./addressPolicy";

/**
 * A GET request that cannot be steered into the backend's own network.
 *
 * Every hop (the first URL and each redirect) is validated before any
 * connection: http(s) only, no embedded credentials, no local names, and every
 * address the host resolves to must be public. The connection is then pinned
 * to the checked address through the socket's lookup hook, so a second DNS
 * answer (DNS rebinding) cannot change where it goes; TLS still verifies the
 * certificate against the hostname. Redirects, decoded body bytes and total
 * time are capped.
 */

export interface ResolvedAddress { address: string; family: 4 | 6 }

/** Resolves a DNS name to every address it currently has. */
export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface SafeGetOptions {
    maxRedirects: number;
    /** Cap on decoded body bytes; the body is cut there and marked truncated. */
    maxBytes: number;
    /** Whole request, including redirects and the body. */
    timeoutMs: number;
    signal?: AbortSignal;
    resolveHost?: HostResolver;
    /** Exempts specific addresses from the blocklist. Tests use it for their 127.0.0.1 server. */
    allowAddress?: (address: string) => boolean;
}

export interface SafeGetResult {
    finalUrl: string;
    status: number;
    contentType: string | null;
    body: Buffer;
    bodyTruncated: boolean;
}

export type WebFetchErrorCode =
    | "invalid_url"
    | "blocked_url"
    | "too_many_redirects"
    | "timeout"
    | "http_error"
    | "unsupported_content"
    | "too_large"
    | "network";

export class WebFetchError extends Error {
    constructor(readonly code: WebFetchErrorCode, message: string) {
        super(message);
        this.name = "WebFetchError";
    }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const REQUEST_HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; MichiFetch/1.0)",
    Accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,text/plain;q=0.8,*/*;q=0.5",
    "Accept-Encoding": "gzip, deflate, br",
    "Accept-Language": "en;q=0.9,*;q=0.5",
};

const systemResolver: HostResolver = async (hostname) => {
    const answers = await dns.promises.lookup(hostname, { all: true, verbatim: true });
    return answers.map((answer) => ({ address: answer.address, family: answer.family === 6 ? 6 : 4 }));
};

/** Parses and checks a URL without touching the network. */
export function checkFetchUrl(raw: string): URL {
    let url: URL;
    try {
        url = new URL(raw.trim());
    } catch {
        throw new WebFetchError("invalid_url", "The URL is not a valid absolute URL.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new WebFetchError("blocked_url", "Only http and https URLs can be fetched.");
    }
    if (url.username || url.password) {
        throw new WebFetchError("blocked_url", "URLs with embedded credentials are not fetched.");
    }
    const host = normalizeHostname(url.hostname);
    if (!host) throw new WebFetchError("invalid_url", "The URL has no host.");
    if (host === "localhost" || host.endsWith(".localhost")) {
        throw new WebFetchError("blocked_url", "Local addresses cannot be fetched.");
    }
    // A single-label name (no dot) is a local or search-domain name, never a public site.
    if (net.isIP(host) === 0 && !host.includes(".")) {
        throw new WebFetchError("blocked_url", "Local host names cannot be fetched; use a public domain name.");
    }
    url.hash = "";
    return url;
}

export async function safeGet(rawUrl: string, options: SafeGetOptions): Promise<SafeGetResult> {
    const timeout = AbortSignal.timeout(options.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
        let url = checkFetchUrl(rawUrl);
        for (let redirects = 0; ; redirects += 1) {
            const pinned = await resolvePublicAddress(url, options, signal);
            const response = await requestOnce(url, pinned, options, signal);
            const location = response.headers.location;
            if (REDIRECT_STATUSES.has(response.statusCode ?? 0) && location) {
                response.destroy();
                if (redirects >= options.maxRedirects) {
                    throw new WebFetchError("too_many_redirects", `Stopped after ${options.maxRedirects} redirects.`);
                }
                let next: URL;
                try {
                    next = new URL(location, url);
                } catch {
                    throw new WebFetchError("invalid_url", "The server redirected to an invalid URL.");
                }
                url = checkFetchUrl(next.href);
                continue;
            }
            const status = response.statusCode ?? 0;
            if (status < 200 || status > 299) {
                response.destroy();
                throw new WebFetchError("http_error", `The server answered HTTP ${status}${response.statusMessage ? ` ${response.statusMessage}` : ""}.`);
            }
            const { body, truncated } = await readBody(response, options.maxBytes, signal);
            const contentType = response.headers["content-type"];
            return {
                finalUrl: url.href,
                status,
                contentType: typeof contentType === "string" ? contentType : null,
                body,
                bodyTruncated: truncated,
            };
        }
    } catch (error) {
        if (timeout.aborted && !(error instanceof WebFetchError)) {
            throw new WebFetchError("timeout", `The request did not finish within ${Math.ceil(options.timeoutMs / 1000)}s.`);
        }
        if (options.signal?.aborted) throw options.signal.reason ?? error;
        throw error;
    }
}

async function resolvePublicAddress(url: URL, options: SafeGetOptions, signal: AbortSignal): Promise<ResolvedAddress> {
    const host = normalizeHostname(url.hostname);
    const literal = net.isIP(host);
    let addresses: ResolvedAddress[];
    if (literal) {
        addresses = [{ address: host, family: literal === 6 ? 6 : 4 }];
    } else {
        try {
            addresses = await abortable((options.resolveHost ?? systemResolver)(host), signal);
        } catch (error) {
            if (signal.aborted) throw error;
            throw new WebFetchError("network", `Could not resolve ${host}.`);
        }
    }
    if (addresses.length === 0) throw new WebFetchError("network", `Could not resolve ${host}.`);
    // One private answer is enough to refuse: the resolver's order is not a promise about the next lookup.
    for (const { address } of addresses) {
        if (isBlockedAddress(address) && !options.allowAddress?.(address)) {
            throw new WebFetchError("blocked_url", literal
                ? "Local, private and reserved network addresses cannot be fetched."
                : `${host} resolves to a local, private or reserved network address, which cannot be fetched.`);
        }
    }
    return addresses[0];
}

function requestOnce(url: URL, pinned: ResolvedAddress, options: SafeGetOptions, signal: AbortSignal): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
        signal.throwIfAborted();
        const host = normalizeHostname(url.hostname);
        const isHttps = url.protocol === "https:";
        // Answers the socket's own lookup with the address checked above, never a fresh DNS query.
        const lookup: LookupFunction = (_hostname, lookupOptions, callback) => {
            if (lookupOptions.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
            else callback(null, pinned.address, pinned.family);
        };
        const requestOptions: https.RequestOptions = {
            protocol: url.protocol,
            hostname: host,
            port: url.port || undefined,
            path: `${url.pathname}${url.search}`,
            method: "GET",
            headers: REQUEST_HEADERS,
            agent: false,
            lookup,
            ...(isHttps && net.isIP(host) === 0 ? { servername: host } : {}),
        };
        const request = (isHttps ? https : http).request(requestOptions);
        const onAbort = () => request.destroy(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
        // Belt and braces: whatever the socket connected to must pass the same check.
        request.on("socket", (socket: Socket) => {
            const verify = () => {
                const remote = socket.remoteAddress;
                if (!remote || (isBlockedAddress(remote) && !options.allowAddress?.(remote))) {
                    request.destroy(new WebFetchError("blocked_url", "The connection reached a blocked network address."));
                }
            };
            if (socket.remoteAddress) verify();
            else socket.once("connect", verify);
        });
        // Stays attached after the response so a late socket error is never unhandled.
        request.on("error", (error) => {
            signal.removeEventListener("abort", onAbort);
            reject(error instanceof WebFetchError || signal.aborted
                ? error
                : new WebFetchError("network", `The request failed: ${error.message}`));
        });
        request.on("response", (response) => {
            response.on("close", () => signal.removeEventListener("abort", onAbort));
            resolve(response);
        });
        request.end();
    });
}

async function readBody(response: http.IncomingMessage, maxBytes: number, signal: AbortSignal): Promise<{ body: Buffer; truncated: boolean }> {
    const encoding = String(response.headers["content-encoding"] ?? "identity").trim().toLowerCase();
    let stream: Readable = response;
    if (encoding === "gzip" || encoding === "x-gzip") stream = response.pipe(zlib.createGunzip());
    else if (encoding === "deflate") stream = response.pipe(zlib.createInflate());
    else if (encoding === "br") stream = response.pipe(zlib.createBrotliDecompress());
    else if (encoding !== "identity" && encoding !== "") {
        response.destroy();
        throw new WebFetchError("unsupported_content", `Unsupported content encoding: ${encoding}.`);
    }
    if (stream !== response) {
        response.on("error", (error) => stream.destroy(error));
        // A body cut short after the cap may make the decoder complain; that is not a failure.
        stream.on("error", () => {});
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    try {
        for await (const chunk of stream as AsyncIterable<Buffer>) {
            chunks.push(chunk);
            size += chunk.length;
            if (size > maxBytes) {
                truncated = true;
                break;
            }
        }
    } catch (error) {
        if (signal.aborted) throw error;
        throw error instanceof WebFetchError ? error : new WebFetchError("network", `Reading the response failed: ${(error as Error).message}`);
    } finally {
        response.destroy();
        if (stream !== response) stream.destroy();
    }
    const body = Buffer.concat(chunks, size);
    return { body: truncated ? body.subarray(0, maxBytes) : body, truncated };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then(
            (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
            (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
        );
    });
}
