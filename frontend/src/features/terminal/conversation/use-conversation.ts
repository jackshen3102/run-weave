import { useEffect, useRef, useState } from "react";
import { useMemoizedFn } from "ahooks";
import type { ConversationTarget, TerminalConversationResponse } from "@runweave/shared/terminal/conversation";
import { getTerminalConversation } from "../../../services/terminal/conversation";
import { HttpError } from "../../../services/http";
import { useTerminalRuntime } from "../queries/provider";

export function useConversation(sessionId: string, panelId: string | null) {
  const runtime = useTerminalRuntime();
  const [data, setData] = useState<TerminalConversationResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unchanged, setUnchanged] = useState(false);
  const boundTarget = useRef<ConversationTarget | null>(null);
  const request = useRef<{ controller: AbortController; sequence: number } | null>(null);
  const sequence = useRef(0);
  const scope = `${runtime.scope}:${sessionId}:${panelId ?? ""}`;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const dataRef = useRef(data);
  dataRef.current = data;
  const load = useMemoizedFn(async () => {
    if (request.current) return;
    const controller = new AbortController();
    const ticket = ++sequence.current;
    const startedScope = scope;
    request.current = { controller, sequence: ticket };
    setLoading(true); setError(null); setUnchanged(false);
    try {
      const previous = dataRef.current;
      const response = await getTerminalConversation(runtime.apiBase, runtime.token, sessionId, {
        panelId, expectedThreadId: boundTarget.current?.threadId,
      }, controller.signal);
      if (controller.signal.aborted || ticket !== sequence.current || currentScope.current !== startedScope) return;
      if (boundTarget.current && JSON.stringify(boundTarget.current) !== JSON.stringify(response.target)) {
        setData(null); setError("会话已变化，请关闭后重新打开阅读页"); return;
      }
      boundTarget.current ??= response.target;
      setUnchanged(!!previous && JSON.stringify(previous.turns) === JSON.stringify(response.turns) &&
        previous.availability === response.availability);
      setData(response);
    } catch (cause) {
      if (controller.signal.aborted || ticket !== sequence.current || currentScope.current !== startedScope) return;
      if (cause instanceof HttpError && cause.status === 401) runtime.onAuthExpired?.();
      if (cause instanceof HttpError && cause.code === "CONVERSATION_TARGET_CHANGED") setData(null);
      setError(cause instanceof Error ? cause.message : "会话读取失败，请手动重试");
    } finally {
      if (ticket === sequence.current) { request.current = null; setLoading(false); }
    }
  });
  const cancel = useMemoizedFn(() => {
    ++sequence.current; request.current?.controller.abort(); request.current = null;
  });
  useEffect(() => {
    setData(null); dataRef.current = null; boundTarget.current = null;
    void load();
    return cancel;
  }, [scope, load, cancel]);
  return { data, loading, error, unchanged, load };
}
