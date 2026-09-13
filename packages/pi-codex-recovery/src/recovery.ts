import { randomUUID } from 'node:crypto';

export type Transport = 'ws' | 'sse';
export type Kind = 'connection' | 'transient' | 'fatal' | 'fallback' | 'aborted';
export class RecoveryError extends Error {
  constructor(message: string, public kind: Kind, public phase: string,
    public status?: number, public code?: string, public retryAfterMs?: number) {
    super(message);
  }
}
export type RecordEvent = {
  event: string; call: string; transport: Transport; attempt?: number;
  delayMs?: number; kind?: Kind; phase?: string; status?: number;
};
export type SessionState = { transport: Transport };
export const aborted = () => new RecoveryError('Operation aborted', 'aborted', 'cancel');
export function checkAbort(signal: AbortSignal) { if (signal.aborted) throw aborted(); }
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); };
    const cancel = () => { finish(); reject(aborted()); };
    const timer = setTimeout(() => { finish(); resolve(); }, ms);
    signal.addEventListener('abort', cancel, { once: true });
  });
}
export function classify(error: unknown, phase = 'stream'): RecoveryError {
  if (error instanceof RecoveryError) return error;
  // Only typed connection causes during establishment qualify for the independent wait budget.
  let cause = error; const seen = new Set<unknown>();
  while (cause && typeof cause === 'object' && !seen.has(cause)) {
    seen.add(cause);
    const e = cause as { code?: string; cause?: unknown; name?: string };
    if (e.name === 'AbortError') return aborted();
    if (phase === 'connect' && ['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT'].includes(e.code ?? ''))
      return new RecoveryError('Connection failed', 'connection', phase, undefined, e.code);
    cause = e.cause;
  }
  return new RecoveryError('Connection interrupted', 'transient', phase);
}
export function apiError(status: number | undefined, payload: unknown, retryAfter?: string | null): RecoveryError {
  const p = payload as { error?: { code?: string; type?: string; message?: string }; code?: string; message?: string } | undefined;
  const code = p?.error?.code ?? p?.code ?? p?.error?.type;
  // Bodies remain ephemeral; diagnostic records never contain their text or arbitrary error codes.
  const message = p?.error?.message ?? p?.message ?? `Provider request failed (${status ?? 'stream'})`;
  let delay: number | undefined;
  if (retryAfter) {
    const seconds = Number(retryAfter);
    delay = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(retryAfter) - Date.now());
    if (!Number.isFinite(delay)) delay = undefined;
  }
  const terminal = ['insufficient_quota', 'usage_limit_reached', 'quota_exceeded', 'billing_hard_limit_reached', 'context_length_exceeded', 'invalid_request_error'];
  if (status === 401 || status === 403)
    return new RecoveryError('Authentication failed. Use /login to sign in to OpenAI Codex again.', 'fatal', 'response', status);
  if (terminal.includes(code ?? '')) return new RecoveryError(message, 'fatal', 'response', status, code);
  if (status === 426) return new RecoveryError(message, 'fallback', 'response', status);
  const temporary = ['rate_limit_exceeded', 'server_error', 'internal_server_error', 'websocket_connection_limit_reached', 'previous_response_not_found'];
  const retry = status === 429 || (status !== undefined && status >= 500) || temporary.includes(code ?? '');
  return new RecoveryError(message, retry ? 'transient' : 'fatal', 'response', status, code, delay);
}

export async function recover<T>(state: SessionState, signal: AbortSignal,
  attempt: (transport: Transport, signal: AbortSignal) => Promise<T>,
  emit: (event: RecordEvent) => void, reset: () => void): Promise<T> {
  const call = randomUUID(); let retries = 0; let networkRetries = 0;
  let networkDeadline: number | undefined; let networkDelay = 5000;
  const record = (data: Omit<RecordEvent, 'call' | 'transport'>) => emit({ ...data, call, transport: state.transport });
  for (;;) {
    checkAbort(signal);
    if (networkDeadline !== undefined && Date.now() >= networkDeadline)
      throw new RecoveryError('Network unavailable after 5 minutes. Try again when connected.', 'fatal', 'network_wait');
    const deadline = networkDeadline === undefined ? undefined : AbortSignal.timeout(Math.max(1, networkDeadline - Date.now()));
    const attemptSignal = deadline ? AbortSignal.any([signal, deadline]) : signal;
    record({ event: 'attempt', attempt: retries + 1 });
    try {
      const result = await attempt(state.transport, attemptSignal);
      checkAbort(signal); record({ event: 'success' }); return result;
    } catch (raw) {
      checkAbort(signal);
      if (deadline?.aborted) throw new RecoveryError('Network unavailable after 5 minutes. Try again when connected.', 'fatal', 'network_wait');
      const error = classify(raw);
      record({ event: 'failure', kind: error.kind, phase: error.phase, status: error.status });
      if (error.kind === 'fatal' || error.kind === 'aborted') throw error;
      if (error.retryAfterMs !== undefined && error.retryAfterMs > 60000)
        throw new RecoveryError('Provider asks to wait over 60 seconds. Try again later.', 'fatal', 'rate_limit');
      if (error.kind === 'connection') {
        networkDeadline ??= Date.now() + 300000;
        const delayMs = Math.min(networkDelay, Math.max(0, networkDeadline - Date.now()));
        record({ event: 'network_wait', attempt: ++networkRetries, delayMs });
        await sleep(delayMs, signal); networkDelay = Math.min(60000, networkDelay * 2); reset(); continue;
      }
      if (state.transport === 'ws' && (error.kind === 'fallback' || retries >= 5)) {
        state.transport = 'sse'; retries = 0; record({ event: 'fallback' }); reset(); continue;
      }
      if (retries >= 5 || error.kind === 'fallback') throw error;
      const delayMs = error.retryAfterMs ?? Math.floor(200 * 2 ** retries * (0.9 + Math.random() * 0.2));
      record({ event: 'retry', attempt: ++retries, delayMs });
      await sleep(Math.min(delayMs, networkDeadline === undefined ? delayMs : Math.max(0, networkDeadline - Date.now())), signal);
      reset();
    }
  }
}
