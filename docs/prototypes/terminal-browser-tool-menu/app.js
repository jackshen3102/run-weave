/* global URLSearchParams, document, fetch, window */

const app = document.querySelector("#app");

function toolButton(tool) {
  return `<button type="button" class="tool-item" role="menuitem" data-tool="${tool.id}"><span class="tool-icon">${tool.icon}</span><span>${tool.label}</span></button>`;
}

function iconButton(tool, extra = "") {
  return `<button type="button" class="nav-button" data-tool="${tool.id}" aria-label="${tool.label}" title="${tool.label}" ${extra}>${tool.icon}</button>`;
}

function activeTab(state) {
  return (
    state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0]
  );
}

function formatZoom(displayScale) {
  return `${Math.round(displayScale * 100)}%`;
}

function zoomStep(state, direction) {
  const tab = activeTab(state);
  const currentIndex = state.zoomLevels.findIndex(
    (level) => level === tab.displayScale,
  );
  if (currentIndex === -1) return tab.displayScale;
  const nextIndex = Math.max(
    0,
    Math.min(state.zoomLevels.length - 1, currentIndex + direction),
  );
  return state.zoomLevels[nextIndex];
}

function zoomMenu(state, tool) {
  const tab = activeTab(state);
  const zoomOutDisabled = tab.displayScale === state.zoomLevels[0];
  const zoomInDisabled =
    tab.displayScale === state.zoomLevels[state.zoomLevels.length - 1];
  const resetDisabled = tab.displayScale === 1;

  return `
    <div class="menu-item-with-submenu">
      <button type="button" class="tool-item" role="menuitem" data-tool="zoom" aria-haspopup="menu" aria-expanded="${state.zoomMenuOpen}">
        <span class="tool-icon">${tool.icon}</span>
        <span>${tool.label}</span>
        <span class="tool-value">${formatZoom(tab.displayScale)}</span>
        <span class="menu-chevron">›</span>
      </button>
      <div class="zoom-submenu" role="menu" aria-label="Zoom" ${state.zoomMenuOpen ? "" : "hidden"}>
        <button type="button" class="tool-item" role="menuitem" data-zoom-action="out" ${zoomOutDisabled ? "disabled" : ""}>Zoom out</button>
        <button type="button" class="tool-item" role="menuitem" data-zoom-action="in" ${zoomInDisabled ? "disabled" : ""}>Zoom in</button>
        <div class="menu-separator" role="separator"></div>
        <button type="button" class="tool-item" role="menuitem" data-zoom-action="reset" ${resetDisabled ? "disabled" : ""}>Reset zoom</button>
      </div>
    </div>`;
}

function overflowTool(tool, state) {
  return tool.id === "zoom" ? zoomMenu(state, tool) : toolButton(tool);
}

function render(state) {
  const tab = activeTab(state);
  const promotedIds = new Set([
    ...(state.headerRuleCount > 0 ? ["headers"] : []),
    ...(state.annotationCount > 0 ? ["annotate"] : []),
  ]);
  const fixed = state.tools.filter(
    (tool) => tool.fixed || promotedIds.has(tool.id),
  );
  const overflow = state.tools.filter(
    (tool) => !tool.fixed && !promotedIds.has(tool.id),
  );
  const pageWidth = (100 / tab.displayScale).toFixed(3);
  const pageHeight = Math.round(340 / tab.displayScale);

  app.innerHTML = `
    <section class="browser-shell">
      <div class="tabs" role="tablist" aria-label="Browser tabs">
        ${state.tabs
          .map(
            (item) =>
              `<button type="button" class="tab" role="tab" data-tab-id="${item.id}" aria-selected="${item.id === tab.id}">${item.title}</button>`,
          )
          .join("")}
      </div>
      <div class="navigation">
        ${iconButton({ id: "back", label: "Go back", icon: "←" })}
        ${iconButton({ id: "forward", label: "Go forward", icon: "→" })}
        ${iconButton({ id: "reload", label: "Reload", icon: "↻" })}
        <input class="address" aria-label="Browser address" value="${tab.url}" />
        ${fixed.map((tool) => iconButton(tool)).join("")}
        ${iconButton({ id: "more", label: "More browser tools", icon: "•••" }, `aria-expanded="${state.moreOpen}"`)}
      </div>
      <div class="browser-viewport">
        <div class="browser-page" style="width: ${pageWidth}%; min-height: ${pageHeight}px; transform: scale(${tab.displayScale})">
          <h1>${tab.heading}</h1>
          <p>${tab.description}</p>
          <div class="content-grid">
            <div class="content-card"><strong>Overview</strong><p>Current workspace activity and recent changes.</p></div>
            <div class="content-card"><strong>Tasks</strong><p>Track browser automation across the active page.</p></div>
            <div class="content-card"><strong>Evidence</strong><p>Review screenshots and interaction results.</p></div>
          </div>
        </div>
      </div>
      <div class="tool-tray" role="menu" ${state.moreOpen ? "" : "hidden"} aria-label="More browser tools">
        ${overflow.map((tool) => overflowTool(tool, state)).join("")}
      </div>
    </section>`;
}

function queryScale(params, name, fallback, zoomLevels) {
  const percent = Number(params.get(name));
  const factor = percent / 100;
  return zoomLevels.includes(factor) ? factor : fallback;
}

function bind(initialState) {
  const params = new URLSearchParams(window.location.search);
  const requestedTabId = params.get("tab");
  const tabs = initialState.tabs.map((tab) => ({
    ...tab,
    displayScale: queryScale(
      params,
      tab.id === "tab-a" ? "zoomA" : "zoomB",
      tab.displayScale,
      initialState.zoomLevels,
    ),
  }));
  const activeTabId = tabs.some((tab) => tab.id === requestedTabId)
    ? requestedTabId
    : initialState.activeTabId;
  let state = {
    ...initialState,
    activeTabId,
    tabs,
    annotationCount: Number(
      params.get("annotations") ?? initialState.annotationCount,
    ),
    headerRuleCount: Number(
      params.get("headers") ?? initialState.headerRuleCount,
    ),
    moreOpen:
      params.get("more") === "1" || params.get("zoomMenu") === "1",
    zoomMenuOpen: params.get("zoomMenu") === "1",
  };
  render(state);
  app.addEventListener("click", (event) => {
    const tabButton = event.target.closest("button[data-tab-id]");
    if (tabButton) {
      state = {
        ...state,
        activeTabId: tabButton.dataset.tabId,
        moreOpen: false,
        zoomMenuOpen: false,
      };
      render(state);
      return;
    }

    const zoomAction = event.target.closest("button[data-zoom-action]");
    if (zoomAction && !zoomAction.disabled) {
      const displayScale =
        zoomAction.dataset.zoomAction === "reset"
          ? 1
          : zoomStep(
              state,
              zoomAction.dataset.zoomAction === "in" ? 1 : -1,
            );
      const currentTab = activeTab(state);
      state = {
        ...state,
        tabs: state.tabs.map((tab) =>
          tab.id === currentTab.id ? { ...tab, displayScale } : tab,
        ),
        moreOpen: false,
        zoomMenuOpen: false,
      };
      render(state);
      return;
    }

    const button = event.target.closest("button[data-tool]");
    if (button?.dataset.tool === "more") {
      state = {
        ...state,
        moreOpen: !state.moreOpen,
        zoomMenuOpen: false,
      };
      render(state);
      return;
    }
    if (button?.dataset.tool === "zoom") {
      state = { ...state, zoomMenuOpen: !state.zoomMenuOpen };
      render(state);
      return;
    }
    if (button) {
      state = { ...state, moreOpen: false, zoomMenuOpen: false };
      render(state);
      return;
    }
    if (state.moreOpen) {
      state = { ...state, moreOpen: false, zoomMenuOpen: false };
      render(state);
    }
  });
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !state.moreOpen) return;
    state = { ...state, moreOpen: false, zoomMenuOpen: false };
    render(state);
  });
}

fetch("./mock-state.json")
  .then((response) => response.json())
  .then(bind);
