/* global URLSearchParams, document, fetch, window */

const app = document.querySelector("#app");

function toolButton(tool) {
  return `<button type="button" class="tool-item" data-tool="${tool.id}"><span class="tool-icon">${tool.icon}</span><span>${tool.label}</span></button>`;
}

function iconButton(tool, extra = "") {
  return `<button type="button" class="nav-button" data-tool="${tool.id}" aria-label="${tool.label}" title="${tool.label}" ${extra}>${tool.icon}</button>`;
}

function render(state) {
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

  app.innerHTML = `
    <section class="browser-shell">
      <div class="tabs"><button class="tab">Runweave Browser</button></div>
      <div class="navigation">
        ${iconButton({ id: "back", label: "Go back", icon: "←" })}
        ${iconButton({ id: "forward", label: "Go forward", icon: "→" })}
        ${iconButton({ id: "reload", label: "Reload", icon: "↻" })}
        <input class="address" aria-label="Browser address" value="https://runweave.local" />
        ${fixed.map((tool) => iconButton(tool)).join("")}
        ${iconButton({ id: "more", label: "More browser tools", icon: "•••" }, `aria-expanded="${state.moreOpen}"`)}
      </div>
      <div class="browser-content">
        <h1>Browser content</h1>
        <p>The native menu appears above the Electron browser view.</p>
      </div>
      <div class="tool-tray" ${state.moreOpen ? "" : "hidden"} aria-label="More browser tools">
        ${overflow.map(toolButton).join("")}
      </div>
    </section>`;
}

function bind(initialState) {
  const params = new URLSearchParams(window.location.search);
  let state = {
    ...initialState,
    annotationCount: Number(
      params.get("annotations") ?? initialState.annotationCount,
    ),
    headerRuleCount: Number(
      params.get("headers") ?? initialState.headerRuleCount,
    ),
    moreOpen: params.get("more") === "1",
  };
  render(state);
  app.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-tool]");
    if (button?.dataset.tool !== "more") return;
    state = { ...state, moreOpen: !state.moreOpen };
    render(state);
  });
}

fetch("./mock-state.json")
  .then((response) => response.json())
  .then(bind);
