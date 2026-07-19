/* global document, fetch */

const app = document.querySelector("#app");

function render(state) {
  const resolved = Boolean(state.decision);
  app.innerHTML = `
    <section class="panel">
      <header class="header">
        <strong>Agent Team</strong>
        <span class="status">${resolved ? "已完成 · 有人工裁决" : "需要 Case 裁决"}</span>
      </header>
      <div class="content">
        <section class="decision ${resolved ? "resolved" : ""}" aria-label="验收 Case 人工裁决">
          <div class="eyebrow">${resolved ? "人工裁决已记录" : "验收 Case 等待人工裁决"}</div>
          <h1>${state.title}</h1>
          <div class="case-id">${state.case.sourceCaseId}</div>
          <p class="case-text">${state.case.text}</p>
          <div class="observation">
            <strong>${state.case.observation.label}</strong>
            <p>${state.case.observation.detail}</p>
          </div>
          ${
            resolved
              ? `<div class="record">${state.decision.label}<br />理由：${state.decision.reason}<br />原始 observation 保持为 skipped。</div>`
              : `<label for="reason">裁决理由</label>
                 <textarea id="reason" placeholder="说明为什么本 Case 不应继续阻塞当前 Run"></textarea>
                 <div class="actions">
                   <button class="action primary" data-disposition="accepted_environment_skip" disabled>确认环境问题并跳过</button>
                   <button class="action" data-disposition="invalid_case" disabled>标记 Case 不适用</button>
                 </div>`
          }
        </section>
        <section class="evidence">
          <h2>验收用例 + 证据</h2>
          <p>${state.case.sourceCaseId} · ${state.case.observation.detail}</p>
        </section>
      </div>
    </section>
  `;
}

function bind(initialState) {
  let state = initialState;
  render(state);
  app.addEventListener("input", (event) => {
    if (event.target.id !== "reason") return;
    const enabled = Boolean(event.target.value.trim());
    app.querySelectorAll("[data-disposition]").forEach((button) => {
      button.disabled = !enabled;
    });
  });
  app.addEventListener("click", (event) => {
    const button = event.target.closest("[data-disposition]");
    if (!button) return;
    const reason = app.querySelector("#reason")?.value.trim();
    if (!reason) return;
    state = {
      ...state,
      decision: {
        disposition: button.dataset.disposition,
        label:
          button.dataset.disposition === "accepted_environment_skip"
            ? "已确认环境问题，本 Run 跳过"
            : "已标记 Case 不适用",
        reason,
      },
    };
    render(state);
  });
}

fetch("./mock-state.json")
  .then((response) => response.json())
  .then(bind);
