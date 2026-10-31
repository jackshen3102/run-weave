import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { ScreenAgentEvent, ScreenAgentEventPage } from '@runweave/shared/screen-recording';
import type { CodexRolloutLifecycleReader } from '../codex/lifecycle-reader.js';
import { ConversationReadError, conversationText } from './conversation-source.js';

/** Bounded native-event page. No whole conversation scan and no copied transcript. */
export class AnalysisEvidenceReader {
  constructor(private readonly paths: CodexRolloutLifecycleReader) {}
  async read(threadID: string, projectID: string | null, cursor: string | undefined): Promise<ScreenAgentEventPage> {
    const file = await this.paths.findThreadPath(threadID);
    if (!file) return { events: [],nextCursor: cursor ?? '',coverage: 'unavailable',bytes: 0 };
    const handle = await open(file,'r');
    try {
      const info = await handle.stat();
      const identity = createHash('sha256').update(`${threadID}:${info.dev}:${info.ino}:${info.birthtimeMs}`).digest('hex');
      const prefix = Buffer.alloc(Math.min(info.size,128*1024));
      await handle.read(prefix,0,prefix.length,0);
      const first = prefix.toString('utf8').split('\n')[0]!;
      let metadata: { type?: string; payload?: { id?: string; source?: unknown } };
      try { metadata = JSON.parse(first); } catch { throw new ConversationReadError(503,'SOURCE_IDENTITY_UNAVAILABLE','来源身份暂不可读'); }
      if (metadata.type !== 'session_meta' || metadata.payload?.id !== threadID) throw new ConversationReadError(409,'SOURCE_CHANGED','来源身份变化');
      let offset = 0, skip = false, missing = false;
      let calls: Record<string,string> = {};
      let derived = metadata.payload?.source === 'screen-analysis' || metadata.payload?.source === 'daily-record';
      if (cursor) {
        try {
          const c = JSON.parse(Buffer.from(cursor,'base64url').toString()) as { identity: string; offset: number; skip: boolean; missing?: boolean; derived?: boolean; calls?: Record<string,string> };
          if (c.identity !== identity || !Number.isSafeInteger(c.offset) || c.offset < 0 || c.offset > info.size) throw new Error();
          offset = c.offset; skip = c.skip === true; missing = c.missing === true; derived ||= c.derived === true;
          if (c.calls && Object.keys(c.calls).length <= 3 && Object.entries(c.calls).every(([id,name]) => id.length <= 128 && typeof name === 'string' && ['exec_command','shell_command','functions.exec_command','functions.shell_command'].includes(name))) calls = c.calls;
        } catch { throw new ConversationReadError(409,'SOURCE_CHANGED','来源游标已失效'); }
      }
      const buffer = Buffer.alloc(Math.min(1024*1024,info.size-offset));
      const { bytesRead } = await handle.read(buffer,0,buffer.length,offset);
      const events: ScreenAgentEvent[] = []; let bytes = 0, consumed = 0, truncated = false;
      while (consumed < bytesRead) {
        const newline = buffer.indexOf(10,consumed);
        if (newline < 0) {
          if (bytesRead === 1024*1024) { consumed = bytesRead; skip = true; truncated = true; }
          break;
        }
        const start = consumed, end = newline+1;
        if (skip) { skip = false; truncated = true; consumed = end; continue; }
        if (end-start > 64*1024) { truncated = true; consumed = end; continue; }
        let row: Record<string, unknown>;
        try { row = JSON.parse(buffer.subarray(start,newline).toString('utf8')) as Record<string,unknown>; } catch { truncated = true; consumed = end; continue; }
        const item = row.payload as Record<string,unknown> | undefined;
        if (row.type !== 'response_item' || !item || typeof item !== 'object') { consumed = end; continue; }
        // Recognize the explicit first-party reporting invocation in native
        // user input, never mentions inside assistant/tool output. Other exec
        // sessions remain eligible background work.
        if (item.type === 'message' && item.role === 'user' && metadata.payload?.source === 'exec') {
          const request = conversationText(item.content).trim();
          if (request === '使用 daily-record 技能，按本机配置补齐截至昨天的每日事实并发布到随记。' || request.startsWith('[runweave-derived:screen-analysis]')) derived = true;
        }
        if (item.type === 'function_call' && typeof item.call_id === 'string' && item.call_id.length <= 128 && typeof item.name === 'string' && ['exec_command','shell_command','functions.exec_command','functions.shell_command'].includes(item.name)) {
          calls[item.call_id] = item.name;
          if (Object.keys(calls).length > 3) delete calls[Object.keys(calls)[0]!];
        }
        const assistant = item.type === 'message' && item.role === 'assistant' && [undefined,'commentary','final','final_answer'].includes(item.phase as string | undefined) && [undefined,'commentary','final','final_answer'].includes(item.channel as string | undefined);
        const tool = ['function_call_output','custom_tool_call_output'].includes(String(item.type));
        if (!assistant && !tool) { consumed = end; continue; }
        const text = tool ? (typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '')) : conversationText(item.content);
        const occurredAtMs = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
        if (!text || !Number.isFinite(occurredAtMs)) { consumed = end; continue; }
        let independentSuccess = false;
        const callID = typeof item.call_id === 'string' ? item.call_id : '';
        if (tool && ['exec_command','shell_command','functions.exec_command','functions.shell_command'].includes(calls[callID] ?? '')) {
          try {
            const receipt = typeof item.output === 'string' ? JSON.parse(item.output) : item.output;
            independentSuccess = receipt !== null && typeof receipt === 'object' && receipt.exit_code === 0 && typeof receipt.output === 'string';
          } catch { /* Free text and unpaired output never prove command success. */ }
        }
        const nativeID = typeof item.id === 'string' ? item.id : `${offset+start}:${String(item.call_id ?? item.type)}`;
        const event: ScreenAgentEvent = { id: createHash('sha256').update(`codex:${threadID}:${nativeID}`).digest('hex'),provider: 'codex',threadID,eventID: nativeID,projectID,occurredAtMs,kind: tool ? 'tool' : 'assistant',text,derived,independentSuccess };
        // Tool output is evidence, but success classification needs the actual
        // call/receipt relationship. Never infer it from a success-looking string.
        const cost = Buffer.byteLength(JSON.stringify(event));
        if (cost > 24000) { truncated = true; consumed = end; continue; }
        if (bytes+cost > 24000) break;
        events.push(event); bytes += cost; consumed = end;
      }
      return { events,nextCursor: Buffer.from(JSON.stringify({ identity,offset: offset+consumed,skip,derived,calls,missing: missing || truncated })).toString('base64url'),coverage: missing || truncated || offset+consumed < info.size ? 'partial' : 'complete',bytes,sourceVersion: identity };
    } finally { await handle.close(); }
  }
}
