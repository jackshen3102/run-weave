/* global document, fetch */

const app = document.querySelector("#app");

function eventLine(message) {
  const time = new Date().toLocaleTimeString();
  return `${time} ${message}`;
}

function render(state) {
  const activeStep = state.steps.find((step) => step.id === state.activeStepId);

  app.innerHTML = `
    <header class="topbar">
      <div class="title">
        <strong>${state.title}</strong>
        <span>${state.subtitle}</span>
      </div>
      <div class="toolbar">
        <button class="button" data-action="previous">上一步</button>
        <button class="button primary" data-action="next">下一步</button>
      </div>
    </header>
    <section class="workspace">
      <div class="main-panel">
        <nav class="step-row" aria-label="原型步骤">
          ${state.steps
            .map(
              (step) => `
                <button
                  class="step ${step.id === state.activeStepId ? "active" : ""}"
                  data-step-id="${step.id}"
                >
                  ${step.label}
                </button>
              `,
            )
            .join("")}
        </nav>
        <section class="stage">
          <div class="stage-header">
            <strong>${activeStep.title}</strong>
            <span>${activeStep.status}</span>
          </div>
          <div class="stage-body">
            ${activeStep.items
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
      <aside class="sidecar">
        <h2>事件流</h2>
        <div class="event-list">
          ${state.events.map((event) => `<div class="event">${event}</div>`).join("")}
        </div>
      </aside>
    </section>
  `;
}

function moveStep(state, direction) {
  const index = state.steps.findIndex((step) => step.id === state.activeStepId);
  const nextIndex = Math.max(0, Math.min(state.steps.length - 1, index + direction));
  const nextStep = state.steps[nextIndex];
  return {
    ...state,
    activeStepId: nextStep.id,
    events: [eventLine(`聚焦步骤 ${nextStep.id}`), ...state.events].slice(0, 8),
  };
}

function bindInteractions(initialState) {
  let state = initialState;
  render(state);

  app.addEventListener("click", (event) => {
    const target = event.target.closest("button");
    if (!target) return;

    if (target.dataset.action === "previous") {
      state = moveStep(state, -1);
      render(state);
      return;
    }

    if (target.dataset.action === "next") {
      state = moveStep(state, 1);
      render(state);
      return;
    }

    if (target.dataset.stepId) {
      state = {
        ...state,
        activeStepId: target.dataset.stepId,
        events: [eventLine(`选择步骤 ${target.dataset.stepId}`), ...state.events].slice(0, 8),
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
