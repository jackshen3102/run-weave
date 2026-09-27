/* global URLSearchParams, document, fetch, window */

const app = document.querySelector("#app");

const ICONS = {
  arrowUp:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg>',
  chevronDown:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
  close:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
  folder:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7h5l2 2h11v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M3 7V5a2 2 0 0 1 2-2h3l2 2h9a2 2 0 0 1 2 2v2"/></svg>',
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/></svg>',
  messageZap:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h6"/><path d="m17 3-2 4h4l-2 4"/></svg>',
  pencil:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>',
  return:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 10-4 4 4 4"/><path d="M5 14h11a4 4 0 0 0 4-4V6"/></svg>',
  terminal:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 17 6-6-6-6"/><path d="M12 19h8"/></svg>',
  zap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 3 14h9l-1 8 10-12h-9Z"/></svg>',
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function resizeComposer() {
  const textarea = document.querySelector("#terminal-draft");
  if (!textarea) return;
  textarea.style.height = "28px";
  textarea.style.height = `${Math.min(textarea.scrollHeight, 90)}px`;
}

function renderTerminalLines(lines) {
  return lines
    .map((line) => {
      const text = escapeHtml(line.text);
      const body =
        line.tone === "command"
          ? `<span class="prompt-mark">❯</span>${text.slice(1)}`
          : text;
      return `<div class="terminal-line ${escapeHtml(line.tone)}">${body || "&nbsp;"}</div>`;
    })
    .join("");
}

function renderQuickCommandPopover(state) {
  if (!state.quickCommandsOpen) return "";
  return `
    <section class="quick-command-popover" aria-label="快捷指令" data-testid="quick-command-popover">
      <div class="popover-title">快捷指令</div>
      ${state.data.quickInputs
        .map(
          (item) => `
            <div class="quick-command-item">
              <div class="quick-command-copy">
                <strong>${escapeHtml(item.title)}</strong>
                <span>${escapeHtml(item.body)}</span>
              </div>
              <span aria-hidden="true">${ICONS.return}</span>
            </div>
          `,
        )
        .join("")}
    </section>
  `;
}

function renderFeedback(state) {
  if (state.replyBusy) {
    return '<div class="status-message pending" role="status"><span class="spinner" style="display:inline-block;margin-right:7px;vertical-align:-2px"></span>正在发送…</div>';
  }
  if (state.replyError) {
    return `<div class="status-message error" role="alert">${escapeHtml(state.replyError)}</div>`;
  }
  if (state.replyFeedback) {
    return `<div class="status-message" role="status">${escapeHtml(state.replyFeedback)}</div>`;
  }
  return "";
}

function renderInstantReplies(state) {
  if (!state.instantOpen || !state.instantAvailable) return "";
  return `
    <section class="instant-reply-bar" aria-label="一键回复" data-testid="terminal-instant-reply-bar">
      ${state.data.replies
        .map(
          (reply) => `
            <button
              type="button"
              class="reply-button"
              aria-label="发送“${escapeHtml(reply.text)}”"
              title="发送“${escapeHtml(reply.text)}”"
              data-reply-id="${escapeHtml(reply.id)}"
              ${state.replyBusy ? "disabled" : ""}
            >
              <span>${escapeHtml(reply.text)}</span>
              ${ICONS.return}
            </button>
          `,
        )
        .join("")}
      <button
        type="button"
        class="reply-close"
        aria-label="收起一键回复"
        title="收起一键回复"
        data-action="close-instant"
        ${state.replyBusy ? "disabled" : ""}
      >
        ${ICONS.chevronDown}
      </button>
    </section>
  `;
}

function renderComposer(state) {
  if (!state.composerOpen) return "";
  const busy = state.replyBusy || state.composerBusy;
  return `
    <section class="composer" aria-label="Floating terminal composer" data-testid="terminal-floating-composer">
      <button
        type="button"
        class="composer-close"
        aria-label="关闭终端输入"
        title="关闭终端输入"
        data-action="close-composer"
        ${busy ? "disabled" : ""}
      >${ICONS.close}</button>
      <textarea
        id="terminal-draft"
        aria-label="终端输入"
        placeholder="输入消息…"
        rows="1"
        ${busy ? "disabled" : ""}
      >${escapeHtml(state.draft)}</textarea>
      <div class="composer-actions">
        <button
          type="button"
          class="queue-button"
          data-action="queue-draft"
          ${busy || !state.draft ? "disabled" : ""}
        >排队 <span aria-hidden="true">⇥</span></button>
        <button
          type="button"
          class="send-button"
          aria-label="发送"
          title="发送"
          data-action="send-draft"
          ${busy || !state.draft ? "disabled" : ""}
        >${ICONS.arrowUp}</button>
      </div>
    </section>
  `;
}

function render(state) {
  const { data } = state;
  app.innerHTML = `
    <div class="app-shell">
      <header class="desktop-bar">
        <div class="window-dots" aria-hidden="true">
          <span class="window-dot close"></span>
          <span class="window-dot minimize"></span>
          <span class="window-dot expand"></span>
        </div>
        <div class="desktop-title">${escapeHtml(data.workspace.project)} — Runweave</div>
        <div class="desktop-status"><span class="status-dot"></span>Connected</div>
      </header>
      <div class="workspace">
        <aside class="sidebar">
          <div class="sidebar-heading">
            <div class="brand"><span class="brand-mark">${ICONS.terminal}</span>Runweave</div>
          </div>
          <section class="sidebar-section">
            <div class="section-label">Projects</div>
            <nav class="project-list" aria-label="Projects">
              ${data.projects
                .map(
                  (project) => `
                    <div class="project-item ${project.active ? "active" : ""}">
                      ${ICONS.folder}<span>${escapeHtml(project.label)}</span>
                    </div>
                  `,
                )
                .join("")}
            </nav>
          </section>
          <section class="sidebar-section">
            <div class="section-label">Terminals</div>
            <div class="session-list">
              ${data.sessions
                .map(
                  (session) => `
                    <div class="session-item ${session.active ? "active" : ""}">
                      ${ICONS.terminal}<span>${escapeHtml(session.label)}</span>
                      ${session.running ? '<i class="session-state"></i>' : ""}
                    </div>
                  `,
                )
                .join("")}
            </div>
          </section>
          <div class="sidebar-footer">${escapeHtml(data.workspace.branch)}</div>
        </aside>
        <main class="main">
          <header class="workspace-header">
            <button class="home-icon" type="button" aria-label="Go home" title="Go home">${ICONS.home}</button>
            <button class="connection-pill" type="button">
              <span class="status-dot"></span>${escapeHtml(data.workspace.connection)}
            </button>
            <nav class="project-tabs" aria-label="Open projects">
              <button class="project-tab active" type="button"><span>${escapeHtml(data.workspace.project)}</span></button>
              <button class="project-tab" type="button"><span>toolkit</span></button>
            </nav>
            <div class="header-actions">
              <button
                class="header-icon ${state.quickCommandsOpen ? "active" : ""}"
                type="button"
                aria-label="快捷指令"
                title="快捷指令"
                data-action="toggle-quick-commands"
              >${ICONS.zap}</button>
              ${renderQuickCommandPopover(state)}
            </div>
          </header>
          <section class="terminal-frame" aria-label="Terminal">
            <div class="terminal-tabs">
              <div class="terminal-tab">
                <span class="terminal-status-dot"></span>
                <span>${escapeHtml(data.terminal.title)}</span>
              </div>
              <div class="terminal-meta">${escapeHtml(data.terminal.panel)} · ${escapeHtml(data.terminal.status)}</div>
            </div>
            <div class="terminal-content" data-testid="terminal-output">
              ${renderTerminalLines(state.terminalLines)}
            </div>
            <div class="surface-controls">
              <div class="bottom-stack">
                ${renderFeedback(state)}
                ${renderInstantReplies(state)}
                ${renderComposer(state)}
                <div class="floating-actions">
                  ${
                    state.instantAvailable && !state.instantOpen
                      ? `
                      <button
                        type="button"
                        class="floating-button"
                        aria-label="展开一键回复"
                        title="展开一键回复"
                        data-action="open-instant"
                      >${ICONS.messageZap}</button>
                    `
                      : ""
                  }
                  ${
                    !state.composerOpen
                      ? `
                      <button
                        type="button"
                        class="floating-button"
                        aria-label="打开终端输入"
                        title="打开终端输入"
                        data-action="open-composer"
                      >${ICONS.pencil}</button>
                    `
                      : ""
                  }
                </div>
              </div>
            </div>
          </section>
        </main>
      </div>
    </div>
  `;
  resizeComposer();
}

function appendTerminalExchange(state, text) {
  state.terminalLines = [
    ...state.terminalLines,
    { tone: "command", text: `❯ ${text}` },
    { tone: "success", text: "✓ Input accepted" },
  ];
}

function bindInteractions(data) {
  const params = new URLSearchParams(window.location.search);
  const state = {
    data,
    instantAvailable: params.get("availability") !== "unsupported",
    instantOpen: params.get("instant") !== "closed",
    composerOpen: params.get("composer") === "open",
    quickCommandsOpen: false,
    draft: params.get("draft") ?? data.defaultDraft,
    replyBusy: params.get("replyState") === "pending",
    composerBusy: false,
    replyFeedback:
      params.get("replyState") === "success" ? "已发送“继续”" : null,
    replyError:
      params.get("replyState") === "failure"
        ? "发送结果未确认，请先核对终端结果；不会自动重发。"
        : null,
    replyResult:
      params.get("replyResult") === "failure" ? "failure" : "success",
    requestId: 0,
    terminalLines: [...data.terminal.lines],
  };

  render(state);

  app.addEventListener("input", (event) => {
    if (
      event.target instanceof HTMLTextAreaElement &&
      event.target.id === "terminal-draft"
    ) {
      state.draft = event.target.value;
      resizeComposer();
    }
  });

  app.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled) return;

    const action = button.dataset.action;
    if (action === "toggle-quick-commands") {
      state.quickCommandsOpen = !state.quickCommandsOpen;
      render(state);
      return;
    }
    if (action === "open-instant") {
      state.instantOpen = true;
      state.replyError = null;
      state.replyFeedback = null;
      render(state);
      return;
    }
    if (action === "close-instant") {
      state.instantOpen = false;
      state.replyError = null;
      state.replyFeedback = null;
      render(state);
      return;
    }
    if (action === "open-composer") {
      state.composerOpen = true;
      render(state);
      document.querySelector("#terminal-draft")?.focus();
      return;
    }
    if (action === "close-composer") {
      state.composerOpen = false;
      render(state);
      return;
    }
    if (action === "send-draft" && state.draft) {
      appendTerminalExchange(state, state.draft);
      state.draft = "";
      state.composerOpen = false;
      render(state);
      return;
    }
    if (action === "queue-draft" && state.draft) {
      state.replyFeedback = "已加入队列";
      state.draft = "";
      render(state);
      return;
    }

    const replyId = button.dataset.replyId;
    if (!replyId || state.replyBusy) return;
    const reply = data.replies.find((item) => item.id === replyId);
    if (!reply) return;

    state.requestId += 1;
    const currentRequestId = state.requestId;
    state.replyBusy = true;
    state.replyError = null;
    state.replyFeedback = null;
    render(state);

    window.setTimeout(() => {
      if (currentRequestId !== state.requestId) return;
      state.replyBusy = false;
      if (state.replyResult === "failure") {
        state.replyError = "发送结果未确认，请先核对终端结果；不会自动重发。";
      } else {
        appendTerminalExchange(state, reply.text);
        state.replyFeedback = `已发送“${reply.text}”`;
        if (state.draft) state.composerOpen = true;
      }
      render(state);
    }, 900);
  });
}

function renderLoadError(error) {
  app.innerHTML = "";
  const panel = document.createElement("pre");
  panel.style.margin = "0";
  panel.style.padding = "18px";
  panel.style.color = "var(--danger)";
  panel.style.whiteSpace = "pre-wrap";
  panel.textContent = `无法加载原型数据。\n\n${String(error)}`;
  app.append(panel);
}

fetch("./mock-state.json")
  .then((response) => {
    if (!response.ok)
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    return response.json();
  })
  .then(bindInteractions)
  .catch(renderLoadError);
