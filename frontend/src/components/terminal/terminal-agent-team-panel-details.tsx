import { RunweaveImageLightbox } from "@runweave/common/terminal";
import "@runweave/common/terminal/image-lightbox.css";
import { useMemoizedFn } from "ahooks";
import { Crosshair } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AgentTeamAcceptanceEvidence, AgentTeamAcceptanceStatus, AgentTeamRun } from "@runweave/shared/agent-team";
import { HttpError } from "../../services/http";
import { getTerminalProjectPreviewAsset } from "../../services/terminal";
import { ROLE_LABEL } from "./terminal-agent-team-panel-model";

const EVIDENCE_TYPE_LABEL: Record<AgentTeamAcceptanceEvidence["type"], string> =
  {
    text: "文本",
    dom: "DOM",
    screenshot: "截图",
    command: "命令",
    event: "事件",
    json: "JSON",
    log: "日志",
    code: "代码",
  };

const EVIDENCE_ATTACHMENT_LABEL: Partial<
  Record<AgentTeamAcceptanceEvidence["type"], string>
> = {
  screenshot: "查看截图",
  dom: "查看 DOM 证据",
  json: "查看 JSON 证据",
  log: "查看日志证据",
  code: "查看代码证据",
  command: "查看命令记录",
  event: "查看事件记录",
};

export function AcceptanceEvidenceDetails({
  apiBase,
  token,
  projectId,
  status,
  summary,
  evidence,
  onAuthExpired,
}: {
  apiBase: string;
  token: string;
  projectId: string;
  status: AgentTeamAcceptanceStatus;
  summary?: string | null;
  evidence: AgentTeamAcceptanceEvidence[];
  onAuthExpired?: () => void;
}) {
  const leadSummary =
    summary?.trim() || (status === "pass" ? evidence[0]?.summary : null);
  const conclusion = leadSummary
    ? `${getStatusPrefix(status)}：${leadSummary}`
    : status === "fail"
      ? `${getStatusPrefix(status)}：未提供失败结论，请查看证据`
      : `${getStatusPrefix(status)}：尚未收到证据`;
  const groupedEvidence = groupEvidenceByType(evidence);

  return (
    <div className="mt-1 space-y-1 text-[10px]">
      <div
        className={[
          "leading-relaxed",
          status === "pass"
            ? "text-emerald-300"
            : status === "fail"
              ? "text-rose-300"
              : "text-slate-500",
        ].join(" ")}
      >
        {conclusion}
      </div>
      {evidence.length > 0 ? (
        <details className="border-t border-slate-800 pt-1">
          <summary className="cursor-pointer select-none text-slate-500 hover:text-slate-300">
            {evidence.length} 条证据
          </summary>
          <div className="mt-1 space-y-2">
            {groupedEvidence.map(([type, items]) => (
              <div key={type} className="space-y-1">
                <div className="font-medium text-slate-400">
                  {EVIDENCE_TYPE_LABEL[type]}
                </div>
                <div className="space-y-1">
                  {items.map((item, index) => (
                    <div
                      key={`${item.type}-${item.label}-${index}`}
                      className="border-l border-slate-700 pl-2"
                    >
                      <div className="font-medium text-slate-300">
                        {item.label}
                      </div>
                      <div className="leading-relaxed text-slate-400">
                        {item.summary}
                      </div>
                      {item.detail ? (
                        <div className="mt-0.5 leading-relaxed text-slate-500">
                          {item.detail}
                        </div>
                      ) : null}
                      <EvidenceAttachment
                        apiBase={apiBase}
                        token={token}
                        projectId={projectId}
                        evidence={item}
                        onAuthExpired={onAuthExpired}
                      />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function EvidenceAttachment({
  apiBase,
  token,
  projectId,
  evidence,
  onAuthExpired,
}: {
  apiBase: string;
  token: string;
  projectId: string;
  evidence: AgentTeamAcceptanceEvidence;
  onAuthExpired?: () => void;
}) {
  if (evidence.type === "screenshot") {
    return (
      <ScreenshotEvidenceAttachment
        apiBase={apiBase}
        token={token}
        projectId={projectId}
        evidence={evidence}
        onAuthExpired={onAuthExpired}
      />
    );
  }

  return (
    <details className="mt-0.5">
      <summary
        className="inline cursor-pointer select-none text-sky-300 hover:text-sky-200"
        title={evidence.ref}
      >
        {getEvidenceAttachmentLabel(evidence)}
      </summary>
      <div className="mt-0.5 break-all font-mono text-slate-500">
        {evidence.ref}
      </div>
    </details>
  );
}

function ScreenshotEvidenceAttachment({
  apiBase,
  token,
  projectId,
  evidence,
  onAuthExpired,
}: {
  apiBase: string;
  token: string;
  projectId: string;
  evidence: AgentTeamAcceptanceEvidence;
  onAuthExpired?: () => void;
}) {
  const objectUrlRef = useRef<string | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const releaseObjectUrl = useMemoizedFn(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setObjectUrl(null);
  });

  useEffect(
    () => () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
      }
    },
    [],
  );

  const openScreenshot = useMemoizedFn(async () => {
    if (loading) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const blob = await getTerminalProjectPreviewAsset(
        apiBase,
        token,
        projectId,
        evidence.ref,
      );
      releaseObjectUrl();
      const nextObjectUrl = URL.createObjectURL(blob);
      objectUrlRef.current = nextObjectUrl;
      setObjectUrl(nextObjectUrl);
      setOpen(true);
    } catch (caught) {
      if (caught instanceof HttpError && caught.status === 401) {
        onAuthExpired?.();
      }
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  });

  const closeScreenshot = useMemoizedFn(() => {
    setOpen(false);
    releaseObjectUrl();
  });

  return (
    <div className="mt-0.5">
      <button
        type="button"
        className="text-sky-300 hover:text-sky-200 disabled:cursor-wait disabled:text-slate-500"
        disabled={loading}
        onClick={openScreenshot}
        title={evidence.ref}
      >
        {loading ? "加载截图…" : getEvidenceAttachmentLabel(evidence)}
      </button>
      {error ? (
        <div className="mt-0.5 break-words text-rose-300">{error}</div>
      ) : null}
      {objectUrl ? (
        <RunweaveImageLightbox
          alt={evidence.label}
          onClose={closeScreenshot}
          open={open}
          src={objectUrl}
          title={evidence.ref}
        />
      ) : null}
    </div>
  );
}

export function PaneFocusList({
  run,
  onFocusPane,
}: {
  run: AgentTeamRun;
  onFocusPane: (panelId: string) => void;
}) {
  const focusablePanes = run.workers.filter(
    (worker): worker is typeof worker & { panelId: string } =>
      Boolean(worker.panelId),
  );
  if (focusablePanes.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {focusablePanes.map((worker) => (
        <button
          key={worker.panelId}
          type="button"
          className="flex items-center gap-1 rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 hover:border-rose-600 hover:text-rose-300"
          onClick={() => onFocusPane(worker.panelId)}
        >
          <Crosshair className="h-3 w-3" /> 聚焦 {ROLE_LABEL[worker.role]} pane
        </button>
      ))}
    </div>
  );
}

function groupEvidenceByType(
  evidence: AgentTeamAcceptanceEvidence[],
): Array<[AgentTeamAcceptanceEvidence["type"], AgentTeamAcceptanceEvidence[]]> {
  const groups = new Map<
    AgentTeamAcceptanceEvidence["type"],
    AgentTeamAcceptanceEvidence[]
  >();
  for (const item of evidence) {
    groups.set(item.type, [...(groups.get(item.type) ?? []), item]);
  }
  return Array.from(groups.entries());
}

function getStatusPrefix(status: AgentTeamAcceptanceStatus): string {
  if (status === "pass") {
    return "已通过";
  }
  if (status === "fail") {
    return "未通过";
  }
  return "待验收";
}

function getEvidenceAttachmentLabel(
  evidence: AgentTeamAcceptanceEvidence,
): string {
  return EVIDENCE_ATTACHMENT_LABEL[evidence.type] ?? "查看原始证据";
}
