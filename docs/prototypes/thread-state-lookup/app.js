/* global document, fetch, navigator, setTimeout */

const app = document.querySelector("#app");

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatTime(value) {
  if (!value) {
    return "unknown";
  }
  return value.replace("T", " ").replace("+08:00", "");
}

function statusLabel(status) {
  const labels = {
    starting: "starting",
    running: "running",
    idle: "idle",
    completed: "completed",
    failed: "failed",
    unknown: "unknown",
  };
  return labels[status] ?? "unknown";
}

function eventHint(thread) {
  if (thread.lastHookEvent) {
    return `hook:${thread.lastHookEvent}`;
  }
  if (thread.lastCompletionReason) {
    return `completion:${thread.lastCompletionReason}`;
  }
  return "no recent signal";
}

function findThread(data, query) {
  const target = query.trim();
  if (!target) {
    return null;
  }
  return (
    data.threads.find((thread) => thread.threadId === target) ??
    data.threads.find((thread) => thread.threadId.includes(target)) ??
    null
  );
}

function statusRank(status) {
  const ranks = {
    running: 0,
    starting: 1,
    failed: 2,
    idle: 3,
    completed: 4,
    unknown: 5,
  };
  return ranks[status] ?? 6;
}

function sortThreadsForTerminal(threads) {
  return [...threads].sort((a, b) => {
    const byStatus = statusRank(a.status) - statusRank(b.status);
    if (byStatus !== 0) {
      return byStatus;
    }
    return String(b.updatedAt).localeCompare(String(a.updatedAt));
  });
}

function findThreadsByTerminal(data, query) {
  const target = query.trim().toLowerCase();
  if (!target) {
    return [];
  }
  return sortThreadsForTerminal(
    data.threads.filter((thread) =>
      String(thread.terminalSessionId ?? "").toLowerCase().includes(target),
    ),
  );
}

function getActiveThread(data, state) {
  if (state.lookupMode === "terminal") {
    const matches = findThreadsByTerminal(data, state.query);
    return (
      matches.find((thread) => thread.threadId === state.selectedThreadId) ??
      matches[0] ??
      null
    );
  }
  return findThread(data, state.query);
}

function buildAgentPrompt(thread, terminalMatches = []) {
  if (!thread) {
    return "";
  }
  const terminalContext =
    terminalMatches.length > 1
      ? [
          "",
          `同一个 terminalSessionId 下命中了 ${terminalMatches.length} 条 ThreadRef：`,
          ...terminalMatches.map(
            (item) =>
              `- ${item.status} ${item.agent} ${item.threadId} panel=${item.terminalPanelId ?? "null"} updatedAt=${item.updatedAt}`,
          ),
        ]
      : [];
  return [
    "请帮我排查这个 Runweave App Server thread 当前状态：",
    `threadId: ${thread.threadId}`,
    `agent: ${thread.agent}`,
    `status: ${thread.status}`,
    `projectId: ${thread.projectId ?? "null"}`,
    `terminalSessionId: ${thread.terminalSessionId ?? "null"}`,
    `terminalPanelId: ${thread.terminalPanelId ?? "null"}`,
    `runId: ${thread.runId ?? "null"}`,
    `cwd: ${thread.cwd ?? "null"}`,
    `lastEventId: ${thread.lastEventId}`,
    `lastHookEvent: ${thread.lastHookEvent ?? "null"}`,
    `lastCompletionReason: ${thread.lastCompletionReason ?? "null"}`,
    `updatedAt: ${thread.updatedAt}`,
    ...terminalContext,
    "",
    "请优先读取 App Server projection/latest thread 状态和相关 JSONL 事件，再判断是否需要继续查终端、hook 或日志。",
  ].join("\n");
}

function renderTopbar(data) {
  return `
    <header class="topbar">
      <div class="title">
        <strong>${escapeHtml(data.workspace.product)}</strong>
        <span>${escapeHtml(data.workspace.projectPath)}</span>
      </div>
      <div class="session">
        <span>Terminal</span>
        <strong>${escapeHtml(data.workspace.activeTerminal)}</strong>
      </div>
    </header>
  `;
}

function renderMoreMenu(state) {
  if (!state.menuOpen) {
    return "";
  }
  return `
    <div class="more-menu" role="menu" aria-label="More actions">
      <button class="menu-item" type="button" role="menuitem">
        <span class="menu-icon" aria-hidden="true">P</span>
        <span>Preview</span>
      </button>
      <button class="menu-item" type="button" role="menuitem">
        <span class="menu-icon" aria-hidden="true">H</span>
        <span>Terminal History</span>
      </button>
      <button class="menu-item" type="button" role="menuitem" data-action="open-lookup">
        <span class="menu-icon" aria-hidden="true">S</span>
        <span>状态查询</span>
      </button>
      <button class="menu-item" type="button" role="menuitem">
        <span class="menu-icon" aria-hidden="true">L</span>
        <span>日志上报</span>
      </button>
    </div>
  `;
}

function renderToolbar(data, state) {
  return `
    <nav class="terminal-toolbar" aria-label="Terminal toolbar">
      <button class="project-select" type="button">
        <span aria-hidden="true">project</span>
        <span class="truncate">${escapeHtml(data.workspace.projectName)}</span>
      </button>
      <div class="toolbar-spacer"></div>
      <button class="icon-button" type="button" title="Quick input">+</button>
      <div class="more-menu-wrap">
        <button
          class="icon-button ${state.menuOpen ? "is-active" : ""}"
          type="button"
          title="More actions"
          aria-label="More actions"
          data-action="toggle-menu"
        >
          ...
        </button>
        ${renderMoreMenu(state)}
      </div>
    </nav>
  `;
}

function renderStatusPanel(thread) {
  if (!thread) {
    return `
      <div class="empty-state">
        输入 threadId 后只显示当前状态、归属终端和最近事件。更细的排障交给 Agent 查 JSONL。
      </div>
    `;
  }
  return `
    <section class="status-panel">
      <div class="status-summary">
        <div class="truncate">
          <strong>${escapeHtml(thread.agent)} thread</strong>
          <span class="thread-id">${escapeHtml(thread.threadId)}</span>
        </div>
        <span class="status-badge status-${escapeHtml(thread.status)}">${escapeHtml(statusLabel(thread.status))}</span>
      </div>
      <div class="facts">
        ${renderFact("terminalSessionId", thread.terminalSessionId)}
        ${renderFact("terminalPanelId", thread.terminalPanelId)}
        ${renderFact("projectId", thread.projectId)}
        ${renderFact("runId", thread.runId)}
        ${renderFact("lastEvent", `${thread.lastEventId} / ${eventHint(thread)}`)}
        ${renderFact("updatedAt", formatTime(thread.updatedAt))}
        ${renderFact("cwd", thread.cwd)}
        ${renderFact("sourceInstance", thread.sourceInstanceId)}
      </div>
      <div class="note">${escapeHtml(thread.note)}</div>
      <div class="actions">
        <button class="button primary" type="button" data-action="copy-agent">复制给 Agent</button>
      </div>
    </section>
  `;
}

function renderFact(label, value) {
  return `
    <div class="fact">
      <label>${escapeHtml(label)}</label>
      <span title="${escapeHtml(value ?? "null")}">${escapeHtml(value ?? "null")}</span>
    </div>
  `;
}

function renderLookupMode(state) {
  return `
    <div class="lookup-mode" role="tablist" aria-label="Lookup mode">
      <button
        class="${state.lookupMode === "thread" ? "is-active" : ""}"
        type="button"
        role="tab"
        data-mode="thread"
      >
        Thread ID
      </button>
      <button
        class="${state.lookupMode === "terminal" ? "is-active" : ""}"
        type="button"
        role="tab"
        data-mode="terminal"
      >
        Terminal ID
      </button>
    </div>
  `;
}

function renderQuickList(data, state) {
  const items =
    state.lookupMode === "terminal" ? data.recentTerminals : data.recentThreads;
  const dataKey = state.lookupMode === "terminal" ? "terminal-id" : "thread-id";
  return `
    <div class="quick-list" aria-label="Recent ${escapeHtml(state.lookupMode)}s">
      ${items
        .map(
          (item) => `
            <button class="quick-chip" type="button" data-${dataKey}="${escapeHtml(item)}">
              ${escapeHtml(item)}
            </button>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderCandidateRow(thread, selectedThread) {
  const selected = selectedThread?.threadId === thread.threadId;
  return `
    <button
      class="candidate-row ${selected ? "is-selected" : ""}"
      type="button"
      data-select-thread="${escapeHtml(thread.threadId)}"
    >
      <span class="candidate-main">
        <strong>${escapeHtml(thread.threadId)}</strong>
        <span>${escapeHtml(thread.agent)} / panel=${escapeHtml(thread.terminalPanelId ?? "null")} / run=${escapeHtml(thread.runId ?? "null")}</span>
      </span>
      <span class="candidate-meta">
        <span class="status-badge status-${escapeHtml(thread.status)}">${escapeHtml(statusLabel(thread.status))}</span>
        <span>${escapeHtml(formatTime(thread.updatedAt))}</span>
      </span>
    </button>
  `;
}

function renderTerminalMatches(data, state, searched) {
  const matches = findThreadsByTerminal(data, state.query);
  const selectedThread =
    matches.find((thread) => thread.threadId === state.selectedThreadId) ??
    matches[0] ??
    null;

  if (searched && matches.length === 0) {
    return `<div class="empty-state">未找到 terminal ${escapeHtml(state.query.trim())}</div>`;
  }

  if (!searched) {
    return `
      <div class="empty-state">
        输入 terminalSessionId 后先列出候选 ThreadRef，再选择一条查看最小状态。
      </div>
    `;
  }

  return `
    <section class="terminal-result">
      <header class="terminal-result__header">
        <strong>${matches.length} 条候选 ThreadRef</strong>
        <span class="muted">active 优先，其次按更新时间</span>
      </header>
      <div class="candidate-list">
        ${matches.map((thread) => renderCandidateRow(thread, selectedThread)).join("")}
      </div>
    </section>
    ${renderStatusPanel(selectedThread)}
  `;
}

function renderDialog(data, state) {
  if (!state.lookupOpen) {
    return "";
  }
  const thread = findThread(data, state.query);
  const searched = state.query.trim().length > 0;
  const placeholder =
    state.lookupMode === "terminal"
      ? "输入 terminalSessionId，例如 term-feature-main"
      : "输入 threadId，例如 thread-state-sync-001";
  return `
    <div class="backdrop" data-action="close-lookup">
      <section class="dialog" role="dialog" aria-label="状态查询">
        <header class="dialog-header">
          <div class="dialog-title">
            <strong>状态查询</strong>
            <span>只查轻量 ThreadRef；完整上下文交给 Agent 继续读取事件和日志。</span>
          </div>
          <button class="icon-button" type="button" title="Close" data-action="close-lookup">x</button>
        </header>
        <div class="dialog-body">
          ${renderLookupMode(state)}
          <div class="lookup-row">
            <input
              class="lookup-input"
              data-thread-input
              value="${escapeHtml(state.query)}"
              placeholder="${escapeHtml(placeholder)}"
              autocomplete="off"
            />
            <button class="button primary" type="button" data-action="lookup">查询</button>
          </div>
          ${renderQuickList(data, state)}
          ${
            state.lookupMode === "terminal"
              ? renderTerminalMatches(data, state, searched)
              : searched && !thread
                ? `<div class="empty-state">未找到 ${escapeHtml(state.query.trim())}</div>`
                : renderStatusPanel(thread)
          }
        </div>
      </section>
    </div>
  `;
}

function renderTerminal(data) {
  return `
    <main class="terminal-area">
      <section class="terminal-screen" aria-label="Terminal">
        <div>$ pnpm dev</div>
        <div>App Server listening on ${escapeHtml(data.workspace.apiBase)}</div>
        <div>Event Center projection active.</div>
        <br />
        <div># 右上角 More actions -> 状态查询</div>
        <div># 输入 threadId 或 terminalSessionId，确认状态后复制上下文给 Agent。</div>
      </section>
      <aside class="side-panel">
        <header>
          <h2>当前定位</h2>
          <div class="pill-row">
            <span class="pill">App Server</span>
            <span class="pill">ThreadRef</span>
            <span class="pill">JSONL projection</span>
          </div>
        </header>
        <section>
          <h2>界面边界</h2>
          <p class="muted">这里不展示完整事件链、不做诊断中心，只提供可复制给 Agent 的最小状态。</p>
        </section>
      </aside>
    </main>
  `;
}

function render(data, state) {
  app.innerHTML = `
    <div class="app">
      ${renderTopbar(data)}
      <section class="workspace">
        ${renderToolbar(data, state)}
        ${renderTerminal(data)}
      </section>
      ${renderDialog(data, state)}
      ${state.toast ? `<div class="toast">${escapeHtml(state.toast)}</div>` : ""}
    </div>
  `;
  const input = app.querySelector("[data-thread-input]");
  if (input) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

async function copyText(text) {
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(text);
  }
}

function bindInteractions(data) {
  let state = {
    menuOpen: false,
    lookupOpen: false,
    lookupMode: "thread",
    query: data.recentThreads[0] ?? "",
    selectedThreadId: "",
    toast: "",
  };

  function update(nextState) {
    state = { ...state, ...nextState };
    render(data, state);
  }

  function showToast(message) {
    update({ toast: message });
    setTimeout(() => update({ toast: "" }), 1600);
  }

  render(data, state);

  app.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    const backdrop = event.target.closest(".backdrop");
    const dialog = event.target.closest(".dialog");

    if (backdrop && !dialog) {
      update({ lookupOpen: false });
      return;
    }

    if (!button) {
      return;
    }

    if (button.dataset.action === "toggle-menu") {
      update({ menuOpen: !state.menuOpen });
      return;
    }

    if (button.dataset.action === "open-lookup") {
      update({ menuOpen: false, lookupOpen: true });
      return;
    }

    if (button.dataset.action === "close-lookup") {
      update({ lookupOpen: false });
      return;
    }

    if (button.dataset.mode) {
      const lookupMode = button.dataset.mode;
      update({
        lookupMode,
        query:
          lookupMode === "terminal"
            ? data.recentTerminals[0] ?? ""
            : data.recentThreads[0] ?? "",
        selectedThreadId: "",
      });
      return;
    }

    if (button.dataset.threadId) {
      update({
        lookupMode: "thread",
        query: button.dataset.threadId,
        selectedThreadId: button.dataset.threadId,
      });
      return;
    }

    if (button.dataset.terminalId) {
      update({
        lookupMode: "terminal",
        query: button.dataset.terminalId,
        selectedThreadId: "",
      });
      return;
    }

    if (button.dataset.selectThread) {
      update({ selectedThreadId: button.dataset.selectThread });
      return;
    }

    if (button.dataset.action === "lookup") {
      const input = app.querySelector("[data-thread-input]");
      update({ query: input ? input.value : state.query, selectedThreadId: "" });
      return;
    }

    const thread = getActiveThread(data, state);
    const terminalMatches =
      state.lookupMode === "terminal" ? findThreadsByTerminal(data, state.query) : [];
    if (button.dataset.action === "copy-agent" && thread) {
      copyText(buildAgentPrompt(thread, terminalMatches))
        .then(() => showToast("已复制给 Agent 的上下文"))
        .catch(() => showToast("浏览器不允许复制，请手动复制 Agent 上下文"));
    }
  });

  app.addEventListener("input", (event) => {
    if (event.target.matches("[data-thread-input]")) {
      state.query = event.target.value;
    }
  });

  app.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.lookupOpen) {
      update({ lookupOpen: false });
    }
    if (event.key === "Enter" && event.target.matches("[data-thread-input]")) {
      update({ query: event.target.value, selectedThreadId: "" });
    }
  });
}

function renderLoadError(error) {
  app.innerHTML = `
    <pre style="margin:0;padding:18px;color:#fb7185;white-space:pre-wrap">
无法加载 mock-state.json。

${escapeHtml(String(error))}

请用以下命令启动原型：
python3 -m http.server 6188 --directory docs/prototypes/thread-state-lookup
    </pre>
  `;
}

fetch(`./mock-state.json?v=${Date.now()}`)
  .then((response) => {
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return response.json();
  })
  .then(bindInteractions)
  .catch(renderLoadError);
