/* global HTMLInputElement, HTMLElement, HTMLTextAreaElement, document, fetch, performance, requestAnimationFrame */

const app = document.querySelector("#app");

function nowLine(message) {
  return `${new Date().toLocaleTimeString()} ${message}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function createInitialState(payload) {
  return {
    ...payload,
    draft: payload.ui.initialDraft,
    bottomOffsetRows: 0,
    floatingComposerVisible: false,
    tmuxScrollbackActive: false,
    newOutputBelow: false,
    sentCount: 0,
    events: payload.events.map(nowLine),
  };
}

function shouldShowComposer(state) {
  if (typeof state.floatingComposerVisible === "boolean") {
    return state.floatingComposerVisible;
  }
  return state.bottomOffsetRows >= state.ui.thresholdRows || state.tmuxScrollbackActive;
}

function statusLabel(state) {
  if (state.tmuxScrollbackActive) {
    return "tmux copy mode";
  }
  if (shouldShowComposer(state)) {
    return "away from bottom";
  }
  return "at bottom";
}

function renderTerminalLines(lines) {
  return lines
    .map((line) => {
      const muted = line.startsWith("#") || line.trim() === "";
      return `<div class="terminal-line ${muted ? "muted" : ""}">${escapeHtml(line)}</div>`;
    })
    .join("");
}

function render(state) {
  const composerVisible = shouldShowComposer(state);
  const nativePromptVisible = !composerVisible;
  const status = statusLabel(state);

  app.innerHTML = `
    <header class="topbar">
      <div class="title">
        <strong>${escapeHtml(state.session.name)}</strong>
        <span>${escapeHtml(state.session.cwd)}</span>
      </div>
      <div class="toolbar">
        <div class="segmented" aria-label="Scroll state">
          <button data-mode="bottom" class="${state.ui.mode === "bottom" ? "active" : ""}">Bottom</button>
          <button data-mode="scrolled" class="${state.ui.mode === "scrolled" ? "active" : ""}">Scrolled</button>
          <button data-mode="tmux" class="${state.ui.mode === "tmux" ? "active" : ""}">Tmux</button>
        </div>
        <button class="button" data-action="append-output">New output</button>
        <button class="button primary" data-action="seed-draft">Seed text</button>
      </div>
    </header>
    <section class="workspace">
      <section class="terminal-wrap">
        <div class="terminal-frame">
          <div class="terminal-tabs">
            <div class="tab"><span class="dot"></span>${escapeHtml(state.session.id)}</div>
          </div>
          <div class="terminal-surface" data-composer-visible="${composerVisible}">
            <div class="terminal-scroll" data-role="terminal-scroll">
              ${renderTerminalLines(state.terminalLines)}
            </div>
            <div class="native-prompt ${nativePromptVisible ? "" : "hidden"}" aria-hidden="${nativePromptVisible ? "false" : "true"}">
              <span>${escapeHtml(state.session.prompt)}</span>
              <input
                class="native-draft"
                data-role="native-input"
                spellcheck="false"
                aria-label="Native TUI input"
                value="${escapeHtml(state.draft)}"
              />
              <span class="cursor"></span>
            </div>
            ${
              composerVisible
                ? `
                  <section class="composer" aria-label="Floating terminal composer">
                    <textarea
                      data-role="composer-input"
                      spellcheck="false"
                      rows="2"
                      aria-label="Terminal input"
                    >${escapeHtml(state.draft)}</textarea>
                    <div class="composer-actions">
                      <button
                        class="composer-send-button"
                        data-action="send"
                        title="Send"
                        aria-label="Send"
                      >
                        <svg
                          aria-hidden="true"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        >
                          <path d="m22 2-7 20-4-9-9-4Z"></path>
                          <path d="M22 2 11 13"></path>
                        </svg>
                      </button>
                    </div>
                  </section>
                `
                : ""
            }
            ${
              composerVisible
                ? `<button class="scroll-button" data-action="to-bottom" title="Scroll to bottom" aria-label="Scroll to bottom">↓</button>`
                : ""
            }
          </div>
        </div>
      </section>
      <aside class="sidecar">
        <section class="panel">
          <div class="panel-header">
            <strong>Runtime state</strong>
            <span>${escapeHtml(status)}</span>
          </div>
          <div class="panel-body">
            <div class="metric-grid">
              <div class="metric">
                <span>bottomOffsetRows</span>
                <strong>${state.bottomOffsetRows}</strong>
              </div>
              <div class="metric">
                <span>thresholdRows</span>
                <strong>${state.ui.thresholdRows}</strong>
              </div>
              <div class="metric">
                <span>native prompt</span>
                <strong>${nativePromptVisible ? "on" : "off"}</strong>
              </div>
              <div class="metric">
                <span>composer</span>
                <strong>${composerVisible ? "on" : "off"}</strong>
              </div>
            </div>
          </div>
        </section>
        <section class="panel">
          <div class="panel-header">
            <strong>Prototype controls</strong>
          </div>
          <div class="panel-body toolbar">
            <button class="button" data-action="scroll-up">Scroll up</button>
            <button class="button" data-action="to-bottom">Bottom</button>
            <button class="button" data-action="toggle-tmux">${state.tmuxScrollbackActive ? "Exit tmux" : "Enter tmux"}</button>
          </div>
        </section>
        <section class="panel event-list" aria-label="Event log">
          ${state.events
            .map(
              (event, index) =>
                `<div class="event ${index === 0 ? "strong" : ""}">${escapeHtml(event)}</div>`,
            )
            .join("")}
        </section>
      </aside>
    </section>
  `;
}

function withEvent(state, message) {
  return {
    ...state,
    events: [nowLine(message), ...state.events].slice(0, 10),
  };
}

function setMode(state, mode) {
  if (mode === "bottom") {
    return withEvent(
      {
        ...state,
        ui: { ...state.ui, mode },
        bottomOffsetRows: 0,
        floatingComposerVisible: false,
        tmuxScrollbackActive: false,
        newOutputBelow: false,
      },
      "native prompt visible; floating composer hidden",
    );
  }

  if (mode === "tmux") {
    return withEvent(
      {
        ...state,
        ui: { ...state.ui, mode },
        bottomOffsetRows: Math.max(state.bottomOffsetRows, state.ui.thresholdRows),
        floatingComposerVisible: true,
        tmuxScrollbackActive: true,
      },
      "tmux scrollback active; floating composer visible",
    );
  }

  return withEvent(
    {
      ...state,
      ui: { ...state.ui, mode },
      bottomOffsetRows: Math.max(state.bottomOffsetRows, state.ui.thresholdRows + 14),
      floatingComposerVisible: true,
      tmuxScrollbackActive: false,
    },
    "scrolled away from bottom; floating composer visible",
  );
}

function sendDraft(state) {
  const draft = state.draft.trimEnd();
  if (!draft) {
    return withEvent(state, "send ignored: empty draft");
  }

  const nextLines = [
    ...state.terminalLines,
    `${state.session.prompt} ${draft}`,
    "mock sendTerminalInput(data)",
    `${state.session.prompt}`,
  ];

  return withEvent(
    {
      ...state,
      terminalLines: nextLines,
      draft: "",
      bottomOffsetRows: 0,
      floatingComposerVisible: false,
      tmuxScrollbackActive: false,
      newOutputBelow: false,
      sentCount: state.sentCount + 1,
      ui: { ...state.ui, mode: "bottom" },
    },
    "sent draft, exited scrollback, returned to bottom",
  );
}

function bindInteractions(initialState) {
  let state = createInitialState(initialState);
  let shouldStickToBottom = true;
  let scrollFrameId = null;
  let pendingScrollTarget = null;
  let ignoreScrollUntil = 0;

  const updateRuntimeMetrics = () => {
    const metricValues = app.querySelectorAll(".metric strong");
    if (metricValues.length >= 4) {
      metricValues[0].textContent = String(state.bottomOffsetRows);
      metricValues[2].textContent = shouldShowComposer(state) ? "off" : "on";
      metricValues[3].textContent = shouldShowComposer(state) ? "on" : "off";
    }

    const status = app.querySelector(".panel-header span");
    if (status) {
      status.textContent = statusLabel(state);
    }
  };

  const applyScrollState = (target) => {
    const maxOffset = Math.max(0, target.scrollHeight - target.clientHeight - target.scrollTop);
    const nextRows = Math.round(maxOffset / state.ui.rowHeight);
    if (Math.abs(nextRows - state.bottomOffsetRows) < 2) return;

    const previousComposerVisible = shouldShowComposer(state);
    const nextBaseState = {
      ...state,
      bottomOffsetRows: nextRows,
      ui: {
        ...state.ui,
        mode: nextRows >= state.ui.thresholdRows ? "scrolled" : "bottom",
      },
      tmuxScrollbackActive: false,
      newOutputBelow: nextRows > 0 ? state.newOutputBelow : false,
    };
    const nextComposerVisible = previousComposerVisible
      ? nextRows > 2
      : nextRows >= state.ui.thresholdRows;
    const nextState = {
      ...nextBaseState,
      floatingComposerVisible: nextComposerVisible,
    };

    if (previousComposerVisible !== nextComposerVisible) {
      state = withEvent(
        nextState,
        nextComposerVisible
          ? `scroll offset ${nextRows} rows; floating composer visible`
          : `scroll offset ${nextRows} rows; native prompt visible`,
      );
      rerender();
      return;
    }

    state = nextState;
    updateRuntimeMetrics();
  };

  const scheduleScrollStateUpdate = (target) => {
    pendingScrollTarget = target;
    if (scrollFrameId !== null) return;

    scrollFrameId = requestAnimationFrame(() => {
      scrollFrameId = null;
      const nextTarget = pendingScrollTarget;
      pendingScrollTarget = null;
      if (nextTarget) {
        applyScrollState(nextTarget);
      }
    });
  };

  const rerender = () => {
    const previousScroll = app.querySelector("[data-role='terminal-scroll']");
    const previousScrollTop = previousScroll?.scrollTop ?? null;
    const previousMaxScroll = previousScroll
      ? previousScroll.scrollHeight - previousScroll.clientHeight
      : null;

    render(state);

    const scroll = app.querySelector("[data-role='terminal-scroll']");
    if (!scroll) return;

    if (shouldStickToBottom) {
      ignoreScrollUntil = performance.now() + 80;
      scroll.scrollTop = scroll.scrollHeight;
      shouldStickToBottom = false;
      return;
    }

    if (previousScrollTop !== null && previousMaxScroll !== null) {
      const nextMaxScroll = scroll.scrollHeight - scroll.clientHeight;
      ignoreScrollUntil = performance.now() + 80;
      scroll.scrollTop =
        state.bottomOffsetRows === 0
          ? nextMaxScroll
          : Math.max(0, nextMaxScroll - state.bottomOffsetRows * state.ui.rowHeight);
    }
  };

  rerender();

  app.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement) && !(target instanceof HTMLInputElement)) return;
    if (target.dataset.role !== "composer-input" && target.dataset.role !== "native-input") return;
    state = { ...state, draft: target.value };
  });

  app.addEventListener("keydown", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement) && !(target instanceof HTMLInputElement)) return;
    if (target.dataset.role !== "composer-input" && target.dataset.role !== "native-input") return;
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    state = sendDraft({ ...state, draft: target.value });
    shouldStickToBottom = true;
    rerender();
  });

  app.addEventListener("click", (event) => {
    const target = event.target.closest("button");
    if (!target) return;

    if (target.dataset.mode) {
      state = setMode(state, target.dataset.mode);
      shouldStickToBottom = target.dataset.mode === "bottom";
      rerender();
      return;
    }

    if (target.dataset.action === "scroll-up") {
      state = setMode(state, "scrolled");
      rerender();
      return;
    }

    if (target.dataset.action === "to-bottom") {
      state = setMode(state, "bottom");
      shouldStickToBottom = true;
      rerender();
      return;
    }

    if (target.dataset.action === "toggle-tmux") {
      state = setMode(state, state.tmuxScrollbackActive ? "bottom" : "tmux");
      shouldStickToBottom = !state.tmuxScrollbackActive;
      rerender();
      return;
    }

    if (target.dataset.action === "append-output") {
      state = withEvent(
        {
          ...state,
          terminalLines: [
            ...state.terminalLines,
            `agent: background output while viewer offset=${state.bottomOffsetRows}`,
          ],
          newOutputBelow: state.bottomOffsetRows > 0 || state.tmuxScrollbackActive,
        },
        "new output arrived below current viewport",
      );
      shouldStickToBottom = state.bottomOffsetRows === 0 && !state.tmuxScrollbackActive;
      rerender();
      return;
    }

    if (target.dataset.action === "seed-draft") {
      state = withEvent(
        {
          ...state,
          draft: "git diff -- frontend/src/components/terminal",
        },
        "draft seeded for paste/edit flow",
      );
      rerender();
      requestAnimationFrame(() => {
        const input =
          app.querySelector("[data-role='composer-input']") ??
          app.querySelector("[data-role='native-input']");
        input?.focus();
        input?.select();
      });
      return;
    }

    if (target.dataset.action === "send") {
      const input =
        app.querySelector("[data-role='composer-input']") ??
        app.querySelector("[data-role='native-input']");
      state = sendDraft({
        ...state,
        draft:
          input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement
            ? input.value
            : state.draft,
      });
      shouldStickToBottom = true;
      rerender();
    }
  });

  app.addEventListener("scroll", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.dataset.role !== "terminal-scroll") return;
    if (performance.now() < ignoreScrollUntil) return;
    scheduleScrollStateUpdate(target);
  }, true);
}

function renderLoadError(error) {
  app.innerHTML = "";
  const panel = document.createElement("pre");
  panel.style.margin = "0";
  panel.style.padding = "18px";
  panel.style.color = "var(--danger)";
  panel.style.whiteSpace = "pre-wrap";
  panel.textContent = [
    "无法加载 mock-state.json。",
    "",
    String(error),
    "",
    "请用以下命令启动原型，而不是直接打开本地文件：",
    "python3 -m http.server 6188 --directory docs/prototypes/terminal-floating-composer",
  ].join("\n");
  app.append(panel);
}

fetch("./mock-state.json")
  .then((response) => {
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return response.json();
  })
  .then(bindInteractions)
  .catch(renderLoadError);
