/* global document, fetch */

const TONES = {
  blue: "#68a9ff",
  cyan: "#54d4c7",
  green: "#6ed89a",
  amber: "#f5c161",
  purple: "#ad9cff",
  red: "#ff7882",
};

const state = {
  data: null,
  activeView: "system",
  activeScenario: "query",
  activeNode: null,
  activeFailure: "hub-down",
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function byId(id) {
  return document.getElementById(id);
}

function getScenario() {
  return state.data.scenarios.find(
    (scenario) => scenario.id === state.activeScenario,
  );
}

function getFailure() {
  return state.data.failureScenarios.find(
    (scenario) => scenario.id === state.activeFailure,
  );
}

function tone(name) {
  return TONES[name] ?? TONES.blue;
}

function renderStats() {
  byId("stats").innerHTML = state.data.stats
    .map(
      (stat) => `
        <article class="stat" style="--tone:${tone(stat.tone)}">
          <strong>${escapeHtml(stat.value)}</strong>
          <span>${escapeHtml(stat.label)}</span>
        </article>`,
    )
    .join("");
}

function renderTruthRules() {
  byId("truth-strip").innerHTML = state.data.truthRules
    .map(
      (rule) => `
        <article class="truth-card" style="--truth-tone:${tone(rule.tone)}">
          <span>${escapeHtml(rule.label)}</span>
          <h3>${escapeHtml(rule.title)}</h3>
          <p>${escapeHtml(rule.body)}</p>
        </article>`,
    )
    .join("");
}

function bindViewTabs() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeView = button.dataset.view;
      document.querySelectorAll("[data-view]").forEach((candidate) => {
        candidate.setAttribute(
          "aria-selected",
          String(candidate.dataset.view === state.activeView),
        );
      });
      document.querySelectorAll("[data-view-panel]").forEach((panel) => {
        panel.hidden = panel.dataset.viewPanel !== state.activeView;
      });
    });
  });
}

function renderScenarioButtons() {
  byId("scenario-strip").innerHTML = state.data.scenarios
    .map(
      (scenario) => `
        <button
          class="scenario-button"
          data-scenario="${escapeHtml(scenario.id)}"
          aria-pressed="${scenario.id === state.activeScenario}"
          style="--scenario-tone:${tone(scenario.tone)}"
        >
          <strong>${escapeHtml(scenario.label)}</strong>
          <span>${escapeHtml(scenario.id)}</span>
        </button>`,
    )
    .join("");

  document.querySelectorAll("[data-scenario]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeScenario = button.dataset.scenario;
      state.activeNode = null;
      renderScenarioButtons();
      renderFlow();
      renderScenarioDetail();
    });
  });
}

function renderFlow() {
  const scenario = getScenario();
  const activePath = new Set(scenario.path);
  const activeTone = tone(scenario.tone);

  byId("flow-stage").style.setProperty("--active-tone", activeTone);
  byId("scenario-detail").style.setProperty("--active-tone", activeTone);

  byId("flow-stage").innerHTML = state.data.lanes
    .map((lane) => {
      const nodes = state.data.nodes.filter((node) => node.lane === lane.id);
      return `
        <section class="lane" data-lane="${escapeHtml(lane.id)}">
          <header class="lane-label">
            <strong>${escapeHtml(lane.title)}</strong>
            <span>${escapeHtml(lane.subtitle)}</span>
          </header>
          ${nodes
            .map(
              (node) => `
                <article class="node ${activePath.has(node.id) ? "is-path" : ""} ${state.activeNode === node.id ? "is-selected" : ""}">
                  <button type="button" data-node="${escapeHtml(node.id)}">
                    <span class="node-eyebrow">${escapeHtml(node.eyebrow)}</span>
                    <h3>${escapeHtml(node.title)}</h3>
                    <p>${escapeHtml(node.body)}</p>
                    <span class="node-tags">
                      ${node.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}
                    </span>
                  </button>
                </article>`,
            )
            .join("")}
        </section>`;
    })
    .join("");

  document.querySelectorAll("[data-node]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeNode =
        state.activeNode === button.dataset.node ? null : button.dataset.node;
      renderFlow();
      renderScenarioDetail();
    });
  });
}

function renderScenarioDetail() {
  const scenario = getScenario();
  const selectedNode = state.activeNode
    ? state.data.nodes.find((node) => node.id === state.activeNode)
    : null;

  byId("scenario-detail").innerHTML = `
    <span class="scenario-badge">${escapeHtml(scenario.id)}</span>
    <h3>${escapeHtml(scenario.label)}</h3>
    <p class="scenario-summary">${escapeHtml(scenario.summary)}</p>
    <div class="scenario-metrics">
      ${scenario.metrics
        .map(
          (metric) => `
            <div class="scenario-metric">
              <strong>${escapeHtml(metric.value)}</strong>
              <span>${escapeHtml(metric.label)}</span>
            </div>`,
        )
        .join("")}
    </div>
    <ol class="step-list">
      ${scenario.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}
    </ol>
    ${
      selectedNode
        ? `
          <div class="selected-node-detail">
            <span>SELECTED NODE</span>
            <strong>${escapeHtml(selectedNode.title)}</strong>
            <p>${escapeHtml(selectedNode.detail)}</p>
          </div>`
        : ""
    }
  `;
}

function renderDataMatrix() {
  const headers = [
    ["Source", "17%"],
    ["Capture point", "17%"],
    ["Direct Fact · 30d", "23%"],
    ["Hub Content · 7d", "15%"],
    ["External Ref", "14%"],
    ["Coverage boundary", "14%"],
  ];
  const chip = {
    record: { label: "active write", tone: TONES.green },
    reference: { label: "reference only", tone: TONES.amber },
    unsupported: { label: "not promised", tone: TONES.red },
  };

  byId("data-matrix").innerHTML = `
    <table class="matrix-table">
      <colgroup>
        ${headers.map(([, width]) => `<col style="width:${width}" />`).join("")}
      </colgroup>
      <thead>
        <tr>${headers.map(([label]) => `<th>${escapeHtml(label)}</th>`).join("")}</tr>
      </thead>
      <tbody>
        ${state.data.dataMatrix
          .map((row) => {
            const status = chip[row.status];
            return `
              <tr>
                <td>
                  ${escapeHtml(row.source)}
                  <span class="status-chip" style="--chip-tone:${status.tone}">${status.label}</span>
                </td>
                <td>${escapeHtml(row.capture)}</td>
                <td>${escapeHtml(row.direct)}</td>
                <td>${escapeHtml(row.content)}</td>
                <td>${escapeHtml(row.external)}</td>
                <td>${escapeHtml(row.coverage)}</td>
              </tr>`;
          })
          .join("")}
      </tbody>
    </table>`;
}

function renderLearning() {
  const stepTone = {
    deterministic: TONES.cyan,
    model: TONES.purple,
    human: TONES.green,
  };
  byId("learning-flow").innerHTML = state.data.learningSteps
    .map(
      (step) => `
        <article class="learning-step" style="--step-tone:${stepTone[step.kind]}">
          <span>${escapeHtml(step.kind)}</span>
          <h3>${escapeHtml(step.title)}</h3>
          <p>${escapeHtml(step.body)}</p>
          <code>output: ${escapeHtml(step.output)}</code>
        </article>`,
    )
    .join("");

  byId("learning-objects").innerHTML = state.data.learningObjects
    .map(
      (item) => `
        <article class="object-card">
          <strong>${escapeHtml(item.name)}</strong>
          <span>${escapeHtml(item.retention)}</span>
          <p>${escapeHtml(item.purpose)}</p>
        </article>`,
    )
    .join("");
}

function renderFailureList() {
  byId("failure-list").innerHTML = state.data.failureScenarios
    .map(
      (failure) => `
        <button
          class="failure-button"
          data-failure="${escapeHtml(failure.id)}"
          aria-pressed="${failure.id === state.activeFailure}"
        >
          <strong>${escapeHtml(failure.title)}</strong>
          <span>${escapeHtml(failure.severity)}</span>
        </button>`,
    )
    .join("");

  document.querySelectorAll("[data-failure]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeFailure = button.dataset.failure;
      renderFailureList();
      renderFailureDetail();
    });
  });
}

function renderFailureDetail() {
  const failure = getFailure();
  const stages = [
    ["01 / TRIGGER", "触发", failure.trigger],
    ["02 / MECHANISM", "系统机制", failure.mechanism],
    ["03 / OBSERVABLE", "用户可见", failure.observable],
    ["04 / RESOLUTION", "收敛", failure.resolution],
  ];

  byId("failure-detail").innerHTML = `
    <header class="failure-detail-head">
      <h3>${escapeHtml(failure.title)}</h3>
      <span class="severity-pill">${escapeHtml(failure.severity)}</span>
    </header>
    <div class="failure-chain">
      ${stages
        .map(
          ([eyebrow, title, body]) => `
            <article class="failure-card">
              <span>${escapeHtml(eyebrow)}</span>
              <h4>${escapeHtml(title)}</h4>
              <p>${escapeHtml(body)}</p>
            </article>`,
        )
        .join("")}
    </div>`;
}

function renderDecisions() {
  byId("decision-strip").innerHTML = state.data.decisions
    .map((decision) => `<div class="decision">${escapeHtml(decision)}</div>`)
    .join("");
}

function renderAll() {
  renderStats();
  renderTruthRules();
  bindViewTabs();
  renderScenarioButtons();
  renderFlow();
  renderScenarioDetail();
  renderDataMatrix();
  renderLearning();
  renderFailureList();
  renderFailureDetail();
  renderDecisions();
}

async function load() {
  try {
    const response = await fetch("mock-state.json");
    if (!response.ok) {
      throw new Error(`mock-state request failed: ${response.status}`);
    }
    state.data = await response.json();
    renderAll();
  } catch (error) {
    document.body.innerHTML = `
      <main style="max-width:760px;margin:80px auto;color:#edf3fc;font-family:system-ui;padding:24px">
        <h1>Architecture data failed to load</h1>
        <p style="color:#94a3b8">请通过 README 中的 HTTP server 启动本目录，不要使用 file://。</p>
        <pre style="white-space:pre-wrap;color:#ff7882">${escapeHtml(error instanceof Error ? error.message : String(error))}</pre>
      </main>`;
  }
}

load();
