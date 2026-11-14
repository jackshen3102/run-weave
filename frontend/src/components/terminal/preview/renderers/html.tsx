import { useHtmlReview } from "../../../../features/terminal/html-review/use-review";
import { TerminalBrowserAnnotationsPanel } from "../../browser/annotations/panel";
import type { ReviewContext } from "../../../../features/terminal/html-review/protocol";
import type { InsertReviewFeedback } from "../../../../features/terminal/input/prompt-store";
import { useEffect, useState } from "react";
import type { CreateTerminalHtmlPreviewTicketResponse } from "@runweave/shared/terminal/preview";
import type { TerminalPreviewChangeKind } from "@runweave/shared/terminal/preview";
import { requestJson } from "../../../../services/http";
import { TerminalMonacoViewer } from "./monaco";

interface Props {
  reviewContext?: ReviewContext;
  onInsertReview?: InsertReviewFeedback;
  registerReviewGuard?: (guard: (() => boolean) | null) => void;
  onReload?: () => void;
  onAuthExpired?: () => void;
  apiBase: string;
  token: string;
  projectId: string;
  path: string;
  content: string;
  savedContent: string;
  mtimeMs: number;
  refreshKey: number;
  editable: boolean;
  lineReferencePath: string;
  canInsertSelection?: boolean;
  selectionDisabledReason?: string;
  hasUnsavedChanges?: boolean;
  onInsertSelection?: (text: string) => void;
  initialRevealPosition?: { line: number; column: number; key: string };
  onContentChange: (content: string) => void;
  change?: { kind: TerminalPreviewChangeKind; version: string };
  previewOnly?: boolean;
}

export function TerminalHtmlPreview(props: Props) {
  const review = useHtmlReview({ apiBase: props.apiBase, token: props.token,
    context: props.change ? undefined : props.reviewContext,
    content: props.content, savedContent: props.savedContent, mtimeMs: props.mtimeMs,
    onInsert: props.onInsertReview, registerDiscardGuard: props.registerReviewGuard,
    onAuthExpired: props.onAuthExpired });
  const changeKind = props.change?.kind;
  const changeVersion = props.change?.version;
  const [mode, setMode] = useState<"preview" | "source">(props.initialRevealPosition ? "source" : "preview");
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (mode !== "preview") return;
    let active = true;
    setUrl(null);
    setError(null);
    void requestJson<CreateTerminalHtmlPreviewTicketResponse>(
      props.apiBase,
      `/api/terminal/project/${encodeURIComponent(props.projectId)}/preview/html-ticket`,
      { method: "POST", headers: { Authorization: `Bearer ${props.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ path: props.path,
        ...(changeKind && changeVersion ? { changeKind, version: changeVersion } : {}) }) },
    ).then((ticket) => {
      if (active) setUrl(`${props.apiBase.replace(/\/$/, "")}${ticket.path}`);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { active = false; };
  }, [mode, props.apiBase, props.token, props.projectId, props.path, props.mtimeMs, props.refreshKey,
    changeKind, changeVersion, revision]);

  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex shrink-0 items-center gap-1 border-b border-slate-800 px-2 py-1 text-xs">
      {!props.previewOnly && (["preview", "source"] as const).map((choice) => <button key={choice} type="button" onClick={() => { if (review.discard()) setMode(choice); }} className={mode === choice ? "rounded bg-slate-700 px-2 py-1 text-white" : "rounded px-2 py-1 text-slate-400"}>{choice === "preview" ? "Preview" : "Source"}</button>)}
      {mode === "preview" && <button type="button" className="ml-auto px-2 text-slate-400" onClick={() => { if (review.discard()) { setRevision((value) => value + 1); props.onReload?.(); } }}>Refresh</button>}
      {mode === "preview" && !props.change && !props.previewOnly && <button type="button" disabled={!review.session && !!review.unavailable} title={review.unavailable} className="rounded px-2 py-1 text-sky-300 disabled:opacity-40" onClick={() => { if (review.session) review.discard(); else review.start(); }}>{review.session ? "退出评审" : "评审"}</button>}
      {mode === "preview" && !review.session && review.unavailable && props.reviewContext && <span className="text-slate-400">{review.unavailable}</span>}
      {mode === "preview" && props.content !== props.savedContent && <span className="text-amber-400">Save to update preview</span>}
    </div>
    <div className="min-h-0 flex-1">
      {mode === "source" ? <TerminalMonacoViewer language="html" content={props.content} editable={props.editable} onContentChange={props.onContentChange} lineReferencePath={props.lineReferencePath} initialRevealPosition={props.initialRevealPosition} canInsertSelection={props.canInsertSelection} selectionDisabledReason={props.selectionDisabledReason} hasUnsavedChanges={props.hasUnsavedChanges} onInsertSelection={props.onInsertSelection} />
        : review.session ? <iframe key={review.session.generation} ref={review.frame} title="HTML review" srcDoc={review.session.srcDoc} sandbox="allow-scripts" referrerPolicy="no-referrer" className="h-full w-full border-0 bg-white" onLoad={review.connect} />
        : error ? <div className="p-3 text-rose-300">{error}</div>
        : url ? <iframe key="ticket-preview" title="HTML preview" src={url} sandbox="allow-scripts" referrerPolicy="no-referrer" className="h-full w-full border-0 bg-white" />
        : <div className="p-3 text-slate-400">Loading HTML preview...</div>}
    </div>
    {review.session && mode === "preview" && <>
      {!review.panelOpen && <button type="button" className="p-2 text-xs text-sky-300" onClick={() => review.setPanelOpen(true)}>查看评审评论 ({review.comments.length})</button>}
      <TerminalBrowserAnnotationsPanel open={review.panelOpen} state={review.state} submitting={review.pending}
        error={review.targetReason || review.guestError} onClose={() => review.setPanelOpen(false)}
        onDelete={review.remove} onDiscard={review.clearComments} onFocus={review.focus}
        onSelectingChange={review.choose} onSubmit={() => void review.insert()}
        fileReview={{ disabled: !review.ready || !!review.targetReason || !!review.guestError || review.hasDraft || review.alreadyInserted,
          label: review.pending ? "正在核对并加入…" : review.alreadyInserted ? "本批评论已加入" : "加入输入框",
          notice: review.message || (review.hasDraft ? "请先保存或取消页面中正在编辑的评论" : !review.ready ? "正在连接评审页面" : "检查评论后加入输入框，再手动发送") }} />
    </>}
  </div>;
}
