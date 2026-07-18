/* global URLSearchParams, document, fetch, window */

const app = document.querySelector("#app");

function render(state) {
  const columns = Math.max(state.actions.length, 1);
  const icon =
    state.icon === "spinner"
      ? '<span class="icon spinner" aria-hidden="true"></span>'
      : state.icon === "decision"
        ? '<span class="icon" aria-hidden="true">◆</span>'
        : '<span class="icon" aria-hidden="true">!</span>';

  app.innerHTML = `
    <header class="header">
      <span class="header-title">Agent Team</span>
      <span class="badge ${state.tone}">${state.label}</span>
    </header>
    <div class="content">
      <section class="control-card ${state.tone}" aria-label="${state.title}">
        <div class="control-title">${icon}<span>${state.title}</span></div>
        <p class="summary">${state.summary}</p>
        <div class="meta">${state.meta.map((item) => `<div>${item}</div>`).join("")}</div>
        ${state.reasonRequired ? '<textarea class="reason" placeholder="填写裁决原因（必填）"></textarea>' : ""}
        ${
          state.actions.length
            ? `<div class="actions" style="--columns:${columns}">${state.actions
                .map(
                  (action) =>
                    `<button type="button" class="action ${action.primary ? "primary" : ""}" data-action="${action.id}"><span>${action.label}</span></button>`,
                )
                .join("")}</div>`
            : ""
        }
      </section>
      <section class="loop" aria-label="Loop 状态">
        <div class="loop-row"><span>Loop 状态</span><span>Observe Only</span></div>
        <div class="loop-row"><span>当前轮次</span><span>round 4</span></div>
        <div class="loop-row"><span>最近 transition</span><span>dispatch boundary</span></div>
      </section>
    </div>`;
}

fetch("./mock-state.json")
  .then((response) => response.json())
  .then((data) => {
    const requested = new URLSearchParams(window.location.search).get("state");
    render(data.states[requested] ?? data.states[data.defaultState]);
  })
  .catch((error) => {
    app.textContent = `无法加载原型：${String(error)}`;
  });
