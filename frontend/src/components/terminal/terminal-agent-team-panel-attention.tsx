import { AlertTriangle, ArrowDown, Crosshair } from "lucide-react";
import type { AgentTeamAttention } from "./terminal-agent-team-panel-model";

export function AgentTeamAttentionSummary({
  attention,
  onFocusPane,
  onShowDetails,
}: {
  attention: AgentTeamAttention;
  onFocusPane: (panelId: string) => void;
  onShowDetails: (caseId: string) => void;
}) {
  const danger = attention.tone === "danger";
  const panelId = attention.panelId;
  const panelLabel = attention.panelLabel;
  const caseId = attention.caseId;
  const hasActions = Boolean(panelId || caseId);

  return (
    <section
      className="mx-3 mt-2 shrink-0"
      aria-label="当前关注"
      aria-live="polite"
    >
      <div
        className={[
          "rounded border px-2.5 py-2",
          danger
            ? "border-rose-800 bg-rose-950/40"
            : "border-amber-800 bg-amber-950/30",
        ].join(" ")}
      >
        <div
          className={[
            "flex items-center justify-between gap-2 text-[10px] font-semibold uppercase",
            danger ? "text-rose-300" : "text-amber-300",
          ].join(" ")}
        >
          <span className="flex items-center gap-1">
            <AlertTriangle className="h-3.5 w-3.5" /> 当前关注
          </span>
          <span className="font-normal normal-case opacity-80">
            {attention.issueCount} 个问题
          </span>
        </div>

        <div className="mt-1.5 flex items-center gap-1.5">
          {attention.severity ? (
            <span
              className={[
                "rounded px-1 py-0.5 text-[9px] font-semibold",
                danger
                  ? "bg-rose-500/20 text-rose-200"
                  : "bg-amber-500/20 text-amber-200",
              ].join(" ")}
            >
              {attention.severity}
            </span>
          ) : null}
          <span
            className={[
              "text-xs font-semibold",
              danger ? "text-rose-100" : "text-amber-100",
            ].join(" ")}
          >
            {attention.title}
          </span>
        </div>

        <p
          className={[
            "mt-1 line-clamp-2 whitespace-pre-wrap break-words text-[11px] leading-relaxed",
            danger ? "text-rose-200" : "text-amber-100/80",
          ].join(" ")}
        >
          {attention.summary}
        </p>
        <div
          className={[
            "mt-1 font-mono text-[10px]",
            danger ? "text-rose-300/70" : "text-amber-300/70",
          ].join(" ")}
        >
          {attention.meta}
        </div>

        {hasActions ? (
          <div className="mt-2 flex flex-wrap justify-end gap-1.5">
            {panelId && panelLabel ? (
              <button
                type="button"
                className={[
                  "flex h-7 items-center gap-1 rounded border px-2 text-[10px]",
                  danger
                    ? "border-rose-800 text-rose-200 hover:bg-rose-950/60"
                    : "border-amber-800 text-amber-200 hover:bg-amber-950/50",
                ].join(" ")}
                onClick={() => onFocusPane(panelId)}
              >
                <Crosshair className="h-3 w-3" /> 聚焦 {panelLabel} pane
              </button>
            ) : null}
            {caseId ? (
              <button
                type="button"
                className={[
                  "flex h-7 items-center gap-1 rounded border px-2 text-[10px]",
                  danger
                    ? "border-rose-700 bg-rose-950/50 text-rose-100 hover:bg-rose-950/80"
                    : "border-amber-700 bg-amber-950/40 text-amber-100 hover:bg-amber-950/70",
                ].join(" ")}
                onClick={() => onShowDetails(caseId)}
              >
                查看详情 <ArrowDown className="h-3 w-3" />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
