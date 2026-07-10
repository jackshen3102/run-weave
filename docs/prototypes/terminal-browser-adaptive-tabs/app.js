/* global CSS, URL, URLSearchParams, document, fetch, requestAnimationFrame, window */

const app = document.querySelector("#app");
const params = new URLSearchParams(window.location.search);
const showPrototypeControls = params.has("prototypeControls");
const MIN_SIDECAR_WIDTH = 320;
const MAX_SIDECAR_WIDTH = 800;
const ACTIVE_MIN_WIDTH = 80;
const INACTIVE_MIN_WIDTH = 44;
const PREFERRED_TAB_WIDTH = 180;
const TAB_GAP = 4;
const TAB_FIXED_SPACE = 77;

let state;
let resizeSession = null;
let touchUnfreezeTimer = null;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("'", "&#39;");
}

function icon(paths, viewBox = "0 0 24 24") {
  return `<svg aria-hidden="true" viewBox="${viewBox}">${paths}</svg>`;
}

const icons = {
  back: icon('<path d="m15 18-6-6 6-6"/>'),
  forward: icon('<path d="m9 18 6-6-6-6"/>'),
  reload: icon('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>'),
  plus: icon('<path d="M12 5v14M5 12h14"/>'),
  search: icon('<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>'),
  close: icon('<path d="m7 7 10 10M17 7 7 17"/>'),
  more: icon('<circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/>'),
  expand: icon('<path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/>'),
  chevron: icon('<path d="m7 10 5 5 5-5"/>'),
};

function createInitialState(payload) {
  const requestedCount = clamp(Number(params.get("tabs")) || 10, 1, 20);
  const requestedWidth = clamp(
    Number(params.get("width")) || 420,
    MIN_SIDECAR_WIDTH,
    MAX_SIDECAR_WIDTH,
  );
  const tabs = payload.tabs.slice(0, requestedCount).map((tab, index) => ({
    ...tab,
    id: `${tab.id}-${index + 1}`,
  }));
  const activeParam = params.get("active");
  const requestedActiveIndex = activeParam === null ? Number.NaN : Number(activeParam);
  const activeIndex = clamp(
    Number.isFinite(requestedActiveIndex)
      ? requestedActiveIndex
      : Math.min(4, requestedCount - 1),
    0,
    requestedCount - 1,
  );
  return {
    ...payload,
    tabs,
    sidecarWidth: requestedWidth,
    activeTabId: tabs[activeIndex].id,
    overviewOpen: false,
    overviewQuery: "",
    frozenWidths: null,
    draggingTabId: null,
    tabSequence: requestedCount + 1,
  };
}

function getActiveTab() {
  return state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0];
}

function getTabWidths() {
  if (state.frozenWidths) {
    return state.frozenWidths;
  }

  const count = state.tabs.length;
  const available = Math.max(120, state.sidecarWidth - TAB_FIXED_SPACE);
  const contentWidth = available - TAB_GAP * Math.max(0, count - 1);
  const widths = {};

  if (PREFERRED_TAB_WIDTH * count <= contentWidth) {
    state.tabs.forEach((tab) => {
      widths[tab.id] = PREFERRED_TAB_WIDTH;
    });
    return widths;
  }

  const equalWidth = Math.floor(contentWidth / count);
  if (equalWidth >= ACTIVE_MIN_WIDTH) {
    state.tabs.forEach((tab) => {
      widths[tab.id] = equalWidth;
    });
    return widths;
  }

  const minimumTotal =
    ACTIVE_MIN_WIDTH + INACTIVE_MIN_WIDTH * Math.max(0, count - 1);
  if (minimumTotal <= contentWidth && count > 1) {
    const inactiveWidth = Math.floor(
      (contentWidth - ACTIVE_MIN_WIDTH) / (count - 1),
    );
    state.tabs.forEach((tab) => {
      widths[tab.id] =
        tab.id === state.activeTabId ? ACTIVE_MIN_WIDTH : inactiveWidth;
    });
    return widths;
  }

  state.tabs.forEach((tab) => {
    widths[tab.id] =
      tab.id === state.activeTabId ? ACTIVE_MIN_WIDTH : INACTIVE_MIN_WIDTH;
  });
  return widths;
}

function faviconText(tab) {
  const hostname = (() => {
    try {
      return new URL(tab.url).hostname;
    } catch {
      return "";
    }
  })();
  return (hostname || tab.title || "N").replace(/^www\./, "").slice(0, 1);
}

function renderTerminalLines() {
  return state.terminalLines
    .map(
      (line) =>
        `<div class="terminal-line ${escapeAttribute(line.tone)}">${escapeHtml(line.text)}</div>`,
    )
    .join("");
}

function renderTab(tab, widths) {
  const active = tab.id === state.activeTabId;
  const width = widths[tab.id] ?? INACTIVE_MIN_WIDTH;
  const accessibleName = [tab.title, tab.groupLabel, tab.mcp ? "MCP active" : ""]
    .filter(Boolean)
    .join(", ");
  return `
    <div
      class="tab-slot ${state.draggingTabId === tab.id ? "dragging" : ""}"
      data-tab-slot="${escapeAttribute(tab.id)}"
      draggable="true"
      style="--tab-width:${width}px;--group-color:${escapeAttribute(tab.groupColor)}"
    >
      <div class="browser-tab ${active ? "active" : ""} ${tab.mcp ? "mcp" : ""}">
        <button
          type="button"
          class="tab-select"
          role="tab"
          aria-selected="${active}"
          aria-label="${escapeAttribute(accessibleName)}"
          data-select-tab="${escapeAttribute(tab.id)}"
          title="${escapeAttribute(`${tab.title}\n${tab.url}`)}"
        >
          <span class="group-marker" aria-hidden="true"></span>
          <span class="favicon ${tab.loading ? "loading" : ""}" aria-hidden="true">${escapeHtml(faviconText(tab))}</span>
          <span class="tab-title">${escapeHtml(tab.title)}</span>
          ${
            tab.mcp
              ? '<span class="mcp-label"><span class="mcp-dot"></span>MCP</span>'
              : ""
          }
        </button>
        <button
          type="button"
          class="tab-close"
          data-close-tab="${escapeAttribute(tab.id)}"
          aria-label="Close ${escapeAttribute(tab.title)}"
          title="Close ${escapeAttribute(tab.title)}"
        >${icons.close}</button>
      </div>
    </div>
  `;
}

function renderOverview() {
  if (!state.overviewOpen) {
    return "";
  }
  const query = state.overviewQuery.trim().toLowerCase();
  const tabs = state.tabs.filter((tab) =>
    [tab.title, tab.url, tab.groupLabel]
      .join(" ")
      .toLowerCase()
      .includes(query),
  );
  return `
    <section class="tab-overview" aria-label="Browser tabs overview">
      <div class="overview-search-wrap">
        <input
          class="overview-search"
          data-role="overview-search"
          aria-label="Search browser tabs"
          placeholder="Search tabs"
          value="${escapeAttribute(state.overviewQuery)}"
        />
      </div>
      <div class="overview-list" role="listbox" aria-label="Open browser tabs">
        ${
          tabs.length
            ? tabs
                .map(
                  (tab) => `
                    <div
                      class="overview-item ${tab.id === state.activeTabId ? "active" : ""}"
                      role="option"
                      aria-selected="${tab.id === state.activeTabId}"
                    >
                      <button
                        type="button"
                        class="overview-select"
                        data-select-tab="${escapeAttribute(tab.id)}"
                      >
                        <span class="group-marker" style="--group-color:${escapeAttribute(tab.groupColor)}"></span>
                        <span class="favicon ${tab.loading ? "loading" : ""}">${escapeHtml(faviconText(tab))}</span>
                        <span class="overview-copy">
                          <strong>${escapeHtml(tab.title)}</strong>
                          <span>${escapeHtml(tab.url)}${tab.mcp ? " · MCP active" : ""}</span>
                        </span>
                      </button>
                      <button
                        type="button"
                        class="icon-button"
                        data-close-tab="${escapeAttribute(tab.id)}"
                        aria-label="Close ${escapeAttribute(tab.title)}"
                        title="Close ${escapeAttribute(tab.title)}"
                      >${icons.close}</button>
                    </div>
                  `,
                )
                .join("")
            : '<div class="overview-empty">No matching tabs</div>'
        }
      </div>
    </section>
  `;
}

function renderHelper() {
  if (!showPrototypeControls) {
    return "";
  }
  return `
    <aside class="prototype-helper visible" data-prototype-helper="true">
      <div class="helper-group">
        <span>width</span>
        ${[320, 480, 800]
          .map(
            (width) =>
              `<button class="helper-button ${state.sidecarWidth === width ? "active" : ""}" data-helper-width="${width}">${width}</button>`,
          )
          .join("")}
      </div>
      <div class="helper-group">
        <span>tabs</span>
        ${[1, 3, 6, 10, 20]
          .map(
            (count) =>
              `<button class="helper-button ${state.tabs.length === count ? "active" : ""}" data-helper-tabs="${count}">${count}</button>`,
          )
          .join("")}
      </div>
    </aside>
  `;
}

function render() {
  const activeTab = getActiveTab();
  const widths = getTabWidths();
  app.innerHTML = `
    <header class="topbar">
      <div class="brand"><span class="brand-mark">R</span>Runweave</div>
      <div class="project-tabs" aria-label="Projects">
        <button class="project-tab active"><span class="project-status"></span><span>${escapeHtml(state.workspace.name)}</span></button>
        <button class="project-tab"><span class="project-status" style="background:#64748b"></span><span>app-server</span></button>
      </div>
      <div class="top-actions">
        <button class="icon-button" aria-label="More workspace actions">${icons.more}</button>
      </div>
    </header>
    <section class="workspace">
      <section class="terminal-pane" aria-label="Terminal">
        <div class="terminal-header">
          <strong>${escapeHtml(state.workspace.branch)}</strong>
          <span>${escapeHtml(state.workspace.cwd)}</span>
        </div>
        <div class="terminal-output">${renderTerminalLines()}</div>
        <div class="terminal-composer"><span>›</span><span>Ask Codex or type a command…</span></div>
      </section>
      <div
        class="resize-handle"
        role="separator"
        tabindex="0"
        aria-label="Resize Browser sidecar"
        aria-orientation="vertical"
        aria-valuemin="${MIN_SIDECAR_WIDTH}"
        aria-valuemax="${MAX_SIDECAR_WIDTH}"
        aria-valuenow="${state.sidecarWidth}"
        data-role="resize-handle"
      ></div>
      <aside class="sidecar" style="width:${state.sidecarWidth}px">
        <header class="sidecar-header">
          <nav class="tool-tabs" role="tablist" aria-label="Sidecar tools">
            <button class="tool-tab" role="tab" aria-selected="false">Preview</button>
            <button class="tool-tab active" role="tab" aria-selected="true">Browser</button>
            <button class="tool-tab" role="tab" aria-selected="false">Agent Team</button>
          </nav>
          <button class="icon-button" aria-label="Expand sidecar" title="Expand sidecar">${icons.expand}</button>
          <button class="icon-button" aria-label="Close sidecar" title="Close sidecar">${icons.close}</button>
        </header>
        <section class="browser-panel">
          <div class="browser-tabbar" data-role="tabbar">
            <div class="tab-viewport" data-role="tab-viewport">
              <div class="browser-tab-strip" role="tablist" aria-label="Browser tabs">
                ${state.tabs.map((tab) => renderTab(tab, widths)).join("")}
              </div>
            </div>
            <div class="tab-actions">
              <button
                class="icon-button overview-button"
                data-action="toggle-overview"
                aria-label="Search all browser tabs"
                aria-expanded="${state.overviewOpen}"
                title="Search all browser tabs"
              >${icons.chevron}<span class="overview-count">${state.tabs.length}</span></button>
              <button class="icon-button" data-action="new-tab" aria-label="New browser tab" title="New browser tab">${icons.plus}</button>
            </div>
          </div>
          <div class="browser-toolbar">
            <button class="toolbar-icon" aria-label="Go back">${icons.back}</button>
            <button class="toolbar-icon" aria-label="Go forward">${icons.forward}</button>
            <button class="toolbar-icon" data-action="reload" aria-label="Reload">${icons.reload}</button>
            <input class="address-bar" data-role="address" aria-label="Address" value="${escapeAttribute(activeTab.url === "about:blank" ? "" : activeTab.url)}" />
            <button class="toolbar-icon" aria-label="Browser options">${icons.more}</button>
          </div>
          <div class="browser-content">
            <article class="mock-page">
              <div class="mock-page-inner">
                <p class="page-eyebrow">${escapeHtml(activeTab.groupLabel)} browser group</p>
                <h1>${escapeHtml(activeTab.title)}</h1>
                <p>${escapeHtml(activeTab.url === "about:blank" ? "A clean page ready for navigation." : `This prototype keeps the active tab readable while background tabs progressively collapse to stable, searchable icons.`)}</p>
                <div class="page-cards">
                  <div class="page-card"><strong>Active stays clear</strong><span>The selected tab keeps a wider minimum and a stable close target.</span></div>
                  <div class="page-card"><strong>Background tabs declutter</strong><span>Titles and inactive close actions yield before hit targets overlap.</span></div>
                  <div class="page-card"><strong>Every tab stays findable</strong><span>The fixed tab overview searches, activates, and closes the full set.</span></div>
                </div>
              </div>
            </article>
            ${renderOverview()}
          </div>
        </section>
      </aside>
    </section>
    ${renderHelper()}
  `;
  bindRenderedInteractions();
}

function scrollActiveTabIntoView(behavior = "smooth") {
  requestAnimationFrame(() => {
    const viewport = app.querySelector('[data-role="tab-viewport"]');
    const activeSlot = app.querySelector(`[data-tab-slot="${CSS.escape(state.activeTabId)}"]`);
    if (!viewport || !activeSlot) {
      return;
    }
    const tabLeft = activeSlot.offsetLeft;
    const tabRight = tabLeft + activeSlot.offsetWidth;
    const viewportLeft = viewport.scrollLeft;
    const viewportRight = viewportLeft + viewport.clientWidth;
    let nextScrollLeft = null;
    if (tabLeft < viewportLeft) {
      nextScrollLeft = tabLeft;
    } else if (tabRight > viewportRight) {
      nextScrollLeft = tabRight - viewport.clientWidth;
    }
    if (nextScrollLeft === null) {
      return;
    }
    if (behavior === "auto") {
      const previousScrollBehavior = viewport.style.scrollBehavior;
      viewport.style.scrollBehavior = "auto";
      viewport.scrollLeft = nextScrollLeft;
      viewport.style.scrollBehavior = previousScrollBehavior;
    } else {
      viewport.scrollTo({ left: nextScrollLeft, behavior });
    }
  });
}

function unfreezeLayout() {
  if (!state.frozenWidths) {
    return;
  }
  state = { ...state, frozenWidths: null };
  render();
  scrollActiveTabIntoView("auto");
}

function closeTab(tabId, pointerType = "mouse") {
  const closingIndex = state.tabs.findIndex((tab) => tab.id === tabId);
  if (closingIndex === -1) {
    return;
  }

  const measuredWidths = {};
  app.querySelectorAll("[data-tab-slot]").forEach((slot) => {
    measuredWidths[slot.dataset.tabSlot] = Math.round(slot.getBoundingClientRect().width);
  });

  let nextTabs = state.tabs.filter((tab) => tab.id !== tabId);
  if (nextTabs.length === 0) {
    nextTabs = [createNewTab()];
  }
  let nextActiveTabId = state.activeTabId;
  if (state.activeTabId === tabId) {
    nextActiveTabId = nextTabs[Math.min(closingIndex, nextTabs.length - 1)].id;
  }
  const frozenWidths = {};
  nextTabs.forEach((tab) => {
    frozenWidths[tab.id] = measuredWidths[tab.id] ?? INACTIVE_MIN_WIDTH;
  });
  if (frozenWidths[nextActiveTabId] < ACTIVE_MIN_WIDTH) {
    frozenWidths[nextActiveTabId] = ACTIVE_MIN_WIDTH;
  }

  state = {
    ...state,
    tabs: nextTabs,
    activeTabId: nextActiveTabId,
    frozenWidths,
  };
  render();
  scrollActiveTabIntoView("auto");

  if (touchUnfreezeTimer) {
    window.clearTimeout(touchUnfreezeTimer);
  }
  if (pointerType !== "mouse") {
    touchUnfreezeTimer = window.setTimeout(unfreezeLayout, 1800);
  }
}

function createNewTab() {
  const sequence = state?.tabSequence ?? 1;
  return {
    id: `new-tab-${sequence}`,
    title: "New Tab",
    url: "about:blank",
    groupColor: "#64748b",
    groupLabel: "manual",
    mcp: false,
    loading: false,
  };
}

function addNewTab() {
  const tab = createNewTab();
  const activeIndex = state.tabs.findIndex((item) => item.id === state.activeTabId);
  const tabs = [...state.tabs];
  tabs.splice(activeIndex + 1, 0, tab);
  state = {
    ...state,
    tabs,
    activeTabId: tab.id,
    tabSequence: state.tabSequence + 1,
    frozenWidths: null,
  };
  render();
  scrollActiveTabIntoView();
}

function selectTab(tabId, keepOverviewOpen = false) {
  if (!state.tabs.some((tab) => tab.id === tabId)) {
    return;
  }
  state = {
    ...state,
    activeTabId: tabId,
    overviewOpen: keepOverviewOpen ? state.overviewOpen : false,
    frozenWidths: null,
  };
  render();
  scrollActiveTabIntoView();
}

function setTabCount(count) {
  const payloadTabs = state.tabs;
  const allTabs = state.__allTabs;
  let tabs = allTabs.slice(0, count).map((tab, index) => ({
    ...tab,
    id: `${tab.id}-${index + 1}`,
  }));
  if (tabs.length < count) {
    tabs = [...payloadTabs];
    while (tabs.length < count) {
      tabs.push({ ...createNewTab(), id: `new-tab-${state.tabSequence + tabs.length}` });
    }
  }
  state = {
    ...state,
    tabs,
    activeTabId: tabs[Math.min(4, tabs.length - 1)].id,
    frozenWidths: null,
    overviewOpen: false,
  };
  render();
  scrollActiveTabIntoView("auto");
}

function moveTab(sourceId, targetId) {
  const sourceIndex = state.tabs.findIndex((tab) => tab.id === sourceId);
  const targetIndex = state.tabs.findIndex((tab) => tab.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
    return;
  }
  const tabs = [...state.tabs];
  const [moved] = tabs.splice(sourceIndex, 1);
  tabs.splice(targetIndex, 0, moved);
  state = { ...state, tabs, draggingTabId: null, frozenWidths: null };
  render();
  scrollActiveTabIntoView("auto");
}

function bindRenderedInteractions() {
  const tabbar = app.querySelector('[data-role="tabbar"]');
  tabbar?.addEventListener("pointerleave", () => {
    if (!resizeSession) {
      unfreezeLayout();
    }
  });

  const overviewSearch = app.querySelector('[data-role="overview-search"]');
  if (overviewSearch && state.overviewOpen) {
    requestAnimationFrame(() => {
      overviewSearch.focus({ preventScroll: true });
      overviewSearch.setSelectionRange(
        state.overviewQuery.length,
        state.overviewQuery.length,
      );
    });
  }
}

app.addEventListener("pointerdown", (event) => {
  const closeTarget = event.target.closest("[data-close-tab]");
  if (closeTarget) {
    event.preventDefault();
    event.stopPropagation();
    closeTab(closeTarget.dataset.closeTab, event.pointerType || "mouse");
    return;
  }

  const resizeHandle = event.target.closest('[data-role="resize-handle"]');
  if (resizeHandle) {
    event.preventDefault();
    resizeSession = {
      startX: event.clientX,
      startWidth: state.sidecarWidth,
    };
    resizeHandle.classList.add("resizing");
  }
});

document.addEventListener("pointermove", (event) => {
  if (!resizeSession) {
    return;
  }
  const width = clamp(
    resizeSession.startWidth + resizeSession.startX - event.clientX,
    MIN_SIDECAR_WIDTH,
    Math.min(MAX_SIDECAR_WIDTH, window.innerWidth - 240),
  );
  if (width !== state.sidecarWidth) {
    state = { ...state, sidecarWidth: Math.round(width), frozenWidths: null };
    render();
    scrollActiveTabIntoView("auto");
  }
});

document.addEventListener("pointerup", () => {
  resizeSession = null;
});

app.addEventListener("click", (event) => {
  const selectTarget = event.target.closest("[data-select-tab]");
  if (selectTarget) {
    selectTab(selectTarget.dataset.selectTab);
    return;
  }

  const actionTarget = event.target.closest("[data-action]");
  if (actionTarget?.dataset.action === "toggle-overview") {
    state = {
      ...state,
      overviewOpen: !state.overviewOpen,
      overviewQuery: state.overviewOpen ? "" : state.overviewQuery,
    };
    render();
    return;
  }
  if (actionTarget?.dataset.action === "new-tab") {
    addNewTab();
    return;
  }
  if (actionTarget?.dataset.action === "reload") {
    const tabs = state.tabs.map((tab) =>
      tab.id === state.activeTabId ? { ...tab, loading: true } : tab,
    );
    state = { ...state, tabs };
    render();
    window.setTimeout(() => {
      state = {
        ...state,
        tabs: state.tabs.map((tab) =>
          tab.id === state.activeTabId ? { ...tab, loading: false } : tab,
        ),
      };
      render();
    }, 900);
    return;
  }

  const helperWidth = event.target.closest("[data-helper-width]");
  if (helperWidth) {
    state = {
      ...state,
      sidecarWidth: Number(helperWidth.dataset.helperWidth),
      frozenWidths: null,
    };
    render();
    scrollActiveTabIntoView("auto");
    return;
  }

  const helperTabs = event.target.closest("[data-helper-tabs]");
  if (helperTabs) {
    setTabCount(Number(helperTabs.dataset.helperTabs));
  }
});

app.addEventListener("input", (event) => {
  if (event.target.matches('[data-role="overview-search"]')) {
    state = { ...state, overviewQuery: event.target.value };
    render();
  }
});

app.addEventListener("keydown", (event) => {
  const tabTarget = event.target.closest("[data-select-tab]");
  if (tabTarget && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    const index = state.tabs.findIndex((tab) => tab.id === tabTarget.dataset.selectTab);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? state.tabs.length - 1
          : event.key === "ArrowLeft"
            ? (index - 1 + state.tabs.length) % state.tabs.length
            : (index + 1) % state.tabs.length;
    selectTab(state.tabs[nextIndex].id);
    requestAnimationFrame(() => {
      app.querySelector(`[data-select-tab="${CSS.escape(state.activeTabId)}"]`)?.focus();
    });
    return;
  }

  if (event.key === "Escape" && state.overviewOpen) {
    state = { ...state, overviewOpen: false, overviewQuery: "" };
    render();
  }

  const resizeHandle = event.target.closest('[data-role="resize-handle"]');
  if (resizeHandle && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
    event.preventDefault();
    const delta = event.key === "ArrowLeft" ? 20 : -20;
    state = {
      ...state,
      sidecarWidth: clamp(
        state.sidecarWidth + delta,
        MIN_SIDECAR_WIDTH,
        MAX_SIDECAR_WIDTH,
      ),
      frozenWidths: null,
    };
    render();
  }

  const address = event.target.closest('[data-role="address"]');
  if (address && event.key === "Enter") {
    const value = address.value.trim() || "about:blank";
    state = {
      ...state,
      tabs: state.tabs.map((tab) =>
        tab.id === state.activeTabId
          ? { ...tab, url: value, title: value === "about:blank" ? "New Tab" : value }
          : tab,
      ),
    };
    render();
  }
});

app.addEventListener("dragstart", (event) => {
  const slot = event.target.closest("[data-tab-slot]");
  if (!slot) {
    return;
  }
  state.draggingTabId = slot.dataset.tabSlot;
  slot.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", slot.dataset.tabSlot);
});

app.addEventListener("dragover", (event) => {
  if (event.target.closest("[data-tab-slot]")) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }
});

app.addEventListener("drop", (event) => {
  const slot = event.target.closest("[data-tab-slot]");
  if (!slot) {
    return;
  }
  event.preventDefault();
  moveTab(event.dataTransfer.getData("text/plain"), slot.dataset.tabSlot);
});

app.addEventListener("dragend", () => {
  if (state.draggingTabId) {
    state = { ...state, draggingTabId: null };
    render();
  }
});

function renderLoadError(error) {
  app.innerHTML = `<pre style="margin:0;padding:18px;color:#fb7185;white-space:pre-wrap">无法加载 mock-state.json。\n\n${escapeHtml(error)}\n\n请使用 README 中的静态服务器命令启动原型。</pre>`;
}

fetch("./mock-state.json")
  .then((response) => {
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return response.json();
  })
  .then((payload) => {
    state = createInitialState(payload);
    state.__allTabs = payload.tabs;
    render();
    scrollActiveTabIntoView("auto");
  })
  .catch(renderLoadError);
