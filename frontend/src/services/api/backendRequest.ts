import { backendRequestUrl, connectionIdFromApiUrl, mapBackendPayload } from '../../config/backendIdentity';
import { backendConnectionGeneration, backendConnectionUnavailable, markBackendConnectionUnavailable } from '../../config/backendConnectionState';

export function backendRequestOptions(url: string, options: RequestInit = {}): RequestInit {
  if (typeof options.body !== 'string') return options;
  const connectionId = connectionIdFromApiUrl(url);
  // Only JSON API bodies carry entity references. Binary uploads stay opaque.
  let body: unknown;
  try { body = JSON.parse(options.body); } catch { return options; }
  return { ...options, body: JSON.stringify(mapBackendPayload(body, connectionId, 'server')) };
}

/** The connection captured in the request also owns every returned reference. */
export async function backendFetch(url: string, options?: RequestInit): Promise<Response> {
  const connectionId = connectionIdFromApiUrl(url);
  const generation = backendConnectionGeneration(connectionId);
  if (backendConnectionUnavailable(connectionId) && options?.method && options.method !== 'GET') {
    throw new Error('Remote connection is unavailable');
  }
  let response: Response;
  try { response = await globalThis.fetch(backendRequestUrl(url), backendRequestOptions(url, options)); }
  catch (error) {
    if (error instanceof TypeError) markBackendConnectionUnavailable(connectionId);
    throw error;
  }
  if ([502, 503, 504].includes(response.status)) markBackendConnectionUnavailable(connectionId);
  if (connectionId === 'local') return response;
  const json = response.json.bind(response);
  Object.defineProperty(response, 'json', {
    value: async () => {
      let body: unknown;
      try { body = await json(); }
      catch (error) {
        if (error instanceof TypeError && !options?.signal?.aborted) markBackendConnectionUnavailable(connectionId);
        throw error;
      }
      if (response.ok && generation !== backendConnectionGeneration(connectionId)) {
        throw new DOMException('Remote connection changed while reading data', 'AbortError');
      }
      return mapBackendPayload(body, connectionId, 'renderer');
    },
  });
  return response;
}

/** Keep streamed references in the same connection scope as ordinary JSON. */
export function backendStreamResponse(response: Response, connectionId: string,
  generation = backendConnectionGeneration(connectionId), signal?: AbortSignal | null): Response {
  if (connectionId === 'local' || !response.ok || !response.body) return response;
  const reader = response.body.getReader();
  const source = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close(); else controller.enqueue(value);
      } catch (error) {
        if (!signal?.aborted) markBackendConnectionUnavailable(connectionId);
        controller.error(error);
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = '';
  const stream = source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (generation !== backendConnectionGeneration(connectionId)) {
        throw new DOMException('Remote connection changed while streaming', 'AbortError');
      }
      pending += decoder.decode(chunk, { stream: true });
      let boundary: number;
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const lines = frame.split('\n');
        const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
        let mapped = frame;
        if (data) {
          let parsed: unknown;
          try { parsed = JSON.parse(data); } catch { controller.enqueue(encoder.encode(frame + '\n\n')); continue; }
          mapped = lines.filter(line => !line.startsWith('data:')).join('\n')
            + '\ndata: ' + JSON.stringify(mapBackendPayload(parsed, connectionId, 'renderer'));
        }
        controller.enqueue(encoder.encode(mapped + '\n\n'));
      }
    },
    flush(controller) { if (pending) controller.enqueue(encoder.encode(pending + decoder.decode())); },
  }));
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}
