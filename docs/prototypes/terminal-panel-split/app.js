/* global document, fetch, window */

import React, { useEffect, useMemo, useState } from "https://esm.sh/react@18.3.1";
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client";
import htm from "https://esm.sh/htm@3.1.1";

const html = htm.bind(React.createElement);

function replacePanelNode(node, panelId, nextNode) {
  if (node.type === "panel") {
    return node.panelId === panelId ? nextNode : node;
  }
  return {
    ...node,
    first: replacePanelNode(node.first, panelId, nextNode),
    second: replacePanelNode(node.second, panelId, nextNode),
  };
}

function removePanelNode(node, panelId) {
  if (node.type === "panel") {
    return node.panelId === panelId ? null : node;
  }
  const first = removePanelNode(node.first, panelId);
  const second = removePanelNode(node.second, panelId);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

function createPanel(index, source) {
  const role = source === "cli" ? "worker" : ["logs", "agent", "tests", "review"][index % 4];
  const alias = `${role}-${index}`;
  return {
    id: alias,
    alias,
    role,
    cwd: "tmp",
    command: source === "cli" ? "codex" : "zsh",
    status: "running",
    tmuxPaneId: `%${12 + index}`,
    lines: [
      `Y0CW21RFVN:tmp bytedance$ ${source === "cli" ? "codex" : "zsh"}`,
      `pane ${alias} attached`,
      `RUNWEAVE_TERMINAL_PANEL_ID=${alias}`,
      "Y0CW21RFVN:tmp bytedance$",
    ],
  };
}

function App() {
  const [state, setState] = useState(null);
  const [toast, setToast] = useState("");

  useEffect(() => {
    fetch("./mock-state.json")
      .then((response) => response.json())
      .then(setState);
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(""), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const activePanel = useMemo(() => {
    if (!state) return null;
    return state.panels.find((panel) => panel.id === state.session.activePanelId);
  }, [state]);

  if (!state) {
    return html`<main className="app" />`;
  }

  const pushEvent = (current, event) => ({
    ...current,
    events: [event, ...current.events].slice(0, 9),
  });

  const focusPanel = (panelId, source = "ui") => {
    setState((current) =>
      pushEvent(
        {
          ...current,
          session: { ...current.session, activePanelId: panelId },
        },
        `terminal_panel_focused ${panelId} (${source})`,
      ),
    );
  };

  const splitPanel = (direction, source = "ui") => {
    setState((current) => {
      const activeId = current.session.activePanelId;
      const index = current.panels.length + 1;
      const panel = createPanel(index, source);
      const splitNode = {
        type: "split",
        direction: direction === "right" ? "horizontal" : "vertical",
        ratio: 0.52,
        first: { type: "panel", panelId: activeId },
        second: { type: "panel", panelId: panel.id },
      };
      return pushEvent(
        {
          ...current,
          panels: [...current.panels, panel],
          layout: replacePanelNode(current.layout, activeId, splitNode),
          session: { ...current.session, activePanelId: panel.id },
        },
        `terminal_panel_created ${panel.id} via ${source} split-window -t ${activeId}`,
      );
    });
    setToast(source === "cli" ? "Simulated CLI split synced to tmux surface" : `Split ${direction}`);
  };

  const closePanel = () => {
    if (!activePanel) return;
    if (state.panels.length <= 1) {
      setToast("Cannot close the last tmux pane");
      return;
    }
    setState((current) => {
      const panelId = current.session.activePanelId;
      const nextPanels = current.panels.filter((panel) => panel.id !== panelId);
      const nextActive = nextPanels[0].id;
      return pushEvent(
        {
          ...current,
          panels: nextPanels,
          layout: removePanelNode(current.layout, panelId),
          session: { ...current.session, activePanelId: nextActive },
        },
        `terminal_panel_deleted ${panelId}`,
      );
    });
    setToast(`Simulated kill-pane ${activePanel.tmuxPaneId}`);
  };

  const sendMockInput = () => {
    if (!activePanel) return;
    setState((current) =>
      pushEvent(
        {
          ...current,
          panels: current.panels.map((panel) =>
            panel.id === activePanel.id
              ? {
                  ...panel,
                  command: "pnpm test",
                  lines: [
                    ...panel.lines.slice(-7),
                    "Y0CW21RFVN:tmp bytedance$ pnpm test",
                    "Test Files  4 passed (4)",
                    "Tests       39 passed (39)",
                    "Y0CW21RFVN:tmp bytedance$",
                  ],
                }
              : panel,
          ),
        },
        `terminal_panel_input_sent ${activePanel.id}`,
      ),
    );
    setToast(`Mock route: send-keys -t ${activePanel.tmuxPaneId}`);
  };

  const target = activePanel ? `${state.session.name} / ${activePanel.alias}` : "";
  const command = activePanel
    ? `rw terminal send ${state.session.id} --panel ${activePanel.alias} --text "pnpm test" --enter`
    : "";

  return html`
    <main className="app">
      <${TopBar} projects=${state.projects} />
      <${TerminalTabs} session=${state.session} target=${target} />
      <${PanelTargetBar}
        panels=${state.panels}
        activePanel=${activePanel}
        target=${target}
        command=${command}
        onFocusPanel=${focusPanel}
        onSplit=${splitPanel}
        onClose=${closePanel}
        onSend=${sendMockInput}
      />
      <section className="workspace">
        <div className="terminal-region">
          <${TmuxSurface}
            layout=${state.layout}
            panels=${state.panels}
            activePanelId=${state.session.activePanelId}
            onFocus=${focusPanel}
          />
          <${EventLog} events=${state.events} />
          ${toast ? html`<div className="toast">${toast}</div>` : null}
        </div>
        <${PreviewSidecar} />
      </section>
    </main>
  `;
}

function TopBar({ projects }) {
  return html`
    <div className="topbar">
      <button className="home-button" title="Home" aria-label="Home">⌂</button>
      <div className="project-tabs">
        ${projects.map(
          (project) => html`
            <button key=${project.id} className=${`project-tab ${project.active ? "active" : ""}`}>
              ${project.name}
            </button>
          `,
        )}
        <button className="add-button" title="New Project" aria-label="New Project">+</button>
      </div>
      <button className="icon-button" title="Quick Input" aria-label="Quick Input">⚡</button>
      <button className="icon-button" title="More actions" aria-label="More actions">⋯</button>
    </div>
  `;
}

function TerminalTabs({ session, target }) {
  return html`
    <div className="tabbar">
      <div className="terminal-tabs">
        ${session.tabs.map(
          (tab) => html`
            <button key=${tab.id} className=${`terminal-tab ${tab.active ? "active" : ""}`}>
              <span className="tab-name">${tab.name}</span>
              ${tab.active ? html`<span className="target-chip">${target}</span>` : null}
              <span className="tab-close">×</span>
            </button>
          `,
        )}
        <button className="add-button" title="New Terminal" aria-label="New Terminal">+</button>
      </div>
    </div>
  `;
}

function PanelTargetBar({
  panels,
  activePanel,
  target,
  command,
  onFocusPanel,
  onSplit,
  onClose,
  onSend,
}) {
  return html`
    <div className="panel-targetbar">
      <div className="breadcrumb" title="Active tmux pane target">
        <span>${target || "-"}</span>
      </div>
      <div className="panel-tabs">
        ${panels.map(
          (panel) => html`
            <button
              key=${panel.id}
              className=${`panel-chip ${panel.id === activePanel?.id ? "active" : ""}`}
              onClick=${() => onFocusPanel(panel.id)}
              title=${`select-pane -t ${panel.tmuxPaneId}`}
            >
              <span className="dot" />
              <span className="panel-chip-name">${panel.alias}</span>
              <span className="pane-id">${panel.tmuxPaneId}</span>
            </button>
          `,
        )}
      </div>
      <div className="toolbar-group">
        <button className="toolbar-button" onClick=${() => onSplit("right")}>Split right</button>
        <button className="toolbar-button" onClick=${() => onSplit("down")}>Split down</button>
        <button className="toolbar-button secondary" onClick=${() => onSplit("down", "cli")}>
          Simulate CLI split
        </button>
        <button className="toolbar-button" onClick=${onSend}>Mock send</button>
        <button className="toolbar-button danger" onClick=${onClose}>Close pane</button>
      </div>
      <span className="cli-preview" title=${command}>${command}</span>
    </div>
  `;
}

function TmuxSurface({ layout, panels, activePanelId, onFocus }) {
  return html`
    <section className="tmux-shell" aria-label="Single tmux attach surface">
      <div className="tmux-titlebar">
        <span className="tmux-dot" />
        <span>tmux attach surface</span>
        <span className="transport-note">one xterm websocket · native tmux split</span>
      </div>
      <div className="tmux-canvas">
        <${TmuxPaneTree}
          node=${layout}
          panels=${panels}
          activePanelId=${activePanelId}
          onFocus=${onFocus}
        />
      </div>
      <div className="tmux-status">
        <span>[tmp]</span>
        <span>0:zsh</span>
        <span className="status-right">Runweave target controls are outside tmux rendering</span>
      </div>
    </section>
  `;
}

function TmuxPaneTree({ node, panels, activePanelId, onFocus }) {
  if (node.type === "panel") {
    const panel = panels.find((item) => item.id === node.panelId);
    if (!panel) return null;
    const active = panel.id === activePanelId;
    return html`
      <button
        className=${`tmux-pane ${active ? "active" : ""}`}
        onClick=${() => onFocus(panel.id)}
        aria-label=${`tmux pane ${panel.alias}`}
      >
        <div className="pane-overlay">
          <span>${panel.alias}</span>
          <span>${panel.tmuxPaneId}</span>
          <span>${panel.command}</span>
        </div>
        <div className="terminal-output">
          ${panel.lines.map(
            (line, index) => html`
              <div className="terminal-line" key=${`${panel.id}-${index}`}>
                ${line}${index === panel.lines.length - 1 && active
                  ? html`<span className="cursor" />`
                  : null}
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
        <${TmuxPaneTree}
          node=${node.first}
          panels=${panels}
          activePanelId=${activePanelId}
          onFocus=${onFocus}
        />
      </div>
      <div className="split-divider" />
      <div className="split-child" style=${{ flexBasis: secondBasis }}>
        <${TmuxPaneTree}
          node=${node.second}
          panels=${panels}
          activePanelId=${activePanelId}
          onFocus=${onFocus}
        />
      </div>
    </div>
  `;
}

function EventLog({ events }) {
  return html`
    <aside className="event-log">
      <div className="event-log-header">Sync events</div>
      <div className="event-log-body">
        ${events.map(
          (event, index) => html`
            <div className="event-line" key=${`${event}-${index}`}>${event}</div>
          `,
        )}
      </div>
    </aside>
  `;
}

function PreviewSidecar() {
  return html`
    <aside className="sidecar">
      <div className="sidecar-header">
        <div className="sidecar-tabs">
          <button className="sidecar-tab active">Preview</button>
          <button className="sidecar-tab">Browser</button>
          <button className="sidecar-tab">Orchestrator</button>
        </div>
        <div className="sidecar-tools">
          <button className="icon-button" title="Expand Preview" aria-label="Expand Preview">⤢</button>
          <button className="icon-button" title="Refresh Preview" aria-label="Refresh Preview">↻</button>
          <button className="icon-button" title="Close sidecar" aria-label="Close sidecar">×</button>
        </div>
      </div>
      <div className="preview-row">
        <button className="preview-task">Changes</button>
        <button className="preview-task">Explorer</button>
        <button className="preview-task">Open</button>
        <span className="panel-meta">Default Project</span>
        <span className="readonly">READ ONLY</span>
      </div>
      <div className="preview-empty">
        <div>Set a project path to use Preview</div>
        <button className="primary">Set project path</button>
      </div>
    </aside>
  `;
}

createRoot(document.getElementById("root")).render(html`<${App} />`);
