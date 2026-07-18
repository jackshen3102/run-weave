/* global document, fetch */

const state = {
  data: null,
  activeView: "loop",
  activeScenario: "prompt-defect",
  activeCause: "product",
  activeLevel: "L4",
};

function byId(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderStats() {
  byId("stats").innerHTML = state.data.stats
    .map(
      (stat) => `
        <article class="stat">
          <strong>${escapeHtml(stat.value)}</strong>
          <span>${escapeHtml(stat.label)}</span>
          <small>${escapeHtml(stat.note)}</small>
        </article>`,
    )
    .join("");
}

function renderViews() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.setAttribute(
      "aria-selected",
      String(button.dataset.view === state.activeView),
    );
  });
  document.querySelectorAll("[data-view-panel]").forEach((panel) => {
    panel.classList.toggle(
      "is-active",
      panel.dataset.viewPanel === state.activeView,
    );
  });
}

function getActiveScenario() {
  return state.data.scenarios.find(
    (scenario) => scenario.id === state.activeScenario,
  );
}

function renderScenarioStrip() {
  byId("scenario-strip").innerHTML = state.data.scenarios
    .map(
      (scenario) => `
        <button
          type="button"
          class="scenario-button"
          data-scenario="${escapeHtml(scenario.id)}"
          aria-pressed="${String(scenario.id === state.activeScenario)}"
        >
          <strong>${escapeHtml(scenario.label)}</strong>
          <span>${escapeHtml(scenario.subtitle)}</span>
        </button>`,
    )
    .join("");

  document.querySelectorAll("[data-scenario]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeScenario = button.dataset.scenario;
      renderScenarioStrip();
      renderFlow();
      renderScenarioDetail();
    });
  });
}

function renderFlow() {
  const scenario = getActiveScenario();
  const activePath = new Set(scenario.path);
  const lastPathNode = scenario.path.at(-1);

  byId("flow-stage").innerHTML = state.data.flowColumns
    .map(
      (column) => `
        <div class="flow-column" data-flow-column="${escapeHtml(column.id)}">
          ${column.nodes
            .map(
              (node) => `
                <article
                  class="flow-node ${activePath.has(node.id) ? "is-path" : ""} ${node.id === lastPathNode ? "is-output" : ""}"
                  data-kind="${escapeHtml(node.kind)}"
                >
                  <div class="node-kicker">
                    <span>${escapeHtml(node.kicker)}</span><i></i>
                  </div>
                  <h3>${escapeHtml(node.title)}</h3>
                  <p>${escapeHtml(node.body)}</p>
                  <div class="node-tags">
                    ${node.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}
                  </div>
                </article>`,
            )
            .join("")}
        </div>`,
    )
    .join("");
}

function renderScenarioDetail() {
  const scenario = getActiveScenario();
  byId("scenario-detail").innerHTML = `
    <span class="mini-tag">${escapeHtml(scenario.badge)}</span>
    <h3>${escapeHtml(scenario.title)}</h3>
    <p>${escapeHtml(scenario.summary)}</p>
    <ol class="detail-list">
      ${scenario.steps
        .map(
          (step, index) =>
            `<li data-index="${index + 1}">${escapeHtml(step)}</li>`,
        )
        .join("")}
    </ol>
    <div class="decision-box">
      <span>Evolution decision</span>
      <strong>${escapeHtml(scenario.decision)}</strong>
    </div>`;
}

function renderOptions() {
  byId("option-grid").innerHTML = state.data.options
    .map(
      (option) => `
        <article class="option-card ${option.recommended ? "is-recommended" : ""}">
          ${option.recommended ? '<span class="recommended-ribbon">RECOMMENDED</span>' : ""}
          <span class="option-id">OPTION ${escapeHtml(option.id)}</span>
          <h3>${escapeHtml(option.name)}</h3>
          <p>${escapeHtml(option.description)}</p>
          <div class="option-meta">
            <span><small>Estimate</small><strong>${escapeHtml(option.estimate)}</strong></span>
            <span><small>Complexity</small><strong>${escapeHtml(option.complexity)}</strong></span>
            <span><small>Autonomy</small><strong>${escapeHtml(option.level)}</strong></span>
          </div>
          <ul class="check-list">
            ${option.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
          </ul>
        </article>`,
    )
    .join("");
}

function renderPromptChain() {
  byId("prompt-chain").innerHTML = state.data.promptChain
    .map(
      (step) => `
        <article class="prompt-step">
          <span>${escapeHtml(step.index)}</span>
          <strong>${escapeHtml(step.title)}</strong>
          <small>${escapeHtml(step.detail)}</small>
        </article>`,
    )
    .join("");
}

function getActiveCause() {
  return state.data.causes.find((cause) => cause.id === state.activeCause);
}

function renderCauseTabs() {
  byId("cause-tabs").innerHTML = state.data.causes
    .map(
      (cause) => `
        <button
          type="button"
          class="cause-tab"
          data-cause="${escapeHtml(cause.id)}"
          aria-pressed="${String(cause.id === state.activeCause)}"
        >
          <strong>${escapeHtml(cause.title)}</strong>
          <span>${escapeHtml(cause.subtitle)}</span>
        </button>`,
    )
    .join("");

  document.querySelectorAll("[data-cause]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeCause = button.dataset.cause;
      renderCauseTabs();
      renderCauseDetail();
    });
  });
}

function renderCauseDetail() {
  const cause = getActiveCause();
  byId("cause-detail").innerHTML = `
    <div>
      <span class="mini-tag">${escapeHtml(cause.badge)}</span>
      <h3>${escapeHtml(cause.headline)}</h3>
      <p>${escapeHtml(cause.description)}</p>
      <div class="anti-rule">${escapeHtml(cause.antiRule)}</div>
    </div>
    <div class="cause-action">
      <strong>${escapeHtml(cause.actionTitle)}</strong>
      <span>${escapeHtml(cause.action)}</span>
    </div>`;
}

function renderLintDimensions() {
  byId("lint-grid").innerHTML = state.data.lintDimensions
    .map(
      (dimension) => `
        <article class="lint-card">
          <strong>${escapeHtml(dimension.title)}</strong>
          <span>${escapeHtml(dimension.detail)}</span>
        </article>`,
    )
    .join("");
}

function getActiveLevel() {
  return state.data.levels.find((level) => level.id === state.activeLevel);
}

function renderLevelMeter() {
  byId("level-meter").innerHTML = state.data.levels
    .map(
      (level) => `
        <button
          type="button"
          class="level-button"
          data-level="${escapeHtml(level.id)}"
          aria-pressed="${String(level.id === state.activeLevel)}"
        >
          <strong>${escapeHtml(level.id)} · ${escapeHtml(level.name)}</strong>
          <span>${escapeHtml(level.subtitle)}</span>
        </button>`,
    )
    .join("");

  document.querySelectorAll("[data-level]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeLevel = button.dataset.level;
      renderLevelMeter();
      renderLevelDetail();
    });
  });
}

function renderLevelDetail() {
  const level = getActiveLevel();
  byId("level-detail").innerHTML = `
    <div>
      <span class="mini-tag">${escapeHtml(level.id)} · ${escapeHtml(level.subtitle)}</span>
      <h3>${escapeHtml(level.name)}</h3>
      <p>${escapeHtml(level.description)}</p>
      <div class="level-boundary">${escapeHtml(level.boundary)}</div>
    </div>
    <ul class="permission-list">
      <li><strong>允许</strong><span>${escapeHtml(level.can)}</span></li>
      <li><strong class="deny">禁止</strong><span>${escapeHtml(level.cannot)}</span></li>
      <li><strong>核心产物</strong><span>${escapeHtml(level.output)}</span></li>
      <li><strong>晋级条件</strong><span>证据充分、关键维度无回归、具备回滚点</span></li>
    </ul>`;
}

function renderCadence() {
  byId("cadence-track").innerHTML = state.data.cadence
    .map(
      (item) => `
        <article class="cadence-card">
          <time>${escapeHtml(item.when)}</time>
          <h3>${escapeHtml(item.title)}</h3>
          <p>${escapeHtml(item.detail)}</p>
        </article>`,
    )
    .join("");
}

function renderThresholds() {
  byId("threshold-list").innerHTML = state.data.thresholds
    .map(
      (item) => `
        <div class="threshold-row">
          <strong>${escapeHtml(item.name)}</strong>
          <span>${escapeHtml(item.condition)}</span>
          <code>${escapeHtml(item.value)}</code>
        </div>`,
    )
    .join("");
}

function renderContracts() {
  byId("contract-grid").innerHTML = state.data.contracts
    .map(
      (item) => `
        <article class="contract-card">
          <strong>${escapeHtml(item.name)}</strong>
          <span>${escapeHtml(item.detail)}</span>
        </article>`,
    )
    .join("");
}

function renderMetrics() {
  byId("metric-grid").innerHTML = state.data.metrics
    .map(
      (item) => `
        <article class="metric-card">
          <strong>${escapeHtml(item.name)}</strong>
          <span>${escapeHtml(item.detail)}</span>
        </article>`,
    )
    .join("");
}

function bindNavigation() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeView = button.dataset.view;
      renderViews();
      globalThis.scrollTo({ top: 300, behavior: "smooth" });
    });
  });
}

function renderAll() {
  renderStats();
  renderViews();
  renderScenarioStrip();
  renderFlow();
  renderScenarioDetail();
  renderOptions();
  renderPromptChain();
  renderCauseTabs();
  renderCauseDetail();
  renderLintDimensions();
  renderLevelMeter();
  renderLevelDetail();
  renderCadence();
  renderThresholds();
  renderContracts();
  renderMetrics();
  bindNavigation();
}

fetch("./mock-state.json")
  .then((response) => {
    if (!response.ok) {
      throw new Error(`Unable to load architecture data: ${response.status}`);
    }
    return response.json();
  })
  .then((data) => {
    state.data = data;
    renderAll();
  })
  .catch((error) => {
    document.body.innerHTML = `<main class="page"><div class="panel prompt-panel"><h1>Architecture data failed to load</h1><p>${escapeHtml(error.message)}</p></div></main>`;
  });
