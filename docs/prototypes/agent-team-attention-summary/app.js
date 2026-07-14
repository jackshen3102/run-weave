/* global URLSearchParams, document, fetch, window */

const app = document.querySelector("#app");

function render(state) {
  const requestedState = new URLSearchParams(window.location.search).get(
    "state",
  );
  const view = state.states[requestedState] ?? state.states[state.defaultState];

  app.innerHTML = `
    <header class="panel-header">
      <h1>Agent Team</h1>
      <span class="status-badge">${view.runStatusLabel}</span>
    </header>
    <section class="attention-region" aria-label="当前关注">
      <article class="attention-card">
        <div class="attention-heading">
          <span>当前关注</span>
          <span>${view.issueCount} 个问题</span>
        </div>
        <div class="attention-title-row">
          <span class="severity">${view.attention.severity}</span>
          <span class="attention-title">${view.attention.title}</span>
        </div>
        <p class="attention-summary">${view.attention.summary}</p>
        <div class="attention-meta">${view.attention.meta}</div>
        <div class="attention-actions">
          <button class="attention-action" type="button" data-focus-pane>
            聚焦 Code pane
          </button>
          <button class="attention-action primary" type="button" data-show-detail>
            查看详情 ↓
          </button>
        </div>
      </article>
    </section>
    <section class="scroll-content" data-scroll-content>
      <div class="section-heading">
        <span>Loop 状态</span>
        <span class="observe-only">Observe Only</span>
      </div>
      <article class="checkpoint">
        <strong>Review Checkpoint</strong><br />
        分支：runweave/agt-f4741241<br />
        最新 checkpoint：d83ce395<br />
        当前审查：incremental · 影响文件 16
      </article>
      <article class="loop-card">
        <div>轮次 <strong>round 130</strong></div>
        <div>无进展 <strong>0 / 3</strong></div>
        <div class="progress"><span></span><span></span><span></span></div>
      </article>
      <div class="completion-note">Loop 已人工结束，worker pane 已冻结。</div>
      <div class="section-heading">
        <span>验收用例 + 证据</span>
        <span>24✓ 1✗</span>
      </div>
      <div class="case-list">
        ${view.cases.map(renderCase).join("")}
      </div>
      <article class="log-card">
        round 129 无进展，noProgress=0/3<br />
        用例 case_25 稳定失败，已抛回 code pane<br />
        人工确认结束本次 Run
      </article>
    </section>
  `;
}

function renderCase(item) {
  return `
    <article
      class="case-card ${item.status}"
      ${item.id === "case_25" ? "data-attention-detail" : ""}
    >
      <div class="case-heading">
        <span class="case-id">${item.id}</span>
        <span class="case-result">${item.status === "pass" ? "✓ 已通过" : "✗ 未通过"}</span>
      </div>
      <p>${item.summary}</p>
    </article>
  `;
}

function bindInteractions() {
  app.addEventListener("click", (event) => {
    const showDetail = event.target.closest("[data-show-detail]");
    if (showDetail) {
      const detail = app.querySelector("[data-attention-detail]");
      detail?.scrollIntoView({ behavior: "smooth", block: "center" });
      detail?.classList.add("flash");
      window.setTimeout(() => detail?.classList.remove("flash"), 1200);
      return;
    }

    if (event.target.closest("[data-focus-pane]")) {
      app.dataset.focusedPane = "code";
    }
  });
}

function renderLoadError(error) {
  app.textContent = `无法加载 mock-state.json：${String(error)}`;
}

fetch("./mock-state.json")
  .then((response) => {
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return response.json();
  })
  .then((state) => {
    render(state);
    bindInteractions();
  })
  .catch(renderLoadError);
