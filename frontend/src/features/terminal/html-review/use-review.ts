import type { TerminalBrowserAnnotationState } from "@runweave/shared/terminal-browser-annotation";
import { useEffect, useRef, useState } from "react";
import { useMemoizedFn } from "ahooks";
import { getTerminalProjectPreviewFile } from "../../../services/terminal/preview";
import type { InsertReviewFeedback } from "../input/prompt-store";
import { createReviewDocument, parseReviewDocument } from "./document";
import { contextKey, isReviewState, type ReviewContext } from "./protocol";
import { reviewPrompt } from "./prompt";

export interface HtmlReviewOptions {
  apiBase: string;
  token: string;
  context?: ReviewContext;
  savedContent: string;
  content: string;
  mtimeMs: number;
  onInsert?: InsertReviewFeedback;
  registerDiscardGuard?: (guard: (() => boolean) | null) => void;
  onAuthExpired?: () => void;
}
interface ReviewSession {
  generation: string;
  context: ReviewContext;
  savedContent: string;
  mtimeMs: number;
  srcDoc: string;
}

export function useHtmlReview(options: HtmlReviewOptions) {
  const [session, setSession] = useState<ReviewSession | null>(null);
  const [state, setState] = useState<TerminalBrowserAnnotationState>({ active: true, selecting: true, annotations: [], pendingSubmitRequestId: null });
  const [hasDraft, setHasDraft] = useState(false);
  const [guestError, setGuestError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const comments = state.annotations;
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [insertedBatch, setInsertedBatch] = useState<string | null>(null);
  const current = useRef(options);
  current.current = options;
  const live = useRef<ReviewSession | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const port = useRef<MessagePort | null>(null);
  const cancelInsertion = useRef<(() => void) | null>(null);
  const connecting = useRef(false);
  const navigationCleanup = useRef<(() => void) | null>(null);
  const batch = JSON.stringify(comments);
  const currentBatch = useRef(batch);
  currentBatch.current = batch;
  const contract = useRef<{ content: string; reason?: string } | null>(null);
  if (contract.current?.content !== options.savedContent) {
    contract.current = { content: options.savedContent, reason: parseReviewDocument(options.savedContent).reason };
  }
  const unavailable = !options.context ? "请在终端工作区文件预览中评审"
    : options.content !== options.savedContent ? "保存或放弃 HTML 未保存修改后才能评审"
    : contract.current.reason;
  const targetReason = !options.context?.available || !options.onInsert ? "当前 pane 没有可用的 Agent 输入框"
    : session && contextKey(session.context) !== contextKey(options.context) ? "评审目标已变化，请返回原终端和 pane 或重新开始评审"
    : session && session.savedContent !== options.savedContent ? "文件正文已变化，请刷新并重新开始评审"
    : options.content !== options.savedContent ? "请先保存或放弃 HTML 未保存修改" : null;

  const disconnect = useMemoizedFn(() => {
    navigationCleanup.current?.();
    navigationCleanup.current = null;
    const old = live.current;
    live.current = null; // invalidate before cancellation can invoke a receipt
    cancelInsertion.current?.();
    cancelInsertion.current = null;
    if (old) port.current?.postMessage({ kind: "stop", generation: old.generation });
    if (port.current) port.current.onmessage = null;
    port.current?.close();
    port.current = null;
    connecting.current = false;
  });
  const discard = useMemoizedFn(() => {
    if (!session) return true;
    if (live.current && (comments.length || hasDraft) && !window.confirm("退出或刷新将丢弃当前评审评论，继续？")) return false;
    disconnect();
    setSession(null);
    setState({ active: true, selecting: true, annotations: [], pendingSubmitRequestId: null });
    setHasDraft(false);
    setGuestError(null);
    setPanelOpen(true);
    setReady(false);
    setPending(false);
    setMessage(null);
    setInsertedBatch(null);
    return true;
  });
  const registerDiscardGuard = options.registerDiscardGuard;
  useEffect(() => {
    registerDiscardGuard?.(discard);
    return () => { registerDiscardGuard?.(null); disconnect(); };
  }, [registerDiscardGuard, discard, disconnect]);
  // A pending insertion must not survive a target/eligibility or snapshot change.
  useEffect(() => {
    if (session && targetReason) {
      cancelInsertion.current?.();
      cancelInsertion.current = null;
      setPending(false);
    }
  }, [session, targetReason]);

  const start = useMemoizedFn(() => {
    if (unavailable || !options.context) return;
    if (!discard()) return;
    const generation = crypto.randomUUID();
    const next = { generation, context: { ...options.context }, savedContent: options.savedContent,
      mtimeMs: options.mtimeMs, srcDoc: createReviewDocument(options.savedContent, generation) };
    live.current = next;
    setSession(next);
  });
  const connect = useMemoizedFn(() => {
    const active = live.current;
    const guest = frame.current?.contentWindow;
    if (!active || !guest) return;
    if (connecting.current) {
      disconnect();
      setReady(false);
      setMessage("评审页面已导航，请退出并重新开始评审");
      return;
    }
    connecting.current = true;
    const onNavigation = (event: MessageEvent) => {
      if (event.source !== guest || event.data?.kind !== "review-navigation" ||
        event.data?.generation !== active.generation || Object.keys(event.data).length !== 2 || live.current !== active) return;
      disconnect();
      setReady(false);
      setMessage("评审页面已导航，请退出并重新开始评审");
    };
    window.addEventListener("message", onNavigation);
    navigationCleanup.current = () => window.removeEventListener("message", onNavigation);
    const channel = new MessageChannel();
    port.current = channel.port1;
    channel.port1.onmessage = (event: MessageEvent) => {
      const data: unknown = event.data;
      if (live.current !== active || !data || typeof data !== "object") return;
      const value = data as Record<string, unknown>;
      if (value.generation !== active.generation) return;
      if (value.kind === "ready" && Object.keys(value).length === 2) setReady(true);
      if (value.kind === "state" && Object.keys(value).sort().join() === "error,generation,hasDraft,kind,state" &&
        typeof value.hasDraft === "boolean" && (value.error === null || (typeof value.error === "string" && value.error.length <= 1000)) && isReviewState(value.state)) {
        setState(value.state);
        setHasDraft(value.hasDraft);
        setGuestError(value.error);
        if (value.state.pendingSubmitRequestId) {
          // Page "submit" only opens host review. It never inserts or sends.
          setPanelOpen(true);
          channel.port1.postMessage({ kind: "ack-submit", generation: active.generation });
        }
      }

    };
    // Only the trusted wrapper receives and forwards the transferable capability. No global message
    // listener accepts selections, origins or terminal identity from page data.
    guest.postMessage({ kind: "review-connect", generation: active.generation }, "*", [channel.port2]);
  });
  const command = useMemoizedFn((kind: string, data: Record<string, unknown> = {}) => {
    if (live.current) port.current?.postMessage({ kind, generation: live.current.generation, ...data });
  });
  const choose = useMemoizedFn((value: boolean) => command("selecting", { value }));
  const focus = useMemoizedFn((id: string) => command("focus", { id }));
  const remove = useMemoizedFn((id: string) => command("remove", { id }));
  const clearComments = useMemoizedFn(() => comments.forEach((comment) => remove(comment.id)));
  useEffect(() => { command("submitting", { value: pending }); }, [pending, command]);
  const insert = useMemoizedFn(async () => {
    const active = live.current;
    if (!active || pending || targetReason || !comments.length || insertedBatch === batch || hasDraft || guestError) return;
    const submittedBatch = batch;
    setPending(true); setMessage(null);
    const stillValid = () => live.current === active && current.current.context?.available &&
      contextKey(current.current.context) === contextKey(active.context) &&
      current.current.savedContent === active.savedContent && current.current.content === active.savedContent && currentBatch.current === submittedBatch;
    try {
      const file = await getTerminalProjectPreviewFile(options.apiBase, options.token,
        active.context.projectId, active.context.absolutePath);
      if (live.current !== active) return;
      if (!stillValid()) throw new Error("评审目标或编辑内容已变化，未加入输入框");
      if (file.content !== active.savedContent || file.absolutePath !== active.context.absolutePath) {
        throw new Error("文件正文已变化，请刷新文件并重新开始评审；评论已保留");
      }
      const feedback = reviewPrompt(active.context, comments, { id: active.generation,
        mtimeMs: active.mtimeMs, readAt: new Date().toISOString() });
      if (!current.current.onInsert) throw new Error("当前输入框不可用");
      cancelInsertion.current = current.current.onInsert(feedback, (result) => {
        if (live.current !== active) return;
        cancelInsertion.current = null;
        setPending(false);
        if (result === "inserted" && stillValid()) {
          setInsertedBatch(submittedBatch); setMessage("已加入输入框，请检查并手动发送");
        } else setMessage(result === "target-changed" ? "目标输入框已变化，未加入；评论已保留" : "插入已取消，评论已保留");
      });
    } catch (error) {
      if (live.current !== active) return;
      // Keep review comments mounted on 401 as well; authentication recovery
      // must not silently discard this local feedback draft.
      setPending(false);
      setMessage(error instanceof Error ? error.message : "读取文件失败，未加入输入框");
    }
  });
  return { session, state, comments, hasDraft, panelOpen, setPanelOpen, ready, pending,
    message, guestError, unavailable, targetReason, frame, start, discard, connect, choose, focus, remove, clearComments,
    insert, alreadyInserted: insertedBatch === batch };
}
