/* global document, fetch, window */

import React, { useEffect, useMemo, useState } from "https://esm.sh/react@18.3.1";
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client";
import htm from "https://esm.sh/htm@3.1.1";

const html = htm.bind(React.createElement);

const LIFECYCLE_LABEL = {
  clarify: "需求澄清",
  proposal: "拆分提案",
  executing: "执行观测",
};

// --- pure layout helpers (mirror tmux split tree) ---

// Build a split layout that hangs all worker panes off the main pane.
function buildLayoutForWorkers(mainPanelId, workerPanelIds) {
  if (workerPanelIds.length === 0) {
    return { type: "panel", panelId: mainPanelId };
  }
  let workersNode = { type: "panel", panelId: workerPanelIds[0] };
  for (let i = 1; i < workerPanelIds.length; i += 1) {
    workersNode = {
      type: "split",
      direction: "vertical",
      ratio: 1 / (i + 1),
      first: { type: "panel", panelId: workerPanelIds[i] },
      second: workersNode,
    };
  }
  return {
    type: "split",
    direction: "horizontal",
    ratio: 0.4,
    first: { type: "panel", panelId: mainPanelId },
    second: workersNode,
  };
}

function roleLabel(roleCatalog, roleId) {
  return roleCatalog.find((r) => r.id === roleId)?.label ?? roleId;
}

function App() {
  const [state, setState] = useState(null);
  const [toast, setToast] = useState("");

  useEffect(() => {
    fetch(`./mock-state.json?t=${Date.now()}`, { cache: "no-store" })
      .then((response) => response.json())
      .then(setState);
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(""), 2400);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const activeProject = useMemo(() => {
    if (!state) return null;
    return state.projects.find((p) => p.id === state.activeProjectId) ?? state.projects[0];
  }, [state]);

  // terminals under the active project (real shell scopes the terminal tab row to the active project)
  const projectTerminals = useMemo(() => {
    if (!state || !activeProject) return [];
    return state.terminals.filter((t) => t.projectId === activeProject.id);
  }, [state, activeProject]);

  const activeTerminal = useMemo(() => {
    if (!state) return null;
    const inProject = projectTerminals.find((t) => t.id === state.activeTerminalId);
    return inProject ?? projectTerminals[0] ?? null;
  }, [state, projectTerminals]);

  if (!state || !activeProject) {
    return html`<main className="app" />`;
  }

  // mutate the currently active terminal (a terminal == one engineering-rules run).
  const updateActiveTerminal = (mutate, logLine) =>
    setState((current) => ({
      ...current,
      terminals: current.terminals.map((term) => {
        if (term.id !== current.activeTerminalId) return term;
        const next = mutate(term);
        return logLine ? { ...next, logs: [...(next.logs ?? []), logLine] } : next;
      }),
    }));

  const selectProject = (projectId) => {
    setState((current) => {
      const firstTerminal = current.terminals.find((t) => t.projectId === projectId);
      return { ...current, activeProjectId: projectId, activeTerminalId: firstTerminal?.id ?? null };
    });
  };

  const selectTerminal = (terminalId) =>
    setState((current) => ({ ...current, activeTerminalId: terminalId }));

  const addProject = () => {
    setState((current) => {
      const index = current.projects.length + 1;
      const id = `proj_new_${index}`;
      const project = { id, name: `新项目 #${index}`, path: `~/Code/new-project-${index}` };
      const termId = `${id}_shell`;
      const terminal = {
        id: termId,
        projectId: id,
        name: "shell",
        mode: "plain",
        status: "idle",
        session: {
          name: "shell",
          activePanelId: `${termId}_main`,
          panels: [
            {
              id: `${termId}_main`,
              alias: "shell",
              role: "shell",
              command: "zsh",
              tmuxPaneId: "%0",
              lines: [`${project.name} · zsh`, "$ _"],
            },
          ],
          layout: { type: "panel", panelId: `${termId}_main` },
        },
        logs: [],
      };
      return {
        ...current,
        projects: [...current.projects, project],
        terminals: [...current.terminals, terminal],
        activeProjectId: id,
        activeTerminalId: termId,
      };
    });
    setToast("新建项目（默认带一个 shell 终端）");
  };

  // open a new plain terminal in the active project (real flow: terminal opens as a shell).
  const addTerminal = () => {
    setState((current) => {
      const count = current.terminals.filter((t) => t.projectId === current.activeProjectId).length + 1;
      const id = `${current.activeProjectId}_term_${count}`;
      const project = current.projects.find((p) => p.id === current.activeProjectId);
      const terminal = {
        id,
        projectId: current.activeProjectId,
        name: `shell ${count}`,
        mode: "plain",
        status: "idle",
        session: {
          name: `shell-${count}`,
          activePanelId: `${id}_main`,
          panels: [
            {
              id: `${id}_main`,
              alias: "shell",
              role: "shell",
              command: "zsh",
              tmuxPaneId: "%0",
              lines: [`${project?.name ?? ""} · zsh`, "$ _"],
            },
          ],
          layout: { type: "panel", panelId: `${id}_main` },
        },
        logs: [],
      };
      return { ...current, terminals: [...current.terminals, terminal], activeTerminalId: id };
    });
    setToast("新建终端（普通 shell，未开启流程）");
  };

  const focusPanel = (panelId) => {
    updateActiveTerminal((term) => ({ ...term, session: { ...term.session, activePanelId: panelId } }));
  };

  // plain terminal -> engineering-rules flow (clarify phase). Reuses the main pane as the main agent.
  const startFlow = () => {
    updateActiveTerminal(
      (term) => {
        const mainPanel = term.session.panels[0];
        const mainPanelId = mainPanel.id;
        return {
          ...term,
          mode: "flow",
          status: "clarifying",
          lifecycle: "clarify",
          currentStageId: "discuss",
          stages: ["discuss", "plan", "code", "code_review", "finalize"],
          options: { autoApproveSplit: false },
          clarify: {
            messages: [{ from: "agent", text: "engineering-rules 流程已启动。先说说你想做什么，我来澄清意图。" }],
            ready: false,
          },
          proposal: null,
          session: {
            ...term.session,
            activePanelId: mainPanelId,
            panels: [
              {
                ...mainPanel,
                alias: "main",
                role: "main",
                command: "codex",
                lines: ["browser-viewer · codex (main agent)", "> 需求澄清中，未拆分 worker", "main$ _"],
              },
            ],
            layout: { type: "panel", panelId: mainPanelId },
          },
        };
      },
      "engineering-rules 流程已启动 · phase = 需求澄清",
    );
    setToast("已在当前终端开启 engineering-rules 流程");
  };

  const toggleAutoApprove = () => {
    updateActiveTerminal((term) => ({
      ...term,
      options: { ...term.options, autoApproveSplit: !term.options.autoApproveSplit },
    }));
  };

  // clarify -> proposal. If autoApproveSplit, jump straight to executing.
  // source: "user" = 人手动点；"agent" = 模拟主 Agent 判断澄清充分主动触发（rw propose-split）。
  const requestSplit = (source = "user") => {
    const auto = activeTerminal.options.autoApproveSplit;
    const draftWorkers = [
      { id: "d1", role: "code", intent: "实现主 Agent 澄清出的核心改动" },
      { id: "d2", role: "code_review", intent: "审查改动与回归覆盖" },
    ];
    const agentDetected = source === "agent";
    if (auto) {
      applyWorkers(
        draftWorkers,
        agentDetected
          ? "main agent 判断澄清充分 + 自动确认开启，直接 split"
          : "自动确认拆分已开启，跳过人工门，直接 split",
      );
      setToast(agentDetected ? "主 Agent 自主判断澄清充分并直接拆分" : "自动确认：主 Agent 直接拆分并 split pane");
      return;
    }
    updateActiveTerminal(
      (term) => ({
        ...term,
        lifecycle: "proposal",
        status: "need_human",
        clarify: {
          ...term.clarify,
          ready: true,
          messages: agentDetected
            ? [
                ...term.clarify.messages,
                { from: "agent", text: "我判断需求已澄清充分，主动产出 worker 拆分提案（rw propose-split）。" },
              ]
            : term.clarify.messages,
        },
        proposal: {
          summary: agentDetected
            ? "主 Agent 自主判断澄清充分，建议拆以下 worker，可增删/调整后确认："
            : "需求已澄清。主 Agent 建议拆以下 worker，可增删/调整后确认：",
          workers: draftWorkers,
        },
      }),
      agentDetected
        ? "main agent 自主判断澄清充分，调 rw propose-split 产出提案（待人工确认）"
        : "main agent 澄清完成，产出拆分提案（待人工确认）",
    );
    setToast(agentDetected ? "主 Agent 主动弹出拆分提案（Agent 主导）" : "主 Agent 产出 worker 拆分提案");
  };

  const removeWorker = (workerId) => {
    updateActiveTerminal((term) => ({
      ...term,
      proposal: { ...term.proposal, workers: term.proposal.workers.filter((w) => w.id !== workerId) },
    }));
  };

  const addWorker = () => {
    updateActiveTerminal((term) => {
      const nextRole = state.roleCatalog[term.proposal.workers.length % state.roleCatalog.length];
      const worker = {
        id: `w${Date.now()}`,
        role: nextRole.id,
        intent: `${nextRole.label} worker（人工新增）`,
      };
      return { ...term, proposal: { ...term.proposal, workers: [...term.proposal.workers, worker] } };
    });
  };

  // proposal -> executing: confirm and split panes.
  const applyWorkers = (workers, logLine) => {
    updateActiveTerminal(
      (term) => {
        const mainPanel = term.session.panels.find((p) => p.role === "main") ?? term.session.panels[0];
        const workerPanels = workers.map((w, i) => ({
          id: `${term.id}_w${i}`,
          alias: `${w.role}-${i + 1}`,
          role: w.role,
          command: w.role.includes("review") ? "codex --skill review-only" : "codex",
          tmuxPaneId: `%${50 + i}`,
          lines: [`worker · ${w.role}`, `> ${w.intent}`, `${w.role}-${i + 1}$ _`],
        }));
        return {
          ...term,
          lifecycle: "executing",
          status: "running",
          currentStageId: "code",
          loop: term.loop ?? { round: 1, noProgressCount: 0, maxNoProgress: 3, escalated: false, lastReason: null },
          session: {
            ...term.session,
            panels: [mainPanel, ...workerPanels],
            activePanelId: workerPanels[0]?.id ?? mainPanel.id,
            layout: buildLayoutForWorkers(mainPanel.id, workerPanels.map((p) => p.id)),
          },
        };
      },
      logLine,
    );
  };

  const confirmProposal = () => {
    applyWorkers(activeTerminal.proposal.workers, `人工确认拆分（${activeTerminal.proposal.workers.length} worker），split pane`);
    setToast("已确认拆分，左侧终端 split 出 worker pane");
  };

  // loop feedback: a round with progress resets the no-progress counter.
  const loopProgress = () => {
    updateActiveTerminal(
      (term) => ({
        ...term,
        loop: { ...term.loop, round: term.loop.round + 1, noProgressCount: 0 },
      }),
      `round ${activeTerminal.loop.round} 有进展，noProgress 计数清零`,
    );
    setToast("有进展的一轮：计数清零");
  };

  // loop feedback: a round without progress increments the counter; hitting
  // maxNoProgress trips the circuit breaker and escalates to a human.
  const loopNoProgress = () => {
    const nextCount = activeTerminal.loop.noProgressCount + 1;
    const willEscalate = nextCount >= activeTerminal.loop.maxNoProgress;
    updateActiveTerminal(
      (term) => ({
        ...term,
        status: willEscalate ? "need_human" : term.status,
        loop: {
          ...term.loop,
          round: term.loop.round + 1,
          noProgressCount: nextCount,
          escalated: willEscalate,
          lastReason: willEscalate
            ? `连续 ${nextCount} 轮无进展（reviewer 反复 fail / 同类错误重复），自动熔断`
            : term.loop.lastReason,
        },
      }),
      willEscalate
        ? `⏸ 连续 ${nextCount} 轮无进展，熔断升级人工`
        : `round ${activeTerminal.loop.round} 无进展，noProgress=${nextCount}/${activeTerminal.loop.maxNoProgress}`,
    );
    setToast(willEscalate ? "熔断：已升级人工" : `无进展一轮（${nextCount}/${activeTerminal.loop.maxNoProgress}）`);
  };

  // human resumes after escalation: clear breaker, give loop a fresh floor.
  const loopResume = () => {
    updateActiveTerminal(
      (term) => ({
        ...term,
        status: "running",
        loop: { ...term.loop, noProgressCount: 0, escalated: false, lastReason: null },
      }),
      "人工介入后恢复，loop 重新计数",
    );
    setToast("人工已介入，loop 恢复运行");
  };

  return html`
    <main className="app">
      <${ProjectBar}
        projects=${state.projects}
        activeProjectId=${activeProject.id}
        onSelect=${selectProject}
        onAdd=${addProject}
      />
      <${TerminalBar}
        terminals=${projectTerminals}
        activeTerminalId=${activeTerminal?.id}
        onSelect=${selectTerminal}
        onAdd=${addTerminal}
      />
      <section className="workspace">
        ${activeTerminal
          ? html`
              <${TerminalRegion} terminal=${activeTerminal} onFocus=${focusPanel} />
              <${Sidecar}
                terminal=${activeTerminal}
                roleCatalog=${state.roleCatalog}
                onStartFlow=${startFlow}
                onToggleAutoApprove=${toggleAutoApprove}
                onRequestSplit=${requestSplit}
                onRemoveWorker=${removeWorker}
                onAddWorker=${addWorker}
                onConfirmProposal=${confirmProposal}
                onLoopProgress=${loopProgress}
                onLoopNoProgress=${loopNoProgress}
                onLoopResume=${loopResume}
              />
            `
          : null}
      </section>
      ${toast ? html`<div className="toast">${toast}</div>` : null}
    </main>
  `;
}

// Row 1: project tabs — mirrors the real terminal-workspace-shell top toolbar.
function ProjectBar({ projects, activeProjectId, onSelect, onAdd }) {
  const active = projects.find((p) => p.id === activeProjectId);
  return html`
    <div className="project-bar">
      <button className="home-button" title="Home">⌂</button>
      <div className="bar-divider" />
      <div className="project-tabs">
        ${projects.map(
          (project) => html`
            <button
              key=${project.id}
              className=${`project-tab ${project.id === activeProjectId ? "active" : ""}`}
              onClick=${() => onSelect(project.id)}
              title=${project.path}
            >
              <span className="project-name">${project.name}</span>
            </button>
          `,
        )}
      </div>
      <button className="add-project" onClick=${onAdd} title=${active ? active.path : ""}>+ 新项目</button>
    </div>
  `;
}

// Row 2: terminal tabs — each terminal == one run. Flow terminals carry a status dot + flow tag.
function TerminalBar({ terminals, activeTerminalId, onSelect, onAdd }) {
  return html`
    <div className="terminal-bar">
      <div className="terminal-tabs">
        ${terminals.map(
          (term) => html`
            <button
              key=${term.id}
              className=${`terminal-tab ${term.id === activeTerminalId ? "active" : ""}`}
              onClick=${() => onSelect(term.id)}
              title=${term.mode === "flow" ? `${term.name} · ${LIFECYCLE_LABEL[term.lifecycle]}` : `${term.name} · 普通终端`}
            >
              <span className=${`term-status-dot ${term.status}`} />
              <span className="terminal-name">${term.name}</span>
              ${term.mode === "flow"
                ? html`<span className="term-flow-tag">${LIFECYCLE_LABEL[term.lifecycle]}</span>`
                : null}
            </button>
          `,
        )}
      </div>
      <button className="add-terminal" onClick=${onAdd} title="新建终端">+</button>
    </div>
  `;
}

function TerminalRegion({ terminal, onFocus }) {
  const { session } = terminal;
  return html`
    <div className="terminal-region">
      <div className="terminal-toolbar">
        <span className="session-name">
          <span className=${`role-dot ${terminal.mode === "flow" ? "main" : ""}`} />
          <span>${session.name}</span>
        </span>
        <div className="panel-chips">
          ${session.panels.map(
            (panel) => html`
              <button
                key=${panel.id}
                className=${`panel-chip ${panel.id === session.activePanelId ? "active" : ""}`}
                onClick=${() => onFocus(panel.id)}
                title=${`select-pane -t ${panel.tmuxPaneId}`}
              >
                <span className=${`role-dot ${panel.role}`} />
                <span className="chip-name">${panel.alias}</span>
                <span className="pane-id">${panel.tmuxPaneId}</span>
              </button>
            `,
          )}
        </div>
      </div>
      <div className="tmux-canvas">
        <${PaneTree} node=${session.layout} panels=${session.panels} activePanelId=${session.activePanelId} onFocus=${onFocus} />
      </div>
    </div>
  `;
}

function PaneTree({ node, panels, activePanelId, onFocus }) {
  if (node.type === "panel") {
    const panel = panels.find((item) => item.id === node.panelId);
    if (!panel) return null;
    const active = panel.id === activePanelId;
    return html`
      <button className=${`tmux-pane ${active ? "active" : ""}`} onClick=${() => onFocus(panel.id)} aria-label=${`pane ${panel.alias}`}>
        <div className="pane-overlay">
          <span className=${`role-dot ${panel.role}`} />
          <span>${panel.alias}</span>
          <span>${panel.tmuxPaneId}</span>
        </div>
        <div className="terminal-output">
          ${panel.lines.map(
            (line, index) => html`
              <div className="terminal-line" key=${`${panel.id}-${index}`}>
                ${line}${index === panel.lines.length - 1 && active ? html`<span className="cursor" />` : null}
              </div>
            `,
          )}
        </div>
      </button>
    `;
  }

  const firstBasis = `${Math.round(node.ratio * 100)}%`;
  const secondBasis = `${Math.round((1 - node.ratio) * 100)}%`;
  return html`
    <div className=${`tmux-split ${node.direction}`}>
      <div className="split-child" style=${{ flexBasis: firstBasis }}>
        <${PaneTree} node=${node.first} panels=${panels} activePanelId=${activePanelId} onFocus=${onFocus} />
      </div>
      <div className="split-divider" />
      <div className="split-child" style=${{ flexBasis: secondBasis }}>
        <${PaneTree} node=${node.second} panels=${panels} activePanelId=${activePanelId} onFocus=${onFocus} />
      </div>
    </div>
  `;
}

function Sidecar(props) {
  const { terminal } = props;
  const header =
    terminal.mode === "flow"
      ? html`<span className=${`phase-pill ${terminal.lifecycle}`}>${LIFECYCLE_LABEL[terminal.lifecycle]}</span>`
      : html`<span className="observe-badge">普通终端</span>`;
  return html`
    <aside className="sidecar">
      <div className="sidecar-header">
        <span>右侧面板</span>
        ${header}
      </div>
      ${terminal.mode !== "flow" ? html`<${StartFlowPanel} ...${props} />` : null}
      ${terminal.mode === "flow" && terminal.lifecycle === "clarify" ? html`<${ClarifyPanel} ...${props} />` : null}
      ${terminal.mode === "flow" && terminal.lifecycle === "proposal" ? html`<${ProposalPanel} ...${props} />` : null}
      ${terminal.mode === "flow" && terminal.lifecycle === "executing" ? html`<${ObservePanel} ...${props} />` : null}
    </aside>
  `;
}

// Plain terminal: opened as a normal shell. User explicitly starts the engineering-rules flow here.
function StartFlowPanel({ onStartFlow }) {
  return html`
    <div className="start-flow-section">
      <div className="start-flow-title">这是一个普通终端</div>
      <p className="start-flow-desc">
        当前是标准 shell 会话，没有多 Agent 流程。想让主 Agent 接管、驱动
        <code>需求澄清 → 拆分提案 → 执行观测</code> 的 engineering-rules 流程，点下面开启。
      </p>
      <ol className="start-flow-steps">
        <li>主 Agent 在本终端里跑，与你澄清意图</li>
        <li>澄清充分后产出 worker 拆分提案，你确认</li>
        <li>确认后 split 出 worker pane，右侧退回只读观测</li>
      </ol>
      <button className="primary-button" onClick=${onStartFlow}>▶ 在此终端开启 engineering-rules 流程</button>
    </div>
  `;
}

// Phase 1: 需求澄清 — 人主导对话；澄清够了可人手动让主 Agent 拆分，
// 也可由主 Agent 自主判断澄清充分主动弹提案（模拟 rw propose-split）。
function ClarifyPanel({ terminal, onToggleAutoApprove, onRequestSplit }) {
  const auto = terminal.options.autoApproveSplit;
  return html`
    <div className="clarify-section">
      <div className="section-title-row">
        <h3>需求澄清</h3>
        <button className=${`config-toggle ${auto ? "on" : ""}`} onClick=${onToggleAutoApprove} title="开启后主 Agent 拆分时跳过人工确认">
          <span className="config-switch" />
          <span>自动确认拆分</span>
        </button>
      </div>
      <div className="clarify-body">
        ${terminal.clarify.messages.map(
          (msg, index) => html`<div className=${`chat-msg ${msg.from}`} key=${`m-${index}`}>${msg.text}</div>`,
        )}
      </div>
      <div className="clarify-actions">
        <button className="primary-button" onClick=${() => onRequestSplit("user")}>
          ${auto ? "澄清完成 · 自动拆分并执行 →" : "澄清完成 · 让主 Agent 拆分 →"}
        </button>
      </div>
      <button
        className="sim-trigger"
        onClick=${() => onRequestSplit("agent")}
        title="模拟主 Agent 自己判断澄清充分、主动调 rw propose-split 触发提案"
      >
        ▶ 模拟主 Agent 判断澄清充分（Agent 主导）
      </button>
    </div>
  `;
}

// Phase 2: 拆分提案 — 主 Agent 产出 worker 提案 + 验收用例草案，人一并确认。
function ProposalPanel({ terminal, roleCatalog, onRemoveWorker, onAddWorker, onConfirmProposal }) {
  const acceptance = terminal.proposal.acceptance;
  return html`
    <div className="proposal-section">
      <div className="section-title-row">
        <h3>Worker 拆分提案</h3>
      </div>
      <p className="proposal-summary">${terminal.proposal.summary}</p>
      ${terminal.proposal.workers.map(
        (worker) => html`
          <div className="worker-card" key=${worker.id}>
            <span className="worker-role"><span className=${`role-dot ${worker.role}`} />${roleLabel(roleCatalog, worker.role)}</span>
            <span className="worker-intent" title=${worker.intent}>${worker.intent}</span>
            <button className="worker-remove" onClick=${() => onRemoveWorker(worker.id)} title="移除此 worker">×</button>
          </div>
        `,
      )}
      <button className="add-worker" onClick=${onAddWorker}>+ 加一个 worker</button>

      ${acceptance
        ? html`
            <div className="acceptance-draft">
              <div className="section-title-row"><h3>${acceptance.title}</h3></div>
              <p className="acceptance-hint">主 Agent 把澄清目标落成可观测验收用例，由 behavior_verify worker 跑。与拆分一并确认。</p>
              <ol className="acceptance-list">
                ${acceptance.cases.map((c, i) => html`<li key=${`ac-${i}`}>${c}</li>`)}
              </ol>
            </div>
          `
        : null}

      <div className="proposal-actions">
        <button
          className="primary-button"
          disabled=${terminal.proposal.workers.length === 0}
          onClick=${onConfirmProposal}
        >
          确认拆分 · split ${terminal.proposal.workers.length} 个 pane →
        </button>
      </div>
    </div>
  `;
}

// Phase 3: 执行观测 — observe-only：loop 状态条（含无进展熔断）+ log。
function ObservePanel({ terminal, onLoopProgress, onLoopNoProgress, onLoopResume }) {
  const loop = terminal.loop ?? { round: 1, noProgressCount: 0, maxNoProgress: 3, escalated: false, lastReason: null };
  const ratio = loop.maxNoProgress > 0 ? loop.noProgressCount / loop.maxNoProgress : 0;
  const level = loop.escalated ? "escalated" : ratio >= 0.66 ? "warn" : "ok";
  return html`
    <div className="observe-section">
      <div className="section-title-row">
        <h3>Loop 状态</h3>
        <span className="observe-badge">OBSERVE ONLY</span>
      </div>
      <div className=${`loop-bar ${level}`}>
        <div className="loop-row">
          <span className="loop-label">轮次</span>
          <span className="loop-value">round ${loop.round}</span>
        </div>
        <div className="loop-row">
          <span className="loop-label">无进展</span>
          <span className="loop-value">${loop.noProgressCount} / ${loop.maxNoProgress}</span>
        </div>
        <div className="loop-track">
          ${Array.from({ length: loop.maxNoProgress }).map(
            (_, i) => html`<span className=${`loop-pip ${i < loop.noProgressCount ? "filled" : ""} ${level}`} key=${`pip-${i}`} />`,
          )}
        </div>
      </div>

      ${loop.escalated
        ? html`
            <div className="escalation-card">
              <strong>⏸ 已熔断 · 升级人工</strong>
              <p>${loop.lastReason}</p>
              <button className="primary-button" onClick=${onLoopResume}>人工已介入 · 恢复 loop →</button>
            </div>
          `
        : html`
            <div className="loop-sim">
              <span className="loop-sim-hint">模拟 loop 反馈（原型辅助）：</span>
              <div className="loop-sim-actions">
                <button className="loop-sim-btn ok" onClick=${onLoopProgress}>✓ 有进展的一轮</button>
                <button className="loop-sim-btn bad" onClick=${onLoopNoProgress}>✗ 无进展的一轮</button>
              </div>
              <p className="loop-sim-note">连续 ${loop.maxNoProgress} 轮无进展将自动熔断、把控制权交回人。</p>
            </div>
          `}

      <${AcceptanceEvidence} acceptance=${terminal.acceptance} />

      <div className="section-title-row" style=${{ marginTop: "14px" }}>
        <h3>Log</h3>
      </div>
      <div className="log-body">
        ${terminal.logs
          .slice()
          .reverse()
          .map((line, index) => html`<div className="log-line" key=${`${index}-${line}`}>${line}</div>`)}
      </div>
    </div>
  `;
}

// 行为验证证据：behavior_verify worker 按验收用例跑出来的 pass/fail + 证据，
// 失败用例自动抛回 code agent（verify <-> code 子循环）。
function AcceptanceEvidence({ acceptance }) {
  if (!acceptance) return null;
  const cases = acceptance.cases ?? [];
  const passed = cases.filter((c) => c.status === "pass").length;
  const failed = cases.filter((c) => c.status === "fail").length;
  return html`
    <div className="acceptance-evidence">
      <div className="section-title-row" style=${{ marginTop: "14px" }}>
        <h3>${acceptance.title}</h3>
        <span className="acceptance-tally">${passed}✓ ${failed > 0 ? html`<span className="fail-count">${failed}✗</span>` : ""}</span>
      </div>
      ${cases.map(
        (c) => html`
          <div className=${`evidence-card ${c.status}`} key=${c.id}>
            <span className=${`evidence-mark ${c.status}`}>${c.status === "pass" ? "✓" : "✗"}</span>
            <div className="evidence-body">
              <div className="evidence-text">${c.text}</div>
              <div className="evidence-meta">${c.evidence}</div>
              ${c.status === "fail" ? html`<div className="evidence-bounce">→ 已抛回 code agent 修复</div>` : null}
            </div>
          </div>
        `,
      )}
    </div>
  `;
}

createRoot(document.getElementById("root")).render(html`<${App} />`);
