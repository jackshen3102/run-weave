/* global document, fetch */

const LANE_DEFINITIONS = [
  { id: "producer", title: "生产者", subtitle: "event sources" },
  { id: "app-server", title: "App Server", subtitle: "global event center" },
  { id: "transport", title: "传输", subtitle: "catchup + live" },
  { id: "backend", title: "Backend", subtitle: "ownership + effect" },
  { id: "storage", title: "持久化", subtitle: "local durable state" },
];

const NODE_COLUMNS = {
  "producer-hook": 1,
  "producer-many": 1,
  "ingress-http": 2,
  "event-store": 3,
  projection: 4,
  "startup-replay": 4,
  "ws-catchup": 5,
  "ws-stream": 3,
  "ownership-filter": 2,
  "backend-consumer": 3,
  "terminal-state": 5,
  jsonl: 3,
  "thread-state": 4,
  "cloud-sync": 5,
  "cursor-store": 2,
};

const SEQUENCE_LANES = [
  "Hook Bridge",
  "App Server",
  "Event log / projection",
  "Backend consumer",
  "TerminalState",
];

const SEQUENCE_EVENTS = [
  { lane: 0, top: 88, text: "1 · POST agent.hook → /events" },
  { lane: 1, top: 142, text: "2 · append raw event" },
  {
    lane: 2,
    top: 196,
    text: "3 · project + append derived",
    className: "is-return",
  },
  {
    lane: 1,
    top: 250,
    text: "4 · await sync mirror / cursor / manifest",
    className: "is-warning",
  },
  { lane: 1, top: 304, text: "5 · notify /events/stream" },
  { lane: 3, top: 358, text: "6 · ownership → handler" },
  {
    lane: 3,
    top: 412,
    text: "7 · processTerminalAgentHook",
    className: "is-return",
  },
];

const SEQUENCE_NOTES = [
  {
    lane: 0,
    top: 482,
    text: "同一个 Hook Bridge 在 App Server POST 之后，仍会直达 backend agent-hook / completion 接口。",
  },
  {
    lane: 1,
    top: 482,
    text: "WS handshake 先生成并发送 catchup，随后才注册 live listener。",
  },
  {
    lane: 3,
    top: 482,
    text: "isRelevant=false 时不写 cursor；相关事件处理成功后才 checkpoint。",
  },
];

const state = {
  data: null,
  activeView: "architecture",
  activeScenario: "normal",
  activeIssue: "P0",
  activeNode: null,
  contractFilter: "ALL",
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

function getIssue() {
  return state.data.issues.find((issue) => issue.id === state.activeIssue);
}

function renderStats() {
  byId("stats").innerHTML = state.data.stats
    .map(
      (stat) => `
        <div class="stat">
          <strong>${escapeHtml(stat.value)}</strong>
          <span>${escapeHtml(stat.label)}</span>
        </div>`,
    )
    .join("");
}

function renderScenarioButtons() {
  byId("scenario-strip").innerHTML = state.data.scenarios
    .map(
      (scenario) => `
        <button
          class="scenario-button"
          data-scenario="${escapeHtml(scenario.id)}"
          data-tone="${escapeHtml(scenario.tone)}"
          aria-pressed="${scenario.id === state.activeScenario}"
        >
          <strong>${escapeHtml(scenario.label)}</strong>
          <span>${escapeHtml(scenario.issueId ?? "baseline")}</span>
        </button>`,
    )
    .join("");

  document.querySelectorAll("[data-scenario]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeScenario = button.dataset.scenario;
      const scenario = getScenario();
      if (scenario.issueId) {
        state.activeIssue = scenario.issueId;
      }
      state.activeNode = null;
      renderScenarioButtons();
      renderFlow();
      renderScenarioDetail();
    });
  });
}

function renderFlow() {
  const scenario = getScenario();
  const path = new Set(scenario.path);

  byId("flow-stage").innerHTML = LANE_DEFINITIONS.map((lane) => {
    const nodes = state.data.nodes.filter((node) => node.lane === lane.id);
    return `
      <div class="lane" data-lane="${escapeHtml(lane.id)}">
        <div class="lane-label">
          <strong>${escapeHtml(lane.title)}</strong>
          <span>${escapeHtml(lane.subtitle)}</span>
        </div>
        <div class="flow-rail" aria-hidden="true"></div>
        ${nodes
          .map(
            (node) => `
              <article
                class="node ${path.has(node.id) ? "is-path" : ""} ${state.activeNode === node.id ? "is-selected" : ""}"
                data-node-card="${escapeHtml(node.id)}"
                data-column="${NODE_COLUMNS[node.id] ?? 1}"
              >
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
      </div>`;
  }).join("");

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
    <span class="scenario-badge">${escapeHtml(scenario.issueId ?? "baseline")}</span>
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

function renderIssueList() {
  byId("issue-list").innerHTML = state.data.issues
    .map(
      (issue) => `
        <button
          class="issue-button"
          data-issue="${escapeHtml(issue.id)}"
          data-severity="${escapeHtml(issue.severity)}"
          aria-pressed="${issue.id === state.activeIssue}"
        >
          <span class="issue-id">${escapeHtml(issue.id)}</span>
          <span>
            <strong>${escapeHtml(issue.title)}</strong>
            <span>${escapeHtml(issue.status)}</span>
          </span>
        </button>`,
    )
    .join("");

  document.querySelectorAll("[data-issue]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeIssue = button.dataset.issue;
      renderIssueList();
      renderIssueDetail();
    });
  });
}

function renderIssueDetail() {
  const issue = getIssue();
  byId("issue-detail").innerHTML = `
    <div class="issue-detail-head">
      <div>
        <p class="kicker">${escapeHtml(issue.id)} · ${escapeHtml(issue.severity)}</p>
        <h3>${escapeHtml(issue.title)}</h3>
      </div>
      <span class="status-pill">${escapeHtml(issue.status)}</span>
    </div>
    <div class="causal-chain">
      <section class="causal-card">
        <span class="index">01 / TRIGGER</span>
        <h4>触发条件</h4>
        <p>${escapeHtml(issue.trigger)}</p>
      </section>
      <section class="causal-card">
        <span class="index">02 / MECHANISM</span>
        <h4>代码机制</h4>
        <p>${escapeHtml(issue.mechanism)}</p>
      </section>
      <section class="causal-card">
        <span class="index">03 / CONSEQUENCE</span>
        <h4>结果</h4>
        <p>${escapeHtml(issue.consequence)}</p>
      </section>
    </div>
    <div class="evidence-box">
      <strong>EVIDENCE</strong>
      <p>${escapeHtml(issue.evidence)}</p>
    </div>
    <div class="source-list">
      ${issue.source.map((source) => `<code>${escapeHtml(source)}</code>`).join("")}
    </div>
  `;
}

function renderSequence() {
  byId("sequence-grid").innerHTML = SEQUENCE_LANES.map(
    (lane, index) => `
      <div class="sequence-lane" data-sequence-lane="${index}">
        <div class="sequence-lane-head">${escapeHtml(lane)}</div>
        <div class="sequence-lifeline" aria-hidden="true"></div>
      </div>`,
  ).join("");

  SEQUENCE_EVENTS.forEach((event) => {
    const lane = document.querySelector(`[data-sequence-lane="${event.lane}"]`);
    const element = document.createElement("div");
    element.className = `sequence-event ${event.className ?? ""}`;
    element.style.top = `${event.top}px`;
    element.textContent = event.text;
    lane.append(element);
  });

  SEQUENCE_NOTES.forEach((note) => {
    const lane = document.querySelector(`[data-sequence-lane="${note.lane}"]`);
    const element = document.createElement("div");
    element.className = "sequence-note";
    element.style.top = `${note.top}px`;
    element.textContent = note.text;
    lane.append(element);
  });
}

function renderContractTools() {
  const filters = ["ALL", "POST", "GET", "WS"];
  byId("contract-tools").innerHTML = filters
    .map(
      (filter) => `
        <button
          class="filter-button"
          data-contract-filter="${filter}"
          aria-pressed="${filter === state.contractFilter}"
        >${filter}</button>`,
    )
    .join("");

  document.querySelectorAll("[data-contract-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.contractFilter = button.dataset.contractFilter;
      renderContractTools();
      renderContractRows();
    });
  });
}

function renderContractRows() {
  const contracts = state.data.contracts.filter(
    (contract) =>
      state.contractFilter === "ALL" ||
      contract.method === state.contractFilter,
  );
  byId("contract-rows").innerHTML = contracts
    .map(
      (contract) => `
        <tr>
          <td>${escapeHtml(contract.group)}</td>
          <td><span class="method" data-method="${escapeHtml(contract.method)}">${escapeHtml(contract.method)}</span></td>
          <td><code>${escapeHtml(contract.path)}</code></td>
          <td>${escapeHtml(contract.direction)}</td>
          <td>${escapeHtml(contract.payload)}</td>
          <td>${escapeHtml(contract.effect)}</td>
        </tr>`,
    )
    .join("");
}

function renderEventKinds() {
  byId("event-kind-rows").innerHTML = state.data.eventKinds
    .map(
      (event) => `
        <tr>
          <td><code>${escapeHtml(event.kind)}</code></td>
          <td>${escapeHtml(event.producer)}</td>
          <td>${escapeHtml(event.projection)}</td>
          <td>${escapeHtml(event.backendEffect)}</td>
        </tr>`,
    )
    .join("");
}

function bindViewTabs() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeView = button.dataset.view;
      document.querySelectorAll("[data-view]").forEach((tab) => {
        tab.setAttribute(
          "aria-selected",
          String(tab.dataset.view === state.activeView),
        );
      });
      document.querySelectorAll("[data-view-panel]").forEach((panel) => {
        panel.classList.toggle(
          "is-active",
          panel.dataset.viewPanel === state.activeView,
        );
      });
    });
  });
}

function render() {
  document.title = `${state.data.meta.title} · Runweave`;
  byId("page-subtitle").textContent = state.data.meta.subtitle;
  renderStats();
  renderScenarioButtons();
  renderFlow();
  renderScenarioDetail();
  renderIssueList();
  renderIssueDetail();
  renderSequence();
  renderContractTools();
  renderContractRows();
  renderEventKinds();
  bindViewTabs();
}

async function initialize() {
  try {
    const response = await fetch("./mock-state.json");
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    state.data = await response.json();
    render();
  } catch (error) {
    document.querySelector("main").innerHTML = `
      <div class="error-state">
        无法加载原型数据：${escapeHtml(error instanceof Error ? error.message : String(error))}<br />
        请通过本地 HTTP server 打开该目录。
      </div>`;
  }
}

initialize();
