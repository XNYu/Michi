import { frameText, TOOL_CONTENT_MAX, TOOL_TITLE_MAX, type AcpUpdate } from './crewFrames';
import type { CrewChatFrame, CrewEvent, CrewGateway, CrewHistoryRow } from './gatewayTypes';

interface Card { id: string; title: string; kind?: string; input?: string; output?: string; status: string; sent?: string }

/** Join SSE rows to WS tools by the server's unique row timestamp and stored
 * tool_call_id. Never guess by tool title, relative arrival order, or position. */
export class CrewTurn {
    private closed = false;
    private readonly rows = new Map<string, CrewChatFrame>();
    private readonly cards = new Map<string, Card>();
    private readonly rowIds = new Map<string, string>();
    private readonly aliases = new Map<string, string>();
    private readonly pending = new Map<string, Record<string, unknown>>();
    private reconciliation?: Promise<void>;
    private dirty = false;
    private title = '';
    private contextPercentage?: number;
    private plan?: string;

    constructor(private readonly slot: string, private readonly gateway: CrewGateway,
        private readonly emit: (update: AcpUpdate) => void, private readonly nextId: () => string) {}

    event(event: CrewEvent): void {
        if (this.closed) return;
        if (event.type === 'reconnected') { void this.reconcile(); return; }
        if (event.type === 'slot_title' && event.data.key === this.slot) {
            if (typeof event.data.title === 'string') this.title = event.data.title.slice(0, 500);
            return;
        }
        if (event.data.slot !== this.slot) return;
        if (event.type === 'context_usage') { this.context(event.data.pct); return; }
        if (event.type === 'todo_update') { this.todo(event.data.todo); return; }
        const id = event.data.tool_call_id;
        if (typeof id !== 'string' || !id || id.length > 4096) return;
        if (!this.pending.has(id) && this.pending.size >= 2048) return;
        const prior = this.pending.get(id) ?? {};
        const fields: Record<string, string> = {};
        for (const key of ['tool', 'kind', 'input_preview', 'output']) {
            if (event.data[key] !== undefined) fields[key] = frameText(event.data[key]).slice(0, TOOL_CONTENT_MAX);
        }
        this.pending.set(id, { ...prior, ...fields });
        const card = this.cards.get(this.aliases.get(id) ?? id);
        if (card) this.enrich(card, this.pending.get(id)!);
    }

    async tool(frame: CrewChatFrame): Promise<void> {
        if (this.closed || this.rows.size >= 2048) return;
        const key = frame.ts || this.nextId();
        if (this.rows.has(key)) return;
        this.rows.set(key, { ...frame, content: frameText(frame.content).slice(0, TOOL_CONTENT_MAX) });
        // Render immediately; fetching detail must not stall text streaming.
        this.materialize(key, frame);
        void this.reconcile();
    }

    reconcile(): Promise<void> {
        if (this.closed || !this.gateway.getSlot) return this.reconciliation ?? Promise.resolve();
        this.dirty = true;
        if (this.reconciliation) return this.reconciliation;
        this.reconciliation = (async () => {
            while (this.dirty && !this.closed) {
                this.dirty = false;
                try {
                    let before: number | undefined;
                    // Bounded pagination covers tool-heavy turns and reconnect gaps.
                    const matched = new Set<string>();
                    for (let page = 0; page < 5; page++) {
                        const detail = await this.gateway.getSlot!(this.slot, 500, before);
                        if (this.closed) return;
                        if (page === 0) {
                            if (typeof detail.title === 'string') this.title = detail.title.slice(0, 500);
                            if (detail.context_stale === false) this.context(detail.context_pct);
                            this.todo(detail.todo);
                        }
                        for (const row of detail.messages) {
                            if (typeof row.ts !== 'string' || !this.rows.has(row.ts)) continue;
                            matched.add(row.ts);
                            this.materialize(row.ts, row);
                        }
                        if (matched.size >= this.rows.size || !detail.has_more || !detail.next_before || detail.next_before === before) break;
                        before = detail.next_before;
                    }
                } catch { /* Preserve the SSE-only fallback; never fail the text turn. */ }
            }
        })().finally(() => { this.reconciliation = undefined; });
        return this.reconciliation;
    }

    private context(value: unknown): void {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100 || value === this.contextPercentage) return;
        this.contextPercentage = value;
        // Crew supplies a percentage, not reliable billing/cost telemetry.
        this.emit({ sessionUpdate: 'context_usage', contextUsagePercentage: value });
    }

    private todo(value: unknown): void {
        if (!value || typeof value !== 'object' || !Array.isArray((value as any).tasks)) return;
        const entries = (value as { tasks: unknown[] }).tasks.slice(0, 100).flatMap((task) => {
            if (!task || typeof task !== 'object' || typeof (task as any).text !== 'string') return [];
            const row = task as { text: string; completed?: unknown };
            return [{ content: row.text.slice(0, 2000), priority: 'medium', status: row.completed === true ? 'completed' : 'pending' }];
        });
        const serialized = JSON.stringify(entries);
        if (serialized === this.plan) return;
        this.plan = serialized;
        this.emit({ sessionUpdate: 'plan', entries });
    }

    private materialize(key: string, frame: CrewChatFrame | CrewHistoryRow): void {
        const meta = frame.meta ?? {};
        const nativeId = typeof meta.tool_call_id === 'string' && meta.tool_call_id ? meta.tool_call_id : undefined;
        const existing = this.rowIds.get(key);
        const id = existing ?? (nativeId ? this.aliases.get(nativeId) : undefined) ?? `crew-row-${this.nextId()}`;
        // An approval row is another view of the same call, not another tool.
        const text = frameText(frame.content);
        if (!nativeId && /^[✅]/u.test(text)) return;
        this.rowIds.set(key, id);
        if (nativeId) this.aliases.set(nativeId, id);
        let card = this.cards.get(id);
        if (!card) {
            card = { id, title: text.split('\n')[0].replace(/^[🔧✅]\s*/u, '').slice(0, TOOL_TITLE_MAX) || 'Tool',
                status: text.startsWith('🚫') ? 'failed' : 'in_progress',
                ...(!nativeId ? { output: text.slice(0, TOOL_CONTENT_MAX) } : {}),
            };
            this.cards.set(id, card);
        }
        const data = { ...(nativeId ? this.pending.get(nativeId) : {}), ...meta };
        this.enrich(card, data);
    }

    private enrich(card: Card, data: Record<string, unknown>): void {
        if (typeof data.tool === 'string') card.title = data.tool.slice(0, TOOL_TITLE_MAX);
        if (typeof data.kind === 'string') card.kind = data.kind;
        const input = data.input_preview ?? data.input;
        if (input !== undefined) card.input = frameText(input).slice(0, TOOL_CONTENT_MAX);
        if (data.output !== undefined) card.output = frameText(data.output).slice(0, TOOL_CONTENT_MAX);
        // Gateway drops the terminal/error flag and can publish partial results.
        // Keep the card running until the authoritative SSE turn boundary.
        const value = JSON.stringify([card.title, card.kind, card.input, card.output, card.status]);
        if (value === card.sent) return;
        this.emit({ sessionUpdate: card.sent ? 'tool_call_update' : 'tool_call', toolCallId: card.id,
            title: card.title, kind: card.kind ?? 'other', status: card.status,
            ...(card.input !== undefined ? { rawInput: card.input } : {}),
            ...(card.output !== undefined ? { rawOutput: card.output } : {}),
        });
        card.sent = value;
    }

    async finish(cancelled: boolean): Promise<void> {
        if (this.closed) return;
        if (!cancelled) await this.reconcile();
        if (this.closed) return;
        this.closed = true;
        for (const card of this.cards.values()) {
            if (card.status === 'in_progress') card.status = cancelled ? 'failed' : 'completed';
            this.enrich(card, {});
        }
        if (!cancelled && this.title) this.emit({ sessionUpdate: 'session_info_update', title: this.title });
        this.pending.clear();
    }
}
