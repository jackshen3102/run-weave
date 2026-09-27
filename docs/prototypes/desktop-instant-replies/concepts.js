/* global URLSearchParams, document, fetch */

const app = document.querySelector("#app");

const ICONS = {
  arrowUp:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg>',
  chevronLeft:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
  close:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
  folder:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7h5l2 2h11v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M3 7V5a2 2 0 0 1 2-2h3l2 2h9a2 2 0 0 1 2 2v2"/></svg>',
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/></svg>',
  messageZap:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h6"/><path d="m17 3-2 4h4l-2 4"/></svg>',
  return:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 10-4 4 4 4"/><path d="M5 14h11a4 4 0 0 0 4-4V6"/></svg>',
  terminal:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 17 6-6-6-6"/><path d="M12 19h8"/></svg>',
  zap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 3 14h9l-1 8 10-12h-9Z"/></svg>',
};

const allowedVariants = new Set([
  "inline",
  "composer",
  "fan",
  "rail",
  "header",
]);

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function replyButtons(data, className = "reply-chip") {
  return data.replies
    .map(
      (reply) => `
        <button
          type="button"
          class="${className}"
          aria-label="发送“${escapeHtml(reply.text)}”"
          data-reply="${escapeHtml(reply.text)}"
        >
          <span>${escapeHtml(reply.text)}</span>${ICONS.return}
        </button>
      `,
    )
    .join("");
}

function renderTerminalLines(data, variant) {
  const lines = data.terminal.lines
    .map((line) => {
      const text = escapeHtml(line.text);
      const body =
        line.tone === "command"
          ? `<span class="prompt-mark">❯</span>${text.slice(1)}`
          : text;
      return `<div class="terminal-line ${escapeHtml(line.tone)}">${body || "&nbsp;"}</div>`;
    })
    .join("");

  if (variant !== "inline") return lines;
  return `${lines}<div class="inline-replies" data-testid="concept-inline">${replyButtons(data)}</div>`;
}

function renderComposerConcept(data) {
  return `
    <div class="composer-dock" data-testid="concept-composer">
      <section class="composer-card" aria-label="终端输入">
        <div class="composer-suggestions">${replyButtons(data, "reply-chip subtle")}</div>
        <div class="composer-main">
          <button type="button" class="round-button" aria-label="关闭输入">${ICONS.close}</button>
          <textarea aria-label="终端输入" rows="1">我还有一段正在编辑的内容…</textarea>
          <button type="button" class="round-button accent" aria-label="发送">${ICONS.arrowUp}</button>
        </div>
      </section>
    </div>
  `;
}

function renderFanConcept(data) {
  return `
    <div class="reply-fan" data-testid="concept-fan">
      ${[...data.replies]
        .reverse()
        .map(
          (reply) => `
            <button type="button" class="fan-option" aria-label="发送“${escapeHtml(reply.text)}”" data-reply="${escapeHtml(reply.text)}">
              <span>${escapeHtml(reply.text)}</span>${ICONS.return}
            </button>
          `,
        )
        .join("")}
      <button type="button" class="fan-trigger" aria-label="收起一键回复">${ICONS.messageZap}</button>
    </div>
  `;
}

function renderRailConcept(data) {
  return `
    <aside class="reply-rail" aria-label="一键回复" data-testid="concept-rail">
      <div class="rail-header"><span>一键回复</span><button class="rail-close" type="button" aria-label="收起">${ICONS.chevronLeft}</button></div>
      <div class="rail-options">
        ${data.replies
          .map(
            (reply) => `
              <button type="button" class="rail-option" aria-label="发送“${escapeHtml(reply.text)}”" data-reply="${escapeHtml(reply.text)}">
                <span>${escapeHtml(reply.text)}</span>${ICONS.return}
              </button>
            `,
          )
          .join("")}
      </div>
    </aside>
  `;
}

function renderHeaderPopover(data, variant) {
  if (variant !== "header") return "";
  return `
    <section class="header-reply-popover" aria-label="快捷指令与一键回复" data-testid="concept-header">
      <div class="popover-heading"><span>一键回复</span><span>当前终端</span></div>
      <div class="popover-replies">${replyButtons(data)}</div>
      <div class="popover-divider"></div>
      <div class="popover-heading"><span>快捷指令</span><span>固定</span></div>
      ${data.quickInputs
        .map(
          (item) => `
            <div class="saved-command">
              <div class="saved-copy"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.body)}</span></div>
              ${ICONS.return}
            </div>
          `,
        )
        .join("")}
    </section>
  `;
}

function renderVariantOverlay(data, variant) {
  if (variant === "composer") return renderComposerConcept(data);
  if (variant === "fan") return renderFanConcept(data);
  if (variant === "rail") return renderRailConcept(data);
  return "";
}

function render(data, state) {
  app.innerHTML = `
    <div class="app-shell">
      <header class="desktop-bar">
        <div class="window-dots" aria-hidden="true"><span class="window-dot close"></span><span class="window-dot minimize"></span><span class="window-dot expand"></span></div>
        <div class="desktop-title">${escapeHtml(data.workspace.project)} — Runweave</div>
        <div class="desktop-status"><span class="status-dot"></span>Connected</div>
      </header>
      <div class="workspace">
        <aside class="sidebar">
          <div class="sidebar-heading"><div class="brand"><span class="brand-mark">${ICONS.terminal}</span>Runweave</div></div>
          <section class="sidebar-section">
            <div class="section-label">Projects</div>
            <div class="nav-list">
              ${data.projects.map((item) => `<div class="nav-item ${item.active ? "active" : ""}">${ICONS.folder}<span>${escapeHtml(item.label)}</span></div>`).join("")}
            </div>
          </section>
          <section class="sidebar-section">
            <div class="section-label">Terminals</div>
            <div class="nav-list">
              ${data.sessions.map((item) => `<div class="nav-item ${item.active ? "active" : ""}">${ICONS.terminal}<span>${escapeHtml(item.label)}</span>${item.running ? '<i class="session-state"></i>' : ""}</div>`).join("")}
            </div>
          </section>
          <div class="sidebar-footer">${escapeHtml(data.workspace.branch)}</div>
        </aside>
        <main class="main">
          <header class="workspace-header">
            <button type="button" class="icon-button" aria-label="Go home">${ICONS.home}</button>
            <button type="button" class="connection-pill"><span class="status-dot"></span>${escapeHtml(data.workspace.connection)}</button>
            <nav class="project-tabs" aria-label="Open projects"><button type="button" class="project-tab active">${escapeHtml(data.workspace.project)}</button><button type="button" class="project-tab">toolkit</button></nav>
            <div class="header-actions">
              <button type="button" class="icon-button ${state.variant === "header" ? "active" : ""}" aria-label="快捷指令">${ICONS.zap}</button>
              ${renderHeaderPopover(data, state.variant)}
            </div>
          </header>
          <section class="terminal-frame" aria-label="Terminal">
            <div class="terminal-tabs"><div class="terminal-tab"><span class="terminal-status-dot"></span><span>${escapeHtml(data.terminal.title)}</span></div><div class="terminal-meta">${escapeHtml(data.terminal.panel)} · ${escapeHtml(data.terminal.status)}</div></div>
            <div class="terminal-content" data-testid="terminal-output">${renderTerminalLines(data, state.variant)}</div>
            ${renderVariantOverlay(data, state.variant)}
            ${state.feedback ? `<div class="feedback-toast" role="status">已发送“${escapeHtml(state.feedback)}”</div>` : ""}
          </section>
        </main>
      </div>
    </div>
  `;
}

function bindInteractions(data) {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get("variant") ?? "inline";
  const state = {
    variant: allowedVariants.has(requested) ? requested : "inline",
    feedback: null,
  };
  render(data, state);

  app.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-reply]");
    if (!button) return;
    state.feedback = button.dataset.reply;
    render(data, state);
  });
}

fetch("./mock-state.json")
  .then((response) => {
    if (!response.ok)
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    return response.json();
  })
  .then(bindInteractions)
  .catch((error) => {
    app.textContent = `无法加载原型数据：${String(error)}`;
  });
