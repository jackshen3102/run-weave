import { useEffect, useRef, useState } from 'react';
import { useMemoizedFn } from 'ahooks';
import type { ScreenConversationLink, ScreenRecordingStatus } from '@runweave/shared/screen-recording';
import type { ConversationTarget } from '@runweave/shared/terminal/conversation';
import { requestJson } from '../../services/http';
import { getTerminalSession } from '../../services/terminal/sessions';
import { openHandoffConversation } from '../terminal/conversation/navigation';

export function useScreenConversationLink(runtime: { scope: string; apiBase: string; token: string | null }, navigate: (path: string) => void) {
  const [notice, setNotice] = useState<string | null>(null);
  const current = useRef(runtime); current.current = runtime;
  const sequence = useRef(0);
  const open = useMemoizedFn(async (link: ScreenConversationLink) => {
    const ticket = ++sequence.current;
    const started = current.current;
    const isCurrent = () => ticket === sequence.current && current.current.scope === started.scope && current.current.token === started.token;
    try {
      if (!started.token) throw new Error('请先登录来源电脑，然后从事项重新打开会话');
      const headers = { Authorization: `Bearer ${started.token}` };
      const status = await requestJson<ScreenRecordingStatus>(started.apiBase, '/api/screen-recording/status', { headers, signal: AbortSignal.timeout(5000) });
      if (status.availability !== 'ready') throw new Error('来源电脑的 ScreenJournal 暂不可用，文字事项保留');
      if (status.deviceID !== link.deviceID) throw new Error('当前连接不是事项来源电脑，请切换连接后重试');
      const target = await requestJson<ConversationTarget | null>(started.apiBase,
        `/api/screen-recording/analysis/conversations/${encodeURIComponent(link.threadID)}?provider=${encodeURIComponent(link.provider)}`,
        { headers, signal: AbortSignal.timeout(5000) });
      if (!target || target.threadId !== link.threadID || target.provider !== link.provider) throw new Error('会话来源已变化或不可用，文字事项保留');
      const session = await getTerminalSession(started.apiBase, started.token, target.terminalSessionId);
      if (!isCurrent()) return;
      await openHandoffConversation({ origin: { target, provider: 'codex', messageId: '' }, projectId: session.projectId,
        runtime: { ...started, token: started.token }, navigate, isCurrent });
      if (isCurrent()) setNotice(null);
    } catch (error) {
      if (isCurrent()) setNotice(error instanceof Error ? error.message : '会话来源不可用，文字事项保留');
    }
  });
  const invalidate = useMemoizedFn(() => { ++sequence.current; });
  useEffect(() => {
    const stop = window.electronAPI?.onScreenConversationOpen?.(link => { void open(link); });
    return () => { invalidate(); stop?.(); };
  }, [open, invalidate]);
  return { notice, dismiss: () => setNotice(null) };
}
