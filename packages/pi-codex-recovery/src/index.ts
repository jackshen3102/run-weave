import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { getAgentDir, SettingsManager, VERSION, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { clampThinkingLevel, type Model, type Api, type Context, type SimpleStreamOptions, type StreamOptions } from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { processResponsesStream } from '@earendil-works/pi-ai/api/openai-responses-shared';
import { createGrammarToolInputProperties } from '@earendil-works/pi-ai/api/constrained-sampling';
import { buildBaseOptions } from '@earendil-works/pi-ai/api/simple-options';
import { getPiUserAgent } from '@earendil-works/pi-ai/utils/pi-user-agent';
import { isContextOverflow, isRetryableAssistantError } from '@earendil-works/pi-ai/compat';
import { buildRequestBody } from './request.js';
import { recover, RecoveryError, type RecordEvent, type SessionState } from './recovery.ts';
import { ResponseTransport } from './transport.ts';
import { emptyMessage, StreamAdapter } from './stream-adapter.ts';

export default function extension(pi: ExtensionAPI) {
  const base = openaiCodexProvider(); const transport = new ResponseTransport();
  let ctx: ExtensionContext | undefined; let state: SessionState = { transport: 'ws' };
  let session: string = randomUUID(); let busy = false; let active: AbortController | undefined;
  const agentDir = getAgentDir();
  // Explicit opt-in keeps the original isolated-profile contract intact.
  let sharedProfile = false;
  try { sharedProfile = JSON.parse(readFileSync(join(agentDir, 'recovery.json'), 'utf8')).profile === 'shared'; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  function guard() {
    if (VERSION !== '0.85.1') throw new Error('Codex recovery requires Pi 0.85.1; validate upgrades before use.');
    if (!ctx || ctx.mode !== 'tui') throw new Error('Codex recovery supports TUI mode only.');
    if (sharedProfile) return;
    const dir = realpathSync(agentDir);
    if (basename(dir) !== 'agent-codex-recovery' || dir === resolve(homedir(), '.pi/agent'))
      throw new Error('Codex recovery requires a separate agent-codex-recovery directory.');
    const settings = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: ctx.isProjectTrusted() });
    if (settings.getRetrySettings().enabled) throw new Error('Codex recovery requires retry.enabled=false in the effective configuration.');
  }
  function endpoint(model: Model<Api>) {
    let url = model.baseUrl;
    try {
      const config = JSON.parse(readFileSync(join(agentDir, 'recovery.json'), 'utf8'));
      if (config.baseUrl !== undefined) url = config.baseUrl;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname)))
      throw new Error('Recovery endpoint must use HTTPS or loopback HTTP.');
    if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Invalid recovery endpoint.');
    url = parsed.toString().replace(/\/$/, '');
    return url.endsWith('/codex/responses') ? url : url.endsWith('/codex') ? `${url}/responses` : `${url}/codex/responses`;
  }
  function log(event: RecordEvent | { event: string; kind?: string }) {
    if (!sharedProfile && basename(agentDir) !== 'agent-codex-recovery') return;
    // Explicit metadata only: never spread errors, tokens, model input, output or arbitrary codes.
    try { appendFileSync(join(agentDir, 'recovery.jsonl'), JSON.stringify({ at: Date.now(), session, ...event }) + '\n', { mode: 0o600 }); }
    catch { ctx?.ui.setStatus('codex-recovery', '恢复诊断无法写入'); }
  }
  function progress(event: RecordEvent) {
    log(event);
    const labels: Record<string, string> = { retry: `${event.transport.toUpperCase()} 重试 ${event.attempt}/5，连接中断，正在重新生成`,
      network_wait: `等待网络恢复（${Math.round((event.delayMs ?? 0) / 1000)} 秒，可按 Esc 取消）`,
      fallback: '已切换 SSE，继续恢复', success: '连接已恢复' };
    if (labels[event.event]) ctx?.ui.setStatus('codex-recovery', labels[event.event]);
  }
  function stream(model: Model<Api>, context: Context, options: StreamOptions = {}) {
    const adapter = new StreamAdapter(model);
    void (async () => {
      let ownsCall = false;
      try {
        guard(); if (busy) throw new Error('Concurrent model calls are not supported in this recovery session.');
        busy = true; ownsCall = true; active = new AbortController();
        const signal = options.signal ? AbortSignal.any([options.signal, active.signal]) : active.signal;
        const token = options.apiKey;
        if (!token) throw new Error('Use /login to sign in to OpenAI Codex.');
        let account: string;
        try { account = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())['https://api.openai.com/auth'].chatgpt_account_id; }
        catch { throw new Error('Invalid Codex credential. Use /login.'); }
        if (typeof account !== 'string' || !account) throw new Error('Missing Codex account. Use /login.');
        const grammar = createGrammarToolInputProperties(context.tools, model.compat && 'supportsOpenAIGrammarTools' in model.compat ? model.compat.supportsOpenAIGrammarTools ?? false : false);
        const cacheKey = createHash('sha256').update(session).digest('hex');
        let body: unknown = buildRequestBody(model, context, options, cacheKey, grammar);
        body = await options.onPayload?.(body, model) ?? body;
        const url = endpoint(model);
        const headers = new Headers(model.headers as HeadersInit);
        for (const [key, value] of Object.entries(options.headers ?? {})) {
          if (value === null) headers.delete(key);
          else headers.set(key, value);
        }
        headers.set('Authorization', `Bearer ${token}`); headers.set('chatgpt-account-id', account);
        headers.set('originator', 'pi'); headers.set('User-Agent', getPiUserAgent());
        headers.set('session-id', cacheKey); headers.set('x-client-request-id', cacheKey);
        const final = await recover(state, signal, async (mode, attemptSignal) => {
          const output = emptyMessage(model);
          headers.set('OpenAI-Beta', mode === 'ws' ? 'responses_websockets=2026-02-06' : 'responses=experimental');
          if (mode === 'sse') { headers.set('accept', 'text/event-stream'); headers.set('content-type', 'application/json'); }
          else { headers.delete('accept'); headers.delete('content-type'); }
          try {
            await processResponsesStream(transport.events(mode, { url, headers: Object.fromEntries(headers), body, session, signal: attemptSignal, onResponse: response => options.onResponse?.(response, model) }),
              output, adapter.sink(), model, { grammarToolInputProperties: grammar });
            if (output.stopReason === 'pending') throw new RecoveryError('Incomplete response stream', 'transient', 'stream');
            if (output.stopReason === 'error') throw new RecoveryError(output.errorMessage ?? 'Provider response failed', 'fatal', 'response');
            return output;
          } catch (error) { transport.close(session); throw error; }
        }, progress, () => adapter.update(emptyMessage(model)));
        adapter.finish(final); log({ event: 'terminal', kind: 'success' });
      } catch (error) {
        const output = emptyMessage(model);
        output.stopReason = (ownsCall && (active?.signal.aborted || options.signal?.aborted)) || (error instanceof RecoveryError && error.kind === 'aborted') ? 'aborted' : 'error';
        output.errorMessage = error instanceof Error ? error.message : 'Codex recovery failed';
        // Pi 0.85.1 exposes a text-based classifier, not a per-message retry veto.
        // Keep overflow available to native compaction. For other terminal failures,
        // show the cause in the TUI and return a non-transient final error so neither
        // agent turns nor summaries restart this already-completed recovery budget.
        if (sharedProfile && !isContextOverflow(output, model.contextWindow) && isRetryableAssistantError(output)) {
          ctx?.ui.notify(output.errorMessage, 'error');
          output.errorMessage = 'Codex 请求失败，自动恢复已结束。错误原因见上方提示；请稍后重新发起请求。';
          log({ event: 'outer_retry_suppressed' });
        }
        adapter.finish(output); log({ event: 'terminal', kind: output.stopReason });
      } finally {
        if (ownsCall) { busy = false; active = undefined; ctx?.ui.setStatus('codex-recovery', undefined); }
      }
    })();
    return adapter.stream;
  }
  function streamSimple(model: Model<Api>, context: Context, options: SimpleStreamOptions = {}) {
    const reasoning = options.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
    const full = { ...buildBaseOptions(model, context, options, options.apiKey),
      toolChoice: options.toolChoice, reasoningEffort: reasoning === 'off' ? undefined : reasoning };
    return stream(model, context, full);
  }
  // Shared profiles register only after the host mode is known. Headless modes
  // retain native provider registration and its resource-cleanup hooks entirely.
  if (!sharedProfile) pi.registerProvider({ ...base, stream, streamSimple });
  pi.on('session_start', (_event, context) => {
    ctx = context; session = context.sessionManager.getSessionId(); state = { transport: 'ws' }; transport.close();
    if (sharedProfile && context.mode !== 'tui') { log({ event: 'native_mode' }); return; }
    if (sharedProfile) pi.registerProvider({ ...base, stream, streamSimple });
    try { guard(); log({ event: 'ready' }); }
    catch (error) { context.ui.notify((error as Error).message, 'error'); log({ event: 'guard_rejected' }); }
  });
  pi.on('session_shutdown', () => { active?.abort(); transport.close(); });
}
