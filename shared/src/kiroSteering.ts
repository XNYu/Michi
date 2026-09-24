/** A model-authored explanation, not a native acknowledgement of execution. */
export interface SteeringReport {
  messageId: string;
  text: string;
  complete: boolean;
}

export type SteeringSegment =
  | { kind: 'text'; text: string }
  | { kind: 'report'; report: SteeringReport };

const PREFIX = '[STEERING steer-';
const NATIVE_ID = /^steer-(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i;
export const MAX_STEERING_REPORT_LENGTH = 8192;

/** Incremental, bounded scanner. Only native-ID markers at an unquoted line
 * start are metadata; fenced/indented code and inline examples remain prose. */
export class KiroSteeringParser {
  private header = '';
  private messageId = '';
  private body: string[] = [];
  private depth = 0;
  private escaped = false;
  private newline = false;
  private indent = 0;
  private linePhase: 'indent' | 'fence' | 'text' = 'indent';
  private fenceChar = '';
  private fenceCount = 0;
  private fenceTailWhitespace = true;
  private fence: { char: string; count: number } | null = null;

  private advanceMarkdown(ch: string): void {
    if (ch === '\n') {
      if (this.fenceCount >= 3) {
        if (!this.fence) this.fence = { char: this.fenceChar, count: this.fenceCount };
        else if (this.fence.char === this.fenceChar && this.fenceCount >= this.fence.count && this.fenceTailWhitespace) this.fence = null;
      }
      this.indent = 0;
      this.linePhase = 'indent';
      this.fenceChar = '';
      this.fenceCount = 0;
      this.fenceTailWhitespace = true;
    } else if (this.linePhase === 'indent') {
      if (ch === ' ' && this.indent < 3) this.indent++;
      else if (ch === '`' || ch === '~') {
        this.linePhase = 'fence';
        this.fenceChar = ch;
        this.fenceCount = 1;
      } else this.linePhase = 'text';
    } else if (this.linePhase === 'fence' && ch === this.fenceChar) {
      this.fenceCount++;
    } else {
      this.linePhase = 'text';
      if (!/\s/.test(ch)) this.fenceTailWhitespace = false;
    }
  }

  private report(complete: boolean): SteeringSegment {
    const report = { messageId: this.messageId, text: this.body.join('').trim(), complete };
    this.messageId = '';
    this.body = [];
    this.depth = 0;
    this.escaped = false;
    this.newline = false;
    return { kind: 'report', report };
  }

  push(chunk: string): SteeringSegment[] {
    const result: SteeringSegment[] = [];
    let visible: string[] = [];
    const emitReport = (complete: boolean) => {
      if (visible.length) result.push({ kind: 'text', text: visible.join('') });
      visible = [];
      result.push(this.report(complete));
    };
    for (const ch of chunk) {
      if (this.messageId) {
        // An unterminated marker cannot consume an unbounded following answer.
        if (this.body.length >= MAX_STEERING_REPORT_LENGTH || (ch === '\n' && this.newline)) {
          emitReport(false);
          visible.push(ch);
          this.advanceMarkdown(ch);
          continue;
        }
        if (ch === ']' && !this.escaped && this.depth === 0) {
          emitReport(true);
        } else {
          if (!this.escaped && ch === '[') this.depth++;
          if (!this.escaped && ch === ']') this.depth--;
          this.body.push(ch);
          this.escaped = ch === '\\' && !this.escaped;
          if (ch === '\n') this.newline = true;
          else if (!/\s/.test(ch)) this.newline = false;
        }
        // Marker content is not Markdown, but its newlines still delimit prose.
        if (ch === '\n') this.advanceMarkdown(ch);
        else this.linePhase = 'text';
        continue;
      }
      if (this.header) {
        this.header += ch;
        if (this.header.length <= PREFIX.length) {
          if (!PREFIX.startsWith(this.header)) {
            visible.push(this.header);
            this.header = '';
          }
        } else if (ch === ':' && NATIVE_ID.test(this.header.slice(10, -1))) {
          this.messageId = this.header.slice(10, -1);
          this.header = '';
        } else if (!/[a-f0-9-]/i.test(ch) || this.header.length > 52) {
          visible.push(this.header);
          this.header = '';
        }
        this.advanceMarkdown(ch);
        continue;
      }
      if (ch === '[' && this.linePhase === 'indent' && !this.fence) this.header = ch;
      else visible.push(ch);
      this.advanceMarkdown(ch);
    }
    if (visible.length) result.push({ kind: 'text', text: visible.join('') });
    return result;
  }

  finish(): SteeringSegment[] {
    if (this.messageId) return [this.report(false)];
    const text = this.header;
    this.header = '';
    return text ? [{ kind: 'text', text }] : [];
  }
}

export function extractKiroSteering(raw: string): { text: string; reports: SteeringReport[] } {
  const parser = new KiroSteeringParser();
  const text: string[] = [];
  const reports: SteeringReport[] = [];
  for (const segment of [...parser.push(raw), ...parser.finish()]) {
    if (segment.kind === 'text') text.push(segment.text);
    else reports.push(segment.report);
  }
  return { text: text.join(''), reports };
}

export function parseSteeringReports(value: unknown): SteeringReport[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || typeof item.messageId !== 'string' || !NATIVE_ID.test(item.messageId) || typeof item.text !== 'string') return [];
    return [{ messageId: item.messageId, text: item.text.slice(0, MAX_STEERING_REPORT_LENGTH), complete: item.complete === true }];
  });
}

export function mergeSteeringReports(previous: readonly SteeringReport[] = [], incoming: readonly SteeringReport[]): SteeringReport[] {
  const reports = new Map(previous.map((report) => [report.messageId, report]));
  for (const report of incoming) {
    if (!reports.get(report.messageId)?.complete || report.complete) reports.set(report.messageId, report);
  }
  return [...reports.values()];
}
