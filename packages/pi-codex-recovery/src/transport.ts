import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { resolveHttpProxyUrlForTarget } from '@earendil-works/pi-ai/utils/node-http-proxy';
import type { ResponseStreamEvent } from 'openai/resources/responses/responses.js';
import { apiError, aborted, checkAbort, classify, RecoveryError, type Transport } from './recovery.ts';

type Request = { url: string; headers: Record<string, string>; body: unknown; session: string; signal: AbortSignal; onResponse?: (response: { status: number; headers: Record<string, string> }) => Promise<void> | void };
type Connection = { socket: WebSocket; key: string; expiry?: NodeJS.Timeout };
export class ResponseTransport {
  private connections = new Map<string, Connection>();
  close(session?: string) {
    for (const [id, entry] of this.connections) if (!session || id === session) {
      clearTimeout(entry.expiry); entry.socket.terminate(); this.connections.delete(id);
    }
  }
  async *events(transport: Transport, request: Request): AsyncGenerator<ResponseStreamEvent> {
    const source = transport === 'ws' ? this.websocket(request) : this.sse(request);
    let completed = false;
    for await (const event of source) {
      const e = event as ResponseStreamEvent & {
        status?: number; status_code?: number; headers?: Record<string, string>;
        response?: { status?: string };
      };
      if (e.type === 'error' || e.type === 'response.failed')
        throw apiError(e.status ?? e.status_code, e.response ?? e, e.headers?.['retry-after']);
      if (['response.done', 'response.completed', 'response.incomplete'].includes(e.type)) {
        if (e.response?.status === 'failed' || e.response?.status === 'cancelled')
          throw apiError(undefined, e.response);
        completed = true;
        yield { ...e, type: 'response.completed' } as ResponseStreamEvent;
        return;
      }
      yield event;
    }
    if (!completed) throw new RecoveryError('Stream ended before response completed', 'transient', 'stream');
  }
  private async *sse(r: Request): AsyncGenerator<ResponseStreamEvent> {
    checkAbort(r.signal);
    const ctrl = new AbortController();
    const signal = AbortSignal.any([r.signal, ctrl.signal]);
    let timer = setTimeout(() => ctrl.abort(), 300000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let phase = 'connect';
    try {
      const response = await fetch(r.url, { method: 'POST', headers: r.headers, body: JSON.stringify(r.body), signal });
      phase = 'response';
      await r.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) });
      if (!response.ok) {
        let payload: unknown;
        try { payload = await response.json(); } catch { payload = undefined; }
        throw apiError(response.status, payload, response.headers.get('retry-after'));
      }
      reader = response.body?.getReader();
      if (!reader) throw new RecoveryError('Empty response stream', 'transient', 'stream');
      phase = 'stream';
      const decoder = new TextDecoder(); let buffer = ''; let data: string[] = [];
      for (;;) {
        clearTimeout(timer); timer = setTimeout(() => ctrl.abort(), 300000);
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        if (buffer.length > 16 * 1024 * 1024) throw new RecoveryError('SSE event too large', 'fatal', phase);
        let newline: number;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).replace(/\r$/, ''); buffer = buffer.slice(newline + 1);
          if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
          else if (line === '' && data.length) {
            const json = data.join('\n'); data = [];
            if (json !== '[DONE]') yield JSON.parse(json);
          }
        }
      }
    } catch (error) {
      if (r.signal.aborted) throw aborted();
      if (ctrl.signal.aborted) throw new RecoveryError('Response timed out', 'transient', phase);
      throw classify(error, phase);
    } finally {
      clearTimeout(timer); await reader?.cancel().catch(() => {}); ctrl.abort();
    }
  }
  private async connect(r: Request): Promise<WebSocket> {
    const url = r.url.replace(/^http/, 'ws');
    const key = createHash('sha256').update(url + JSON.stringify(r.headers)).digest('hex');
    const entry = this.connections.get(r.session);
    if (entry?.key === key && entry.socket.readyState === WebSocket.OPEN) {
      clearTimeout(entry.expiry); return entry.socket;
    }
    this.close(r.session); checkAbort(r.signal);
    const proxy = resolveHttpProxyUrlForTarget(r.url);
    const socket = new WebSocket(url, { headers: r.headers, handshakeTimeout: 15000,
      maxPayload: 16 * 1024 * 1024, ...(proxy ? { agent: new HttpsProxyAgent(proxy) } : {}) });
    // Keep a listener even between requests, when ws may emit an asynchronous error.
    socket.on('error', () => {});
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { r.signal.removeEventListener('abort', cancel); socket.off('open', open); socket.off('error', error); socket.off('unexpected-response', unexpected); };
      const fail = (e: unknown) => { cleanup(); socket.terminate(); reject(e); };
      const cancel = () => fail(aborted());
      const open = () => { cleanup(); resolve(); };
      const error = (e: unknown) => fail(classify(e, 'connect'));
      const unexpected = (_request: unknown, response: import('node:http').IncomingMessage) => {
        const status = response.statusCode;
        // Handshake statuses are sufficient for routing; never retain a handshake body.
        const wait = response.headers['retry-after']; response.resume();
        const e = apiError(status, undefined, Array.isArray(wait) ? wait[0] : wait);
        // Codex retries generic WS handshake results such as 404 before falling back.
        if (e.kind === 'fatal' && status !== 401 && status !== 403) e.kind = 'transient';
        fail(e);
      };
      socket.once('open', open); socket.once('error', error); socket.once('unexpected-response', unexpected);
      r.signal.addEventListener('abort', cancel, { once: true });
      if (r.signal.aborted) cancel();
    });
    this.connections.set(r.session, { socket, key }); return socket;
  }
  private async *websocket(r: Request): AsyncGenerator<ResponseStreamEvent> {
    const socket = await this.connect(r);
    const queue: (ResponseStreamEvent | Error)[] = []; let wake: (() => void) | undefined;
    const enqueue = (value: ResponseStreamEvent | Error) => { queue.push(value); wake?.(); };
    const cancel = () => enqueue(aborted());
    const error = (e: unknown) => enqueue(classify(e));
    const close = () => enqueue(new RecoveryError('WebSocket closed before completion', 'transient', 'stream'));
    const message = (data: WebSocket.RawData) => {
      try { enqueue(JSON.parse(data.toString())); } catch { enqueue(new RecoveryError('Invalid WebSocket event', 'transient', 'stream')); }
    };
    socket.on('message', message); socket.on('error', error); socket.on('close', close);
    r.signal.addEventListener('abort', cancel, { once: true });
    try {
      checkAbort(r.signal);
      socket.send(JSON.stringify({ ...(r.body as object), type: 'response.create' }));
      for (;;) {
        checkAbort(r.signal);
        if (!queue.length) await new Promise<void>((resolve) => {
          const timer = setTimeout(() => enqueue(new RecoveryError('WebSocket stream idle timeout', 'transient', 'stream')), 300000);
          wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
        });
        const next = queue.shift()!;
        if (next instanceof Error) throw next;
        yield next;
      }
    } finally {
      socket.off('message', message); socket.off('error', error); socket.off('close', close);
      r.signal.removeEventListener('abort', cancel);
      const entry = this.connections.get(r.session);
      if (entry) { entry.expiry = setTimeout(() => this.close(r.session), 60000); entry.expiry.unref(); }
    }
  }
}
