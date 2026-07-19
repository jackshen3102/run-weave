/* global URLSearchParams, document, fetch, setTimeout, window */

const app = document.querySelector("#app");
const params = new URLSearchParams(window.location.search);
const requestedScenario = params.get("scenario");

const STATE_PRIORITY = {
  needs_action: 600,
  blocked: 500,
  failed: 400,
  completed: 300,
  working: 200,
  idle: 100,
};

const STATUS_SUMMARY_LABEL = {
  needs_action: "待决定",
  blocked: "验收受阻",
  failed: "异常退出",
  completed: "完成待查看",
  working: "执行中",
};

const state = {
  baseData: null,
  sourceSlots: [],
  data: null,
  scenarioStates: null,
  open: true,
  escalationDismissed: false,
  focused: false,
  activeSlotId: null,
  scenarioId: null,
  toast: null,
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeSnapshot(base, patch) {
  if (patch === null || !isObject(patch)) {
    return Array.isArray(patch)
      ? patch.map((item) => mergeSnapshot(null, item))
      : patch;
  }
  const result = isObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    result[key] = isObject(value)
      ? mergeSnapshot(result[key], value)
      : Array.isArray(value)
        ? value.map((item) => mergeSnapshot(null, item))
        : value;
  }
  return result;
}

function basename(value) {
  const normalized = value?.trim().replace(/[\\/]+$/u, "");
  return normalized?.split(/[\\/]/u).filter(Boolean).at(-1) ?? null;
}

function formatSessionLabel(session) {
  const baseLabel =
    session.alias?.trim() || basename(session.cwd) || "Terminal";
  const activeCommand = basename(session.activeCommand);
  return activeCommand === "codex" ? `${baseLabel}(codex)` : baseLabel;
}

function formatRelativeTime(value) {
  const now = Date.parse(state.baseData.capturedAt);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(now) || !Number.isFinite(timestamp)) return value || "-";
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return seconds < 10 ? "刚刚" : `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function formatMenuTime(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(timestamp);
}

function getProjectName(projectContext) {
  return (
    state.baseData.projects.find(
      (project) => project.projectId === projectContext.parentProjectId,
    )?.name ?? projectContext.name
  );
}

function getSkippedAcceptance(run) {
  return (
    run.acceptance?.find(
      (item) => item.status === "pending" && item.lastRunStatus === "skipped",
    ) ?? null
  );
}

function getWorkerPanelId(run, role) {
  return (
    run.workers?.find((worker) => worker.role === role && worker.panelId)
      ?.panelId ?? null
  );
}

function getAgentTeamPanelId(run, preferredRole) {
  return (
    run.pendingFindingDecision?.outbox?.panelId ??
    run.frameworkRepair?.target?.panelId ??
    run.activeWorkerDispatch?.panelId ??
    getWorkerPanelId(run, preferredRole ?? run.activeWorkerRole) ??
    run.mainPanelId ??
    null
  );
}

function getPanelLabel(rawSlot, panelId, fallbackRole) {
  if (panelId && rawSlot.panelSnapshot?.panelId === panelId) {
    return (
      rawSlot.panelSnapshot.alias?.trim() ||
      rawSlot.panelSnapshot.role?.split(":").at(-1) ||
      "main"
    );
  }
  return fallbackRole || (panelId ? "main" : null);
}

function buildAttention(rawSlot, values) {
  const { terminalSession, projectContext } = rawSlot;
  const targetPanelId = values.targetPanelId ?? null;
  const panelLabel = getPanelLabel(
    rawSlot,
    targetPanelId,
    values.targetPanelRole ?? null,
  );
  const sourceKind = values.sourceKind;
  return {
    id: rawSlot.id,
    projectId: projectContext.projectId,
    parentProjectId: projectContext.parentProjectId,
    project: getProjectName(projectContext),
    worktree: projectContext.name,
    branch: projectContext.branch ?? "detached",
    terminalSessionId: terminalSession.terminalSessionId,
    sessionLabel: formatSessionLabel(terminalSession),
    displayPanelId: targetPanelId ?? terminalSession.activePanelId ?? null,
    targetPanelId,
    panelLabel:
      panelLabel ||
      rawSlot.panelSnapshot?.alias ||
      rawSlot.panelSnapshot?.role ||
      "main",
    agent: terminalSession.terminalState?.agent ?? "shell",
    state: values.state,
    statusLabel: values.statusLabel,
    statusDetail: values.statusDetail,
    statusSource: values.statusSource,
    statusEvidence: values.statusEvidence,
    priority: STATE_PRIORITY[values.state],
    lastActivityAt: values.lastActivityAt ?? terminalSession.lastActivityAt,
    lastActivity: formatRelativeTime(
      values.lastActivityAt ?? terminalSession.lastActivityAt,
    ),
    task: values.task,
    actionLabel:
      sourceKind === "agent_team" ? "打开 Agent Team" : "打开 Terminal",
    targetSurface: sourceKind === "agent_team" ? "agent-team" : "terminal",
    targetLabel: sourceKind === "agent_team" ? "Agent Team" : "Terminal",
    runId: rawSlot.agentTeamRun?.runId ?? null,
    sourceKind,
    sidecarTool: sourceKind === "agent_team" ? "agent-team" : null,
    sidecarLabel: sourceKind === "agent_team" ? "Agent Team" : null,
    terminalLines: (rawSlot.terminalHistory?.scrollback ?? "")
      .split("\n")
      .filter(Boolean)
      .slice(-8),
    raw: rawSlot,
  };
}

function deriveAgentTeamAttention(rawSlot) {
  const run = rawSlot.agentTeamRun;
  if (!run || run.status === "done") return null;

  const skipped = getSkippedAcceptance(run);
  const frameworkBlocked = run.frameworkRepair?.result === "blocked";
  const findingDecision = run.pendingFindingDecision;

  if (run.status === "need_human" && findingDecision) {
    return buildAttention(rawSlot, {
      state: "needs_action",
      statusLabel: "需要你决定",
      statusDetail:
        findingDecision.reason ||
        run.loop?.lastReason ||
        "Agent Team 等待人工裁决",
      statusSource: "AgentTeamRun",
      statusEvidence: "status=need_human;pendingFindingDecision!=null",
      task: findingDecision.finding?.title || run.task,
      sourceKind: "agent_team",
      targetPanelId: getAgentTeamPanelId(run, "code_review"),
      targetPanelRole: "code_review",
      lastActivityAt: run.updatedAt,
    });
  }

  if (run.status === "need_human" && (frameworkBlocked || skipped)) {
    return buildAttention(rawSlot, {
      state: "blocked",
      statusLabel: "验收受阻",
      statusDetail:
        run.loop?.lastReason ||
        run.frameworkRepair?.reason ||
        skipped?.skipReason ||
        "Agent Team 已暂停",
      statusSource: "AgentTeamRun",
      statusEvidence: frameworkBlocked
        ? "status=need_human;frameworkRepair.result=blocked"
        : "status=need_human;acceptance[*].lastRunStatus=skipped",
      task: skipped ? `${skipped.caseId} · ${skipped.text}` : run.task,
      sourceKind: "agent_team",
      targetPanelId: getAgentTeamPanelId(run, "behavior_verify"),
      targetPanelRole: "behavior_verify",
      lastActivityAt: run.updatedAt,
    });
  }

  if (run.status === "need_human") {
    return buildAttention(rawSlot, {
      state: "needs_action",
      statusLabel: "需要你处理",
      statusDetail:
        run.loop?.lastReason || run.logs?.at(-1) || "Agent Team 已暂停",
      statusSource: "AgentTeamRun",
      statusEvidence: "status=need_human",
      task: run.task,
      sourceKind: "agent_team",
      targetPanelId: getAgentTeamPanelId(run),
      targetPanelRole: run.activeWorkerRole,
      lastActivityAt: run.updatedAt,
    });
  }

  if (run.status === "failed") {
    return buildAttention(rawSlot, {
      state: "failed",
      statusLabel: "执行失败",
      statusDetail: run.logs?.at(-1) || "Agent Team Run 已失败",
      statusSource: "AgentTeamRun",
      statusEvidence: "status=failed",
      task: run.task,
      sourceKind: "agent_team",
      targetPanelId: getAgentTeamPanelId(run),
      targetPanelRole: run.activeWorkerRole,
      lastActivityAt: run.updatedAt,
    });
  }

  if (run.status === "running") {
    const role = run.activeWorkerRole;
    return buildAttention(rawSlot, {
      state: "working",
      statusLabel: "Agent Team 执行中",
      statusDetail: role
        ? `Round ${run.loop?.round ?? "-"} · ${role} 正在执行`
        : `Round ${run.loop?.round ?? "-"} · Run 正在执行`,
      statusSource: "AgentTeamRun",
      statusEvidence: role
        ? `status=running;activeWorkerRole=${role}`
        : "status=running",
      task: run.task,
      sourceKind: "agent_team",
      targetPanelId: getAgentTeamPanelId(run),
      targetPanelRole: role,
      lastActivityAt: run.updatedAt,
    });
  }

  return null;
}

function deriveTerminalAttention(rawSlot) {
  const session = rawSlot.terminalSession;
  const terminalState = session.terminalState;
  const panel = rawSlot.panelSnapshot;

  if (session.status === "exited" && Number(session.exitCode ?? 0) !== 0) {
    const panelId =
      panel?.status === "exited" && Number(panel.exitCode ?? 0) !== 0
        ? panel.panelId
        : null;
    return buildAttention(rawSlot, {
      state: "failed",
      statusLabel: "异常退出",
      statusDetail: `Terminal 已退出 · exit code ${session.exitCode}`,
      statusSource: "TerminalSessionListItem",
      statusEvidence: `status=exited;exitCode=${session.exitCode}`,
      task: session.preview || "Terminal 进程异常退出",
      sourceKind: "terminal",
      targetPanelId: panelId,
      lastActivityAt: session.lastActivityAt,
    });
  }

  if (session.completionRevision > session.acknowledgedCompletionRevision) {
    const event = rawSlot.completionEvent;
    const eventMatches =
      event?.kind === "completion" &&
      event.payload?.completionRevision === session.completionRevision;
    return buildAttention(rawSlot, {
      state: "completed",
      statusLabel: "完成待查看",
      statusDetail: `${eventMatches ? event.payload.source : terminalState?.agent || "Agent"} completion 尚未确认`,
      statusSource: "TerminalSessionListItem",
      statusEvidence: "completionRevision>acknowledgedCompletionRevision",
      task:
        (eventMatches ? event.payload.summary : null) ||
        session.preview ||
        "Terminal 本轮已完成",
      sourceKind: "terminal",
      targetPanelId: eventMatches ? event.payload.panelId : null,
      lastActivityAt: eventMatches ? event.createdAt : session.lastActivityAt,
    });
  }

  if (
    terminalState?.state === "agent_running" ||
    terminalState?.state === "agent_starting"
  ) {
    const panelHasActiveAgent =
      panel?.terminalState?.state === "agent_running" ||
      panel?.terminalState?.state === "agent_starting";
    const agent = terminalState.agent || "Agent";
    return buildAttention(rawSlot, {
      state: "working",
      statusLabel:
        terminalState.state === "agent_starting" ? "正在启动" : "执行中",
      statusDetail:
        terminalState.state === "agent_starting"
          ? `${agent} 正在启动`
          : `${agent} 正在执行`,
      statusSource: "TerminalSessionListItem",
      statusEvidence: `terminalState.state=${terminalState.state}`,
      task: session.preview || `${agent} 正在执行`,
      sourceKind: "terminal",
      targetPanelId: panelHasActiveAgent ? panel.panelId : null,
      lastActivityAt: session.lastActivityAt,
    });
  }

  return buildAttention(rawSlot, {
    state: "idle",
    statusLabel: "空闲",
    statusDetail:
      terminalState?.state === "agent_idle"
        ? "Agent 等待输入"
        : "Shell 当前空闲",
    statusSource: "TerminalSessionListItem",
    statusEvidence: `terminalState.state=${terminalState?.state ?? "unavailable"}`,
    task: session.preview || "等待下一条指令",
    sourceKind: "terminal",
    targetPanelId: panel?.panelId ?? null,
    lastActivityAt: session.lastActivityAt,
  });
}

function deriveSlot(rawSlot) {
  return deriveAgentTeamAttention(rawSlot) ?? deriveTerminalAttention(rawSlot);
}

function buildHeadline(slots) {
  const counts = Object.fromEntries(
    Object.keys(STATUS_SUMMARY_LABEL).map((key) => [
      key,
      slots.filter((slot) => slot.state === key).length,
    ]),
  );
  const attentionCount =
    counts.needs_action + counts.blocked + counts.failed + counts.completed;
  const activeCount = attentionCount + counts.working;
  const headline = attentionCount
    ? `${attentionCount} 个 Slot 需要关注`
    : counts.working
      ? `${counts.working} 个 Slot 正在执行`
      : "所有 Slot 都安静";
  const summary = Object.entries(STATUS_SUMMARY_LABEL)
    .filter(([key]) => counts[key] > 0)
    .map(([key, label]) => `${counts[key]} ${label}`)
    .join(" · ");
  return {
    headline,
    summary: summary || "没有未确认事实或活跃 Agent",
    activeCount,
  };
}

function rebuildDerivedData() {
  const slots = state.sourceSlots.map(deriveSlot);
  state.data = {
    appName: state.baseData.appName,
    capturedAt: state.baseData.capturedAt,
    connection: state.baseData.connection,
    projects: state.baseData.projects,
    slots,
    ...buildHeadline(slots),
  };
}

function getSlots() {
  return [...state.data.slots].sort(
    (left, right) =>
      right.priority - left.priority ||
      Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt),
  );
}

function getActiveSlot() {
  return (
    state.data.slots.find((slot) => slot.id === state.activeSlotId) ??
    state.data.slots[0]
  );
}

function countAttentionSlots() {
  return state.data.slots.filter((slot) =>
    ["needs_action", "blocked", "failed", "completed"].includes(slot.state),
  ).length;
}

function getDominantState() {
  return getSlots()[0]?.state ?? "idle";
}

function hasActiveSlots() {
  return state.data.slots.some((slot) => slot.state !== "idle");
}

function isEscalationState(name) {
  return ["needs_action", "blocked"].includes(name);
}

function renderStatusPill(slot) {
  return `<span class="status-pill ${escapeHtml(slot.state)}"><span class="state-dot ${escapeHtml(slot.state)}"></span>${escapeHtml(slot.statusLabel)}</span>`;
}

function renderIntentAttributes(slot) {
  return [
    `data-connection-id="${escapeHtml(state.data.connection.id)}"`,
    `data-project-id="${escapeHtml(slot.projectId)}"`,
    `data-terminal-session-id="${escapeHtml(slot.terminalSessionId)}"`,
    `data-panel-id="${escapeHtml(slot.targetPanelId)}"`,
    `data-run-id="${escapeHtml(slot.runId)}"`,
    `data-target-surface="${escapeHtml(slot.targetSurface)}"`,
    `data-status-source="${escapeHtml(slot.statusSource)}"`,
    `data-status-evidence="${escapeHtml(slot.statusEvidence)}"`,
  ].join(" ");
}

function renderPet() {
  const dominantState = getDominantState();
  const attentionCount = countAttentionSlots();
  const quietOnly = !hasActiveSlots();
  return `
    <button class="pet-button pet-mode-${escapeHtml(dominantState)}" type="button" data-action="toggle" aria-label="${quietOnly ? "所有 Slot 均安静" : state.open ? "收起 Slot companion" : "打开 Slot companion"}" ${quietOnly ? "disabled" : ""}>
      <span class="pet-aura"></span>
      <span class="pet-shadow"></span>
      <span class="pet-body" aria-hidden="true">
        <span class="pet-ear left"></span>
        <span class="pet-ear right"></span>
        <span class="pet-face">
          <span class="pet-eye left"></span>
          <span class="pet-eye right"></span>
          <span class="pet-mouth"></span>
        </span>
      </span>
      ${attentionCount > 0 ? `<span class="pet-state-badge ${escapeHtml(dominantState)}">${attentionCount}</span>` : ""}
    </button>
  `;
}

function renderDesktopChrome() {
  return `
    <div class="mac-menubar" aria-hidden="true">
      <div class="menubar-side">
        <span class="apple-mark">●</span>
        <strong>Runweave</strong>
        <span>File</span>
        <span>View</span>
        <span>Window</span>
      </div>
      <div class="menubar-side">
        <span>◌</span>
        <span>⌁</span>
        <span>${escapeHtml(formatMenuTime(state.data.capturedAt))}</span>
      </div>
    </div>
  `;
}

function renderWorktreeRail(activeSlot) {
  const worktrees = [];
  for (const slot of state.data.slots) {
    if (!worktrees.some((item) => item.projectId === slot.projectId)) {
      worktrees.push(slot);
    }
  }
  return `
    <aside class="worktree-rail">
      <div class="rail-header"><span>Worktrees ${worktrees.length}</span><span>‹</span></div>
      <div class="worktree-list">
        ${worktrees
          .map(
            (slot) => `
              <button class="worktree-row ${slot.projectId === activeSlot.projectId ? "active" : ""}" type="button" data-slot-id="${escapeHtml(slot.id)}" ${renderIntentAttributes(slot)} aria-label="打开 ${escapeHtml(slot.worktree)}">
                <span class="worktree-dot ${escapeHtml(slot.state)}"></span>
                <span class="worktree-copy">
                  <strong>${escapeHtml(slot.worktree)}</strong>
                  <span>${escapeHtml(slot.branch)}</span>
                </span>
              </button>
            `,
          )
          .join("")}
      </div>
    </aside>
  `;
}

function renderSessionTabs(activeSlot) {
  const sessions = state.data.slots.filter(
    (slot) => slot.projectId === activeSlot.projectId,
  );
  return `
    <div class="session-tabs" role="tablist" aria-label="Terminal sessions">
      ${sessions
        .map(
          (slot) => `
            <button class="session-tab ${slot.id === activeSlot.id ? "active" : ""}" type="button" role="tab" aria-selected="${slot.id === activeSlot.id}" data-slot-id="${escapeHtml(slot.id)}" ${renderIntentAttributes(slot)}>
              <span class="state-dot ${escapeHtml(slot.state)}"></span>
              <span class="session-tab-label">${escapeHtml(slot.sessionLabel)}</span>
            </button>
          `,
        )
        .join("")}
      <span class="session-tab-add" aria-hidden="true">＋</span>
    </div>
  `;
}

function renderTerminalPane(activeSlot) {
  return `
    <section class="terminal-pane" aria-label="Terminal ${escapeHtml(activeSlot.sessionLabel)}">
      <div class="panel-target-bar">
        <span>${escapeHtml(activeSlot.worktree)} /</span>
        <span class="panel-chip active"><span class="state-dot ${escapeHtml(activeSlot.state)}"></span>${escapeHtml(activeSlot.panelLabel)}</span>
        <span class="window-spacer"></span>
        <span>▥</span><span>⊞</span>
      </div>
      <div class="terminal-output">
        ${activeSlot.terminalLines
          .map((line) => `<div class="terminal-line">${escapeHtml(line)}</div>`)
          .join("")}
        <span class="terminal-cursor"></span>
      </div>
      <div class="composer">Ask ${escapeHtml(activeSlot.agent)} or type a command...</div>
    </section>
  `;
}

function renderSidecar(activeSlot) {
  if (activeSlot.sidecarTool !== "agent-team") return "";
  const run = activeSlot.raw.agentTeamRun;
  return `
    <aside class="sidecar-pane" aria-label="Agent Team sidecar">
      <div class="sidecar-tools" role="tablist" aria-label="Sidecar tools">
        <span class="sidecar-tool">Preview</span>
        <span class="sidecar-tool">Browser</span>
        <span class="sidecar-tool active">Agent Team</span>
        <span class="window-spacer"></span><span class="window-action">×</span>
      </div>
      <div class="sidecar-subnav">
        <span class="sidecar-subtab active">${escapeHtml(run.runId)}</span>
        <span class="window-spacer"></span>
        <span class="slot-path">${escapeHtml(activeSlot.worktree)}${activeSlot.targetPanelId ? ` / ${escapeHtml(activeSlot.panelLabel)}` : ""}</span>
      </div>
      <div class="sidecar-body">
        <article class="sidecar-context-card">
          <div class="context-card-head">
            <span class="context-eyebrow">${escapeHtml(activeSlot.statusLabel)}</span>
            <strong>${escapeHtml(run.task)}</strong>
            <span>${escapeHtml(activeSlot.statusDetail)}</span>
          </div>
          <div class="context-metrics">
            <div class="context-metric"><span>Run</span><strong>${escapeHtml(run.runId)}</strong></div>
            <div class="context-metric"><span>Round</span><strong>${escapeHtml(run.loop?.round ?? "-")}</strong></div>
            <div class="context-metric"><span>Worker</span><strong>${escapeHtml(run.activeWorkerRole ?? "-")}</strong></div>
          </div>
        </article>
      </div>
    </aside>
  `;
}

function renderRunweaveWindow() {
  const activeSlot = getActiveSlot();
  const hasSidecar = activeSlot.sidecarTool === "agent-team";
  return `
    <section class="runweave-window ${state.focused ? "focused" : ""}" data-active-slot-id="${escapeHtml(activeSlot.id)}" data-active-panel-id="${escapeHtml(activeSlot.targetPanelId)}" data-active-target-surface="${escapeHtml(activeSlot.targetSurface)}" data-active-sidecar-tool="${hasSidecar ? "agent-team" : ""}" ${renderIntentAttributes(activeSlot)}>
      <header class="window-titlebar">
        <div class="traffic-lights" aria-hidden="true"><span></span><span></span><span></span></div>
        <div class="app-brand"><span class="brand-glyph">R</span><span>${escapeHtml(state.data.appName)}</span></div>
        <span class="connection-pill">${escapeHtml(state.data.connection.name)}</span>
        <nav class="project-tabs" aria-label="Projects">
          ${state.data.projects.map((project) => `<span class="project-tab active">${escapeHtml(project.name)}</span>`).join("")}
        </nav>
        <span class="window-spacer"></span>
        <span class="window-action">⌁</span>
        <span class="window-action">•••</span>
      </header>
      <div class="workspace-grid">
        ${renderWorktreeRail(activeSlot)}
        <section class="terminal-workspace">
          ${renderSessionTabs(activeSlot)}
          <div class="terminal-split ${hasSidecar ? "" : "terminal-only"}">
            ${renderTerminalPane(activeSlot)}
            ${renderSidecar(activeSlot)}
          </div>
        </section>
      </div>
    </section>
  `;
}

function renderAttentionCard(primary) {
  return `<section class="overlay-panel attention-card slot-escalation" aria-label="Primary Slot attention">
    <div class="overlay-head">
      ${renderStatusPill(primary)}
      <div class="overlay-title"><strong>${escapeHtml(primary.project)} / ${escapeHtml(primary.worktree)}</strong><span>${escapeHtml(primary.lastActivity)}</span></div>
      <button class="overlay-close" type="button" data-action="dismiss-escalation" aria-label="收起">×</button>
    </div>
    <div class="attention-body">
      <h2>${escapeHtml(primary.task)}</h2>
      <p>${escapeHtml(primary.statusDetail)}</p>
      <div class="attention-actions">
        <button class="ghost-action" type="button" data-action="dismiss-escalation">暂时收起</button>
        <button class="primary-action" type="button" data-slot-id="${escapeHtml(primary.id)}" ${renderIntentAttributes(primary)}>${escapeHtml(primary.actionLabel)} →</button>
      </div>
    </div>
  </section>`;
}

function formatSlotPath(slot) {
  return [
    slot.worktree,
    slot.sessionLabel,
    ...(slot.targetPanelId ? [slot.panelLabel] : []),
  ].join(" / ");
}

function renderCompanion() {
  const slots = getSlots().filter((slot) => slot.state !== "idle");
  const primary = getSlots()[0];
  const showEscalation =
    state.open &&
    !state.escalationDismissed &&
    isEscalationState(primary?.state);
  return `
    <div class="slot-companion-anchor">
      ${
        showEscalation
          ? renderAttentionCard(primary)
          : state.open && slots.length > 0
            ? `<section class="overlay-panel slot-tray" aria-label="Active Slot tray">
                <div class="overlay-head">
                  <div class="overlay-title"><strong>${escapeHtml(state.data.headline)}</strong><span>${escapeHtml(state.data.summary)}</span></div>
                  <button class="overlay-close" type="button" data-action="close" aria-label="收起">×</button>
                </div>
                <div class="slot-list">
                  ${slots
                    .map(
                      (
                        slot,
                      ) => `<button class="slot-row ${slot.id === state.activeSlotId ? "active" : ""}" type="button" data-slot-id="${escapeHtml(slot.id)}" ${renderIntentAttributes(slot)}>
                        <span class="state-dot ${escapeHtml(slot.state)}"></span>
                        <span class="slot-row-main">
                          <span class="slot-row-title"><strong>${escapeHtml(slot.sessionLabel)}</strong>${renderStatusPill(slot)}</span>
                          <span class="slot-row-task">${escapeHtml(slot.task)}</span>
                          <span class="slot-path slot-row-path">${escapeHtml(formatSlotPath(slot))} · ${escapeHtml(slot.lastActivity)}</span>
                        </span>
                        <span class="slot-row-sidecar">↗ ${escapeHtml(slot.targetLabel)}</span>
                      </button>`,
                    )
                    .join("")}
                </div>
              </section>`
            : ""
      }
      ${renderPet()}
    </div>
  `;
}

function applyScenario(scenarioId) {
  const scenario = state.scenarioStates.scenarios[scenarioId];
  if (!scenario) return;
  state.sourceSlots = state.baseData.slots.map((slot) =>
    mergeSnapshot(slot, scenario.slotPatches[slot.id] ?? {}),
  );
  state.scenarioId = scenarioId;
  state.activeSlotId = scenario.activeSlotId;
  state.escalationDismissed = false;
  rebuildDerivedData();
  state.open = hasActiveSlots();
}

function render() {
  app.dataset.scenario = state.scenarioId;
  app.innerHTML = `
    ${renderDesktopChrome()}
    ${renderRunweaveWindow()}
    <aside class="companion-layer" aria-label="Runweave Slot companion">
      ${renderCompanion()}
    </aside>
    ${state.toast ? `<div class="focus-toast" role="status">${escapeHtml(state.toast)}</div>` : ""}
  `;
}

function acknowledgeCompletion(slotId) {
  const source = state.sourceSlots.find((item) => item.id === slotId);
  if (!source) return;
  const session = source.terminalSession;
  if (session.completionRevision <= session.acknowledgedCompletionRevision) {
    return;
  }
  session.acknowledgedCompletionRevision = session.completionRevision;
  rebuildDerivedData();
}

function focusSlot(slotId) {
  const slot = state.data.slots.find((item) => item.id === slotId);
  if (!slot) return;
  state.activeSlotId = slot.id;
  state.focused = true;
  const targetPath = formatSlotPath(slot);
  state.toast =
    slot.targetSurface === "terminal"
      ? `已定位到 ${targetPath}`
      : `已定位到 ${targetPath}，已打开 Agent Team`;
  if (slot.state === "completed") {
    acknowledgeCompletion(slot.id);
  }
  if (!state.escalationDismissed && isEscalationState(slot.state)) {
    state.escalationDismissed = true;
    state.open = true;
  } else {
    state.open = false;
  }
  render();
  window.clearTimeout(focusSlot.toastTimer);
  focusSlot.toastTimer = setTimeout(() => {
    state.toast = null;
    render();
  }, 2400);
}

function bindInteractions() {
  app.addEventListener("click", (event) => {
    const target = event.target.closest("button");
    if (!target) return;

    if (target.dataset.action === "toggle") {
      if (!hasActiveSlots()) return;
      state.open = !state.open;
      render();
      return;
    }
    if (target.dataset.action === "dismiss-escalation") {
      state.escalationDismissed = true;
      state.open = true;
      render();
      return;
    }
    if (target.dataset.action === "close") {
      state.open = false;
      render();
      return;
    }
    if (target.dataset.slotId) {
      focusSlot(target.dataset.slotId);
    }
  });
}

function renderLoadError(error) {
  app.innerHTML = "";
  const panel = document.createElement("pre");
  panel.style.margin = "0";
  panel.style.padding = "20px";
  panel.style.color = "#ff607f";
  panel.style.whiteSpace = "pre-wrap";
  panel.textContent = [
    "无法加载原型状态数据。",
    "",
    String(error.stack ?? error),
    "",
    "请通过本地 HTTP server 打开原型。",
  ].join("\n");
  app.append(panel);
}

Promise.all([
  fetch("./mock-state.json", { cache: "no-store" }),
  fetch("./scenario-states.json", { cache: "no-store" }),
])
  .then(async ([baseResponse, scenarioResponse]) => {
    if (!baseResponse.ok) {
      throw new Error(`HTTP ${baseResponse.status} ${baseResponse.statusText}`);
    }
    if (!scenarioResponse.ok) {
      throw new Error(
        `HTTP ${scenarioResponse.status} ${scenarioResponse.statusText}`,
      );
    }
    return await Promise.all([baseResponse.json(), scenarioResponse.json()]);
  })
  .then(([baseData, scenarioStates]) => {
    if (!Array.isArray(baseData.slots)) {
      throw new Error(
        `Invalid mock state: missing slots (${Object.keys(baseData).join(", ")})`,
      );
    }
    const scenarioId = Object.hasOwn(
      scenarioStates.scenarios,
      requestedScenario ?? "",
    )
      ? requestedScenario
      : scenarioStates.defaultScenario;
    state.baseData = baseData;
    state.scenarioStates = scenarioStates;
    applyScenario(scenarioId);
    bindInteractions();
    render();
  })
  .catch(renderLoadError);
