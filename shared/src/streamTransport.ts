// Transport envelopes only. The payload remains the existing byte-ordered SSE.
export type StreamTransportRequest =
  | { type: 'open'; id: string; path: string; method: 'GET' | 'POST'; body?: string }
  | { type: 'cancel'; id: string };

export type StreamTransportResponse =
  | { type: 'headers'; id: string; status: number }
  | { type: 'data'; id: string; text: string }
  | { type: 'end'; id: string }
  | { type: 'error'; id: string; message: string };

export const STREAM_TRANSPORT_PATH = '/stream-transport';
export const STREAM_TRANSPORT_PROTOCOL = 'websocket-v1';
// Keep the HTTP JSON body limit; allow for JSON-string escaping in the envelope.
export const STREAM_MAX_BODY_BYTES = 50 * 1024 * 1024;
export const STREAM_MAX_FRAME_BYTES = 2 * STREAM_MAX_BODY_BYTES + 64 * 1024;
