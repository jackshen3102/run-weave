import { useEffect, useState } from "react";
import type { CreateTerminalHtmlPreviewTicketResponse } from "@runweave/shared/terminal/preview";
import { requestJson } from "../../../../services/http";
import { TerminalMonacoViewer } from "./monaco";

interface Props {
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
  initialRevealPosition?: { line: number; column: number; key: string };
  onContentChange: (content: string) => void;
}

export function TerminalHtmlPreview(props: Props) {
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
      { method: "POST", headers: { Authorization: `Bearer ${props.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ path: props.path }) },
    ).then((ticket) => {
      if (active) setUrl(`${props.apiBase.replace(/\/$/, "")}${ticket.path}`);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { active = false; };
  }, [mode, props.apiBase, props.token, props.projectId, props.path, props.mtimeMs, props.refreshKey, revision]);

  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex shrink-0 items-center gap-1 border-b border-slate-800 px-2 py-1 text-xs">
      {(["preview", "source"] as const).map((choice) => <button key={choice} type="button" onClick={() => setMode(choice)} className={mode === choice ? "rounded bg-slate-700 px-2 py-1 text-white" : "rounded px-2 py-1 text-slate-400"}>{choice === "preview" ? "Preview" : "Source"}</button>)}
      {mode === "preview" && <button type="button" className="ml-auto px-2 text-slate-400" onClick={() => setRevision((value) => value + 1)}>Refresh</button>}
      {mode === "preview" && props.content !== props.savedContent && <span className="text-amber-400">Save to update preview</span>}
    </div>
    <div className="min-h-0 flex-1">
      {mode === "source" ? <TerminalMonacoViewer language="html" content={props.content} editable={props.editable} onContentChange={props.onContentChange} lineReferencePath={props.lineReferencePath} initialRevealPosition={props.initialRevealPosition} />
        : error ? <div className="p-3 text-rose-300">{error}</div>
        : url ? <iframe title="HTML preview" src={url} sandbox="allow-scripts" referrerPolicy="no-referrer" className="h-full w-full border-0 bg-white" />
        : <div className="p-3 text-slate-400">Loading HTML preview...</div>}
    </div>
  </div>;
}
