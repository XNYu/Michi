import WebSocket from 'ws';
import type { CrewEvent } from './gatewayTypes';

/** A shared, app-authenticated socket. No owner token or broad event scope. */
export class CrewEventStream {
    private socket?: WebSocket;
    private connecting?: Promise<void>;
    private retry?: NodeJS.Timeout;
    private attempt = 0;
    private closed = false;
    private refused = false;
    private authFailures = 0;
    private readonly listeners = new Map<string, Set<(event: CrewEvent) => void>>();

    constructor(private readonly options: {
        url: string;
        cookie: () => Promise<string>;
        invalidate: () => void;
        connectMs?: number;
        retryMs?: number;
    }) {}

    async subscribe(slot: string, receive: (event: CrewEvent) => void): Promise<() => void> {
        if (this.closed) return () => {};
        if (!this.listeners.size) { this.refused = false; this.authFailures = 0; }
        const listeners = this.listeners.get(slot) ?? new Set();
        listeners.add(receive);
        this.listeners.set(slot, listeners);
        // SSE is authoritative: an unavailable socket must not prevent a turn.
        await this.connect().catch(() => {});
        return () => {
            listeners.delete(receive);
            if (!listeners.size) this.listeners.delete(slot);
            if (!this.listeners.size) {
                if (this.retry) clearTimeout(this.retry);
                this.retry = undefined;
                this.socket?.close();
                this.socket = undefined;
            }
        };
    }

    private connect(): Promise<void> {
        if (this.connecting) return this.connecting;
        if (this.closed || !this.listeners.size || this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
        this.connecting = this.open().finally(() => { this.connecting = undefined; });
        return this.connecting;
    }

    private async open(): Promise<void> {
        try {
            const cookie = await this.options.cookie();
            if (this.closed || !this.listeners.size) return;
            await new Promise<void>((resolve, reject) => {
                const ws = new WebSocket(this.options.url, {
                    headers: { Cookie: cookie },
                    handshakeTimeout: this.options.connectMs ?? 3000,
                    maxPayload: 2 * 1024 * 1024,
                    followRedirects: false,
                });
                this.socket = ws;
                let registered = false;
                const timer = setTimeout(() => { ws.terminate(); reject(new Error('Crew WS not ready')); }, this.options.connectMs ?? 3000);
                const fail = () => { clearTimeout(timer); reject(new Error('Crew WS unavailable')); };
                ws.on('message', (bytes) => {
                    if (this.closed || this.socket !== ws) return;
                    let event: CrewEvent;
                    try { event = JSON.parse(bytes.toString()); } catch { return; }
                    if (!event || typeof event.type !== 'string') return;
                    // The upgrade precedes registration. Wait for a server snapshot,
                    // otherwise a very fast first tool could precede our subscription.
                    if (!registered && (event.type === 'slots' || event.type === 'dashboard')) {
                        registered = true;
                        clearTimeout(timer);
                        this.attempt = 0;
                        this.authFailures = 0;
                        resolve();
                        for (const callbacks of this.listeners.values()) {
                            for (const callback of callbacks) callback({ type: 'reconnected', data: {} });
                        }
                    }
                    if (!['tool_call', 'tool_result', 'slot_title', 'context_usage', 'todo_update'].includes(event.type)) return;
                    if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return;
                    const slot = event.type === 'slot_title' ? event.data.key : event.data.slot;
                    if (typeof slot !== 'string') return;
                    for (const callback of this.listeners.get(slot) ?? []) callback(event);
                });
                ws.on('unexpected-response', (_req, res) => {
                    if (res.statusCode === 401 || res.headers['x-auth-required'] === 'true') {
                        this.options.invalidate();
                        if (++this.authFailures > 1) this.refused = true;
                    }
                    else if (res.statusCode === 403) this.refused = true;
                    res.resume();
                    ws.terminate();
                    fail();
                });
                ws.on('error', fail);
                ws.on('close', (code) => {
                    fail();
                    if (this.socket !== ws) return;
                    this.socket = undefined;
                    // Revocation is not a transient network failure. Try again
                    // only on a subsequent prompt, never repeatedly while disabled.
                    if (code === 1008) this.refused = true;
                    this.scheduleReconnect();
                });
            });
        } catch (error) {
            if ((error as { status?: number })?.status === 403) this.refused = true;
            this.scheduleReconnect();
            throw error;
        }
    }

    private scheduleReconnect(): void {
        if (this.closed || this.refused || !this.listeners.size || this.retry) return;
        const delay = Math.min((this.options.retryMs ?? 500) * 2 ** Math.min(this.attempt++, 5), 10_000);
        this.retry = setTimeout(() => {
            this.retry = undefined;
            void this.connect().catch(() => {});
        }, delay);
        this.retry.unref();
    }

    close(): void {
        this.closed = true;
        this.listeners.clear();
        if (this.retry) clearTimeout(this.retry);
        this.socket?.terminate();
        this.socket = undefined;
    }
}
