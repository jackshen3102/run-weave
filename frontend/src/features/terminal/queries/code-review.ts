import { useEffect } from "react";
import { useMemoizedFn } from "ahooks";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import type { CodeReviewPage, CreateCodeReviewRequest } from "@runweave/shared/terminal/code-review";
import type { TerminalSessionListItem } from "@runweave/shared/terminal/session";
import { closeCodeReview, createCodeReview, getCodeReview, listCodeReviews } from "../../../services/terminal/code-review";
import { HttpError } from "../../../services/http";
import { useTerminalRuntime } from "./provider";
import { terminalQueryKeys } from "./keys";

interface ActionState { pending: boolean; error: string | null; request: CreateCodeReviewRequest }
const useActions = create<{ states: Record<string, ActionState>; put: (key: string, value: ActionState) => void }>((set) => ({
  states: {}, put: (key, value) => set((state) => ({ states: { ...state.states, [key]: value } })),
}));
const listKey = (scope: string, id: string | null) => [...terminalQueryKeys.all(scope), "code-reviews", id];
export const codeReviewError = (error: unknown) => error instanceof HttpError && [404, 501].includes(error.status)
  ? "此电脑尚不支持代码 Review" : error instanceof Error ? error.message : String(error);
export function useCodeReviewActionState(id: string | null) {
  const { scope } = useTerminalRuntime();
  return useActions((state) => state.states[JSON.stringify([scope, id])]);
}
export function useStartCodeReview(session: TerminalSessionListItem | null) {
  const runtime = useTerminalRuntime();
  const client = useQueryClient();
  return useMemoizedFn(async () => {
    if (!session) return;
    const { scope, apiBase, token, onAuthExpired } = runtime;
    const id = session.terminalSessionId;
    const key = JSON.stringify([scope, id]);
    const old = useActions.getState().states[key];
    if (old?.pending) return;
    const request: CreateCodeReviewRequest = { requestId: crypto.randomUUID() };
    const put = useActions.getState().put;
    put(key, { pending: true, error: null, request });
    try {
      try { await createCodeReview(apiBase, token, id, request); }
      catch (error) {
        // Retry one lost transport response with the same operation identity.
        if (error instanceof HttpError) throw error;
        await createCodeReview(apiBase, token, id, request);
      }
      put(key, { pending: false, error: null, request });
      await Promise.all([client.invalidateQueries({ queryKey: listKey(scope, id) }), client.invalidateQueries({ queryKey: terminalQueryKeys.sessions(scope) })]);
    } catch (error) {
      put(key, { pending: false, error: codeReviewError(error), request });
      if (error instanceof HttpError && error.status === 401) onAuthExpired?.();
    }
  });
}
export function useCodeReviews(id: string | null, poll = true) {
  const { scope, apiBase, token, onAuthExpired } = useTerminalRuntime();
  const query = useQuery({ queryKey: listKey(scope, id), queryFn: ({ signal }) => listCodeReviews(apiBase, token, id!, signal),
    enabled: !!id, retry: false, staleTime: 3000,
    refetchInterval: (query) => poll && !(query.state.error instanceof HttpError && [404, 501].includes(query.state.error.status)) ? 5000 : false,
    refetchIntervalInBackground: false });
  useEffect(() => { if (query.error instanceof HttpError && query.error.status === 401) onAuthExpired?.(); }, [query.error, onAuthExpired]);
  return query;
}
export function useCodeReviewDetail(id: string | null) {
  const { scope, apiBase, token } = useTerminalRuntime();
  return useQuery({ queryKey: [...terminalQueryKeys.all(scope), "code-review", id],
    queryFn: ({ signal }) => getCodeReview(apiBase, token, id!, signal), enabled: !!id, retry: false,
    refetchInterval: (query) => {
      const run = query.state.data?.run;
      return query.state.error || (run && !["preparing", "starting", "reviewing"].includes(run.phase) && !["pending", "writing"].includes(run.delivery)) ? false : 5000;
    } });
}
export function useCloseCodeReview(sessionId: string | null) {
  const { scope, apiBase, token, onAuthExpired } = useTerminalRuntime();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (reviewId: string) => closeCodeReview(apiBase, token, reviewId),
    onSuccess: (run) => {
      client.setQueryData<CodeReviewPage>(listKey(scope, sessionId), (page) => page ? {
        ...page, runs: page.runs.map((item) => item.caseId === run.caseId ? { ...item, caseStatus: run.caseStatus } : item),
      } : page);
      void client.invalidateQueries({ queryKey: listKey(scope, sessionId) });
      void client.invalidateQueries({ queryKey: [...terminalQueryKeys.all(scope), "code-review"] });
    },
    onError: (error) => { if (error instanceof HttpError && error.status === 401) onAuthExpired?.(); },
  });
}
