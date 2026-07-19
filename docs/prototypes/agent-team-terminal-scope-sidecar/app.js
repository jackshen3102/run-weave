/* global document, fetch */

const app = document.querySelector("#app");

function shortId(value) {
  return value.replace(/^atr_/, "").slice(0, 12);
}

function render(state, activeTool = "agent-team") {
  app.innerHTML = `
    <section class="workspace">
      <div class="terminal">$ codex<br><br>Working in the current terminal…</div>
      <aside class="sidecar">
        <nav class="tools" aria-label="Sidecar tools">
          ${["preview", "browser", "agent-team"]
            .map(
              (tool) => `
            <button class="tool" type="button" data-tool="${tool}" aria-selected="${tool === activeTool}">
              ${tool === "agent-team" ? "Agent Team" : tool[0].toUpperCase() + tool.slice(1)}
            </button>`,
            )
            .join("")}
        </nav>
        <div class="panel">
          ${
            activeTool === "agent-team"
              ? `
            <header class="panel-header"><strong>Agent Team</strong><span class="status">${state.status}</span></header>
            <div class="scope" data-terminal-session-id="${state.terminalSessionId}" data-run-id="${state.runId}">
              <span title="Terminal ${state.terminalSessionId}">Terminal ${shortId(state.terminalSessionId)}</span>
              <span>·</span>
              <span title="Run ${state.runId}">Run ${shortId(state.runId)}</span>
            </div>
            <div class="content"><section class="card">
              <div class="card-title">Loop 状态</div>
              <div class="row"><span class="muted">Worker</span><span>${state.activeWorker}</span></div>
              <div class="row"><span class="muted">轮次</span><span>${state.round}</span></div>
              <div class="row"><span class="muted">验收来源</span><span>${state.acceptanceSource}</span></div>
            </section></div>`
              : `<div class="content muted">${activeTool === "preview" ? "Preview content" : "Browser content"}</div>`
          }
        </div>
      </aside>
    </section>`;

  app.querySelectorAll("[data-tool]").forEach((button) => {
    button.addEventListener("click", () => render(state, button.dataset.tool));
  });
}

fetch("./mock-state.json")
  .then((response) => response.json())
  .then((state) => render(state));
