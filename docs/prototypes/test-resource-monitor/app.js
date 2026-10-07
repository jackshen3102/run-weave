/* global URLSearchParams, document, fetch, window */

const app = document.querySelector("#app");

function render(state) {
  const activeView = state.views.find((view) => view.id === state.activeViewId);
  const showPrototypeControls = new URLSearchParams(window.location.search).has(
    "prototypeControls",
  );

  app.innerHTML = `
    <header class="topbar">
      <div class="title">
        <strong>${state.title}</strong>
        <span>${state.subtitle}</span>
      </div>
      <div class="toolbar">
        ${state.actions
          .map(
            (action) => `
              <button class="button ${action.primary ? "primary" : ""}" data-action-id="${action.id}">
                ${action.label}
              </button>
            `,
          )
          .join("")}
      </div>
    </header>
    <section class="product-shell">
      <aside class="sidebar">
        <nav class="nav-list" aria-label="${state.navigationLabel}">
          ${state.views
            .map(
              (view) => `
                <button
                  class="nav-item ${view.id === state.activeViewId ? "active" : ""}"
                  data-view-id="${view.id}"
                >
                  ${view.label}
                </button>
              `,
            )
            .join("")}
        </nav>
      </aside>
      <div class="main-panel">
        <section class="stage">
          <div class="stage-header">
            <strong>${activeView.title}</strong>
            <span>${activeView.status}</span>
          </div>
          <div class="stage-body">
            ${activeView.items
              .map(
                (item) => `
                  <article class="item">
                    <h2>${item.title}</h2>
                    <p>${item.description}</p>
                  </article>
                `,
              )
              .join("")}
          </div>
        </section>
      </div>
    </section>
    <aside
      class="prototype-controls ${showPrototypeControls ? "visible" : ""}"
      data-prototype-helper="true"
      aria-hidden="${showPrototypeControls ? "false" : "true"}"
    >
      <div class="prototype-controls-inner">
        <span>Prototype helper, not product UI</span>
        <div>
          ${state.views
            .map(
              (view) => `
                <button class="button" data-view-id="${view.id}">
                  ${view.label}
                </button>
              `,
            )
            .join("")}
        </div>
      </div>
    </aside>
  `;
}

function bindInteractions(initialState) {
  let state = initialState;
  render(state);

  app.addEventListener("click", (event) => {
    const target = event.target.closest("button");
    if (!target) return;

    if (target.dataset.actionId) {
      state = {
        ...state,
        lastActionId: target.dataset.actionId,
      };
      render(state);
      return;
    }

    if (target.dataset.viewId) {
      state = {
        ...state,
        activeViewId: target.dataset.viewId,
      };
      render(state);
    }
  });
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
    "python3 -m http.server 6188 --directory docs/prototypes/<feature-slug>",
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
