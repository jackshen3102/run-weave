import { useEffect, useMemo, useRef, useState } from "react";
import { useMemoizedFn } from "ahooks";
import type {
  AttentionOpenIntent,
  AttentionSlot,
  AttentionState,
} from "@runweave/shared/attention";
import { hasSeenFailure, markFailureSeen } from "../../features/attention/attention-retirement";
import { useAttentionSnapshot } from "../../features/attention/use-attention-snapshot";
import "./desktop-companion.css";

const HIGH_PRIORITY = new Set<AttentionState>(["needs_action", "blocked"]);
const SUMMARY_LABEL: Record<AttentionState, string> = {
  needs_action: "待决定",
  blocked: "验收受阻",
  failed: "异常退出",
  completed: "完成待查看",
  working: "执行中",
};

function formatRelativeTime(value: string): string {
  const elapsed = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  if (!Number.isFinite(elapsed)) return "-";
  if (elapsed < 60) return elapsed < 10 ? "刚刚" : `${elapsed} 秒前`;
  const minutes = Math.floor(elapsed / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} 小时前` : `${Math.floor(hours / 24)} 天前`;
}

function statusLabel(slot: AttentionSlot): string {
  if (slot.state === "needs_action") return "需要你决定";
  if (slot.state === "blocked") return "验收受阻";
  if (slot.state === "completed") return "完成待查看";
  if (slot.state === "failed") {
    return slot.source.kind === "agent_team_run" ? "执行失败" : "异常退出";
  }
  return slot.source.kind === "agent_team_run" ? "Agent Team 执行中" : "执行中";
}

function targetLabel(slot: AttentionSlot): string {
  return slot.targetSurface === "agent-team" ? "Agent Team" : "Terminal";
}

function slotPath(slot: AttentionSlot): string {
  return [slot.contextName, slot.sessionLabel, slot.panelLabel].filter(Boolean).join(" / ");
}

function StatusPill({ slot }: { slot: AttentionSlot }) {
  return (
    <span className={`status-pill ${slot.state}`}>
      <span className={`state-dot ${slot.state}`} />
      {statusLabel(slot)}
    </span>
  );
}

function CompanionPet(props: {
  state: AttentionState | "idle" | "disconnected" | "checking";
  count: number;
  disabled?: boolean;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      className={`companion-pet pet-mode-${props.state}`}
      type="button"
      disabled={props.disabled}
      aria-label={props.label}
      onClick={props.onClick}
    >
      <span className="pet-aura" />
      <span className="pet-shadow" />
      <span className="pet-body" aria-hidden="true">
        <span className="pet-ear left" />
        <span className="pet-ear right" />
        <span className="pet-face">
          <span className="pet-eye left" />
          <span className="pet-eye right" />
          <span className="pet-mouth" />
        </span>
      </span>
      {props.count > 0 ? (
        <span className={`pet-state-badge ${props.state}`}>{props.count}</span>
      ) : null}
      {props.state === "disconnected" ? <span className="pet-disconnected-mark">×</span> : null}
      {props.state === "checking" ? <span className="pet-checking-mark">…</span> : null}
    </button>
  );
}

export function DesktopCompanion(props: {
  apiBase: string;
  token: string | null;
  connectionId: string | null;
}) {
  const { state, snapshot } = useAttentionSnapshot(props);
  const [collapsed, setCollapsed] = useState(false);
  const [suppressed, setSuppressed] = useState<Set<string>>(() => new Set());
  const [openedOnce, setOpenedOnce] = useState(false);
  const [openNotice, setOpenNotice] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const slots = useMemo(
    () =>
      (snapshot?.slots ?? []).filter(
        (slot) =>
          slot.state !== "failed" ||
          !props.connectionId ||
          !hasSeenFailure(props.connectionId, slot.attentionId),
      ),
    [props.connectionId, snapshot],
  );
  const escalated = slots.find(
    (slot) => HIGH_PRIORITY.has(slot.state) && !suppressed.has(slot.attentionId),
  );
  const counts = useMemo(
    () =>
      slots.reduce<Record<AttentionState, number>>(
        (result, slot) => ({ ...result, [slot.state]: result[slot.state] + 1 }),
        { needs_action: 0, blocked: 0, failed: 0, completed: 0, working: 0 },
      ),
    [slots],
  );
  const attentionCount =
    counts.needs_action + counts.blocked + counts.failed + counts.completed;
  const dominantState = slots[0]?.state ?? "idle";
  const headline = attentionCount
    ? `${attentionCount} 个 Slot 需要关注`
    : `${counts.working} 个 Slot 正在执行`;
  const summary = (Object.keys(SUMMARY_LABEL) as AttentionState[])
    .filter((key) => counts[key] > 0)
    .map((key) => `${counts[key]} ${SUMMARY_LABEL[key]}`)
    .join(" · ");

  useEffect(() => {
    if (state === "ready" && slots.length > 0 && !openedOnce) {
      setCollapsed(false);
      setOpenedOnce(true);
    }
  }, [openedOnce, slots.length, state]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new ResizeObserver(() => {
      const bounds = root.getBoundingClientRect();
      void window.companionAPI?.reportContentSize({
        width: Math.ceil(bounds.width),
        height: Math.ceil(bounds.height),
      });
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const openSlot = useMemoizedFn(async (slot: AttentionSlot) => {
    if (!props.connectionId) return;
    setOpenNotice(null);
    const intent: AttentionOpenIntent = {
      requestId: crypto.randomUUID(),
      connectionId: props.connectionId,
      attentionId: slot.attentionId,
      projectId: slot.projectId,
      terminalSessionId: slot.terminalSessionId,
      panelId: slot.panelId,
      runId: slot.runId,
      targetSurface: slot.targetSurface,
      completionRevision: slot.completionRevision,
    };
    const result = await window.companionAPI?.openSlot(intent);
    if (result?.status === "opened_with_panel_fallback") {
      setOpenNotice(result.message);
    }
    if (
      slot.state === "failed" &&
      result &&
      (result.status === "opened" || result.status === "opened_with_panel_fallback")
    ) {
      markFailureSeen(props.connectionId, slot.attentionId);
    }
  });

  const suppressEscalations = useMemoizedFn(() => {
    setSuppressed(
      (previous) =>
        new Set([
          ...previous,
          ...slots
            .filter((slot) => HIGH_PRIORITY.has(slot.state))
            .map((slot) => slot.attentionId),
        ]),
    );
    setCollapsed(false);
  });

  let panel = null;
  let pet;
  if (state === "checking") {
    pet = <CompanionPet state="checking" count={0} disabled label="正在检查" />;
  } else if (state === "disconnected") {
    pet = (
      <CompanionPet
        state="disconnected"
        count={0}
        label="未连接，打开 Runweave"
        onClick={() => void window.companionAPI?.openMainWindow()}
      />
    );
  } else if (slots.length === 0) {
    pet = <CompanionPet state="idle" count={0} disabled label="所有 Slot 均安静" />;
  } else if (escalated) {
    panel = (
      <section className="companion-panel companion-card" data-state={escalated.state}>
        <header className="companion-panel-head">
          <StatusPill slot={escalated} />
          <div className="companion-panel-title">
            <strong>{escalated.projectName} / {escalated.contextName}</strong>
            <span>{formatRelativeTime(escalated.updatedAt)}</span>
          </div>
          <button className="companion-close" type="button" onClick={suppressEscalations} aria-label="收起">×</button>
        </header>
        <div className="companion-card-body">
          <h2>{escalated.title}</h2>
          <p>{escalated.detail}</p>
          <div className="companion-card-actions">
            <button className="companion-ghost" type="button" onClick={suppressEscalations}>暂时收起</button>
            <button className="companion-primary" type="button" onClick={() => void openSlot(escalated)}>打开 {targetLabel(escalated)} →</button>
          </div>
        </div>
      </section>
    );
    pet = (
      <CompanionPet
        state={dominantState}
        count={attentionCount}
        label="收起 Slot companion"
        onClick={suppressEscalations}
      />
    );
  } else if (collapsed) {
    pet = (
      <CompanionPet
        state={dominantState}
        count={attentionCount}
        label={`展开 ${slots.length} 个 Slot`}
        onClick={() => setCollapsed(false)}
      />
    );
  } else {
    panel = (
      <section className="companion-panel companion-tray">
        <header className="companion-panel-head">
          <div className="companion-panel-title">
            <strong>{headline}</strong>
            <span>{summary}</span>
          </div>
          <button className="companion-close" type="button" onClick={() => setCollapsed(true)} aria-label="收起">×</button>
        </header>
        <div className="companion-slots">
          {slots.map((slot) => (
            <button
              key={slot.attentionId}
              className="companion-slot"
              data-state={slot.state}
              type="button"
              onClick={() => void openSlot(slot)}
            >
              <span className={`state-dot ${slot.state}`} />
              <span className="companion-slot-main">
                <span className="companion-slot-title">
                  <strong>{slot.sessionLabel}</strong>
                  <StatusPill slot={slot} />
                </span>
                <span className="companion-slot-task">{slot.title}</span>
                <span className="companion-slot-path">
                  {slotPath(slot)} · {formatRelativeTime(slot.updatedAt)}
                </span>
              </span>
              <span className="companion-slot-target">↗ {targetLabel(slot)}</span>
            </button>
          ))}
        </div>
      </section>
    );
    pet = (
      <CompanionPet
        state={dominantState}
        count={attentionCount}
        label="收起 Slot companion"
        onClick={() => setCollapsed(true)}
      />
    );
  }

  return (
    <div ref={rootRef} className="desktop-companion" data-testid="desktop-companion">
      {openNotice ? <p className="companion-open-notice" role="status">{openNotice}</p> : null}
      {panel}
      {pet}
    </div>
  );
}
