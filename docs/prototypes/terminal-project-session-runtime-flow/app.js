/* global document, fetch, history, location, window */

const app = document.querySelector("#app");

let model = null;
let activeViewId = "overview";
let activeScenarioId = "web-ime";
let selectedIssueId = "event-cursor";
let interfaceFilter = "All";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getActiveView() {
  return model.views.find((view) => view.id === activeViewId) ?? model.views[0];
}

function toneClass(tone) {
  return `tone-${escapeHtml(tone || "cyan")}`;
}

function renderHeader() {
  return `
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true">⌁</div>
        <div class="brand-copy">
          <strong>${escapeHtml(model.meta.title)}</strong>
          <span>${escapeHtml(model.meta.subtitle)}</span>
        </div>
      </div>
      <div class="baseline" aria-label="Document baseline">
        <span class="badge mono">${escapeHtml(model.meta.baseline)}</span>
        <span class="badge">${escapeHtml(model.meta.date)}</span>
        <span class="badge scope">${escapeHtml(model.meta.scope)}</span>
      </div>
    </header>
  `;
}

function renderSidebar() {
  return `
    <aside class="sidebar">
      <p class="sidebar-label">Architecture views</p>
      <nav class="view-nav" aria-label="架构视图">
        ${model.views
          .map(
            (view, index) => `
              <button
                type="button"
                class="view-button ${view.id === activeViewId ? "active" : ""}"
                data-view-id="${escapeHtml(view.id)}"
                aria-current="${view.id === activeViewId ? "page" : "false"}"
              >
                <span class="view-number">0${index + 1}</span>
                <span>${escapeHtml(view.label)}</span>
              </button>
            `,
          )
          .join("")}
      </nav>
      <p class="sidebar-note">
        红色编号连接复现结论与代码边界。P1/P2/P4 展示修复后的当前行为；P3/P5 展示保持现状的验证依据。
      </p>
    </aside>
  `;
}

function renderIntro(view) {
  const index = model.views.findIndex((candidate) => candidate.id === view.id) + 1;
  return `
    <div class="view-intro">
      <div class="view-intro-copy">
        <p class="eyebrow">${escapeHtml(view.eyebrow)}</p>
        <h1>${escapeHtml(view.title)}</h1>
        <p>${escapeHtml(view.description)}</p>
      </div>
      <span class="view-index" aria-hidden="true">0${index}</span>
    </div>
  `;
}

function renderCodeLines(lines) {
  return `
    <div class="code-list">
      ${(lines ?? [])
        .map((line) => `<div class="code-line">${escapeHtml(line)}</div>`)
        .join("")}
    </div>
  `;
}

function findDiagnosisIssue(issueId) {
  return (
    model.diagnosis.issues.find((issue) => issue.id === issueId) ??
    model.diagnosis.issues[0]
  );
}

function renderIssueMarker(issueId) {
  const issue = findDiagnosisIssue(issueId);
  if (!issue) return "";
  return `
    <button
      type="button"
      class="issue-marker ${issue.id === selectedIssueId ? "active" : ""}"
      data-issue-id="${escapeHtml(issue.id)}"
      aria-label="查看 ${escapeHtml(issue.number)} ${escapeHtml(issue.title)}"
      title="${escapeHtml(issue.title)}"
    >${escapeHtml(issue.number)}</button>
  `;
}

function renderDiagnosisIssueDetail() {
  const issue = findDiagnosisIssue(selectedIssueId);
  if (!issue) return "";
  selectedIssueId = issue.id;

  return `
    <aside class="issue-detail-panel" aria-live="polite" aria-label="问题详情">
      <div class="issue-detail-heading">
        <span class="issue-number">${escapeHtml(issue.number)}</span>
        <div>
          <div class="issue-classification">${escapeHtml(issue.classification)} · ${escapeHtml(issue.confidence)}</div>
          <h2>${escapeHtml(issue.title)}</h2>
        </div>
      </div>
      <dl class="issue-cause-chain">
        <div><dt>触发条件</dt><dd>${escapeHtml(issue.trigger)}</dd></div>
        <div><dt>代码机制</dt><dd>${escapeHtml(issue.mechanism)}</dd></div>
        <div><dt>可见症状</dt><dd>${escapeHtml(issue.symptom)}</dd></div>
        <div><dt>判断边界</dt><dd>${escapeHtml(issue.boundary)}</dd></div>
      </dl>
      <p class="mini-heading">Code evidence</p>
      ${renderCodeLines(issue.sources)}
    </aside>
  `;
}

function renderOverview() {
  return `
    <section aria-label="架构诊断主图">
      <div class="diagnosis-facts">
        ${model.diagnosis.facts
          .map(
            (fact) => `
              <article class="diagnosis-fact">
                <span>${escapeHtml(fact.label)}</span>
                <strong>${escapeHtml(fact.value)}</strong>
                <p>${escapeHtml(fact.detail)}</p>
              </article>
            `,
          )
          .join("")}
      </div>
      <div class="diagnosis-layout">
        <div class="diagnosis-map">
          ${model.diagnosis.lanes
            .map(
              (lane, laneIndex) => `
                <section class="diagnosis-lane tone-${escapeHtml(lane.tone)}">
                  <header class="diagnosis-lane-header">
                    <span>0${laneIndex + 1}</span>
                    <div><strong>${escapeHtml(lane.label)}</strong><p>${escapeHtml(lane.scope)}</p></div>
                    <code>${escapeHtml(lane.invariant)}</code>
                  </header>
                  <div class="diagnosis-flow">
                    ${lane.nodes
                      .map(
                        (node) => `
                          <article class="diagnosis-node">
                            <div class="diagnosis-node-topline">
                              <span>${escapeHtml(node.kind)}</span>
                              <div class="issue-markers">${(node.issueIds ?? []).map(renderIssueMarker).join("")}</div>
                            </div>
                            <h3>${escapeHtml(node.title)}</h3>
                            <p>${escapeHtml(node.detail)}</p>
                            <code>${escapeHtml(node.quantity)}</code>
                          </article>
                        `,
                      )
                      .join("")}
                  </div>
                </section>
              `,
            )
            .join("")}
        </div>
        <nav class="issue-index" aria-label="问题索引">
          <p class="mini-heading">Problem index</p>
          ${model.diagnosis.issues
            .map(
              (issue) => `
                <button
                  type="button"
                  class="issue-index-item ${issue.id === selectedIssueId ? "active" : ""}"
                  data-issue-id="${escapeHtml(issue.id)}"
                  aria-pressed="${issue.id === selectedIssueId}"
                >
                  <span>${escapeHtml(issue.number)}</span>
                  <div><strong>${escapeHtml(issue.title)}</strong><small>${escapeHtml(issue.classification)}</small></div>
                </button>
              `,
            )
            .join("")}
        </nav>
      </div>
      ${renderDiagnosisIssueDetail()}
    </section>
  `;
}

function renderInput() {
  const scenarios = model.input.scenarios;
  const scenario =
    scenarios.find((candidate) => candidate.id === activeScenarioId) ?? scenarios[0];
  activeScenarioId = scenario.id;
  const sample = scenario.sample ?? model.input.sample;

  return `
    <section aria-label="输入链路">
      <div class="scenario-bar" role="tablist" aria-label="输入入口">
        ${scenarios
          .map(
            (candidate) => `
              <button
                type="button"
                role="tab"
                class="scenario-button ${candidate.id === scenario.id ? "active" : ""}"
                data-scenario-id="${escapeHtml(candidate.id)}"
                aria-selected="${candidate.id === scenario.id}"
              >
                ${escapeHtml(candidate.label)}
              </button>
            `,
          )
          .join("")}
      </div>
      <div class="scenario-head">
        <div>
          <h2>${escapeHtml(scenario.label)} · “${escapeHtml(sample)}”</h2>
          <p>${escapeHtml(scenario.note)}</p>
        </div>
        <span class="transport-pill">${escapeHtml(scenario.transport)}</span>
      </div>
      <div class="sequence" style="--steps:${scenario.steps.length}">
        ${scenario.steps
          .map(
            (step, index) => `
              <article class="step">
                <div class="step-index">STEP ${String(index + 1).padStart(2, "0")}</div>
                <div class="step-actor">${escapeHtml(step.actor)}</div>
                <h3>${escapeHtml(step.title)}</h3>
                <p>${escapeHtml(step.detail)}</p>
                <div class="step-payload">${escapeHtml(step.payload)}</div>
                <div class="step-source">${escapeHtml(step.source)}</div>
              </article>
            `,
          )
          .join("")}
      </div>
      <div class="relation-strip">
        <div><strong style="color:var(--rose)">IME preedit</strong><br />composition 预编辑只留在浏览器；不产生 terminal input frame。</div>
        <div><strong style="color:var(--green)">terminal WS</strong><br />桌面 xterm 与 App raw input 只发送已提交文本或控制序列。</div>
        <div><strong style="color:var(--cyan)">input REST</strong><br />两个 composer 让 backend 解释 line / slash / prompt_replace 语义。</div>
        <div><strong style="color:var(--violet)">global events</strong><br />/ws/terminal-events 分发 bell / metadata 等工作区事件，不承载输入与 output。</div>
        <div><strong style="color:var(--amber)">runtime / output</strong><br />输入进入 pty/tmux；实时结果统一经 /ws/terminal → xterm write。</div>
      </div>
    </section>
  `;
}

function renderEvents() {
  return `
    <section aria-label="事件通道">
      <div class="channel-grid">
        ${model.events.channels
          .map(
            (channel) => `
              <article class="channel-card ${toneClass(channel.tone)}">
                <div class="endpoint">${escapeHtml(channel.endpoint)}</div>
                <h2>${escapeHtml(channel.name)}</h2>
                <dl class="channel-meta">
                  <div><dt>Scope</dt><dd>${escapeHtml(channel.scope)}</dd></div>
                  <div><dt>Retention</dt><dd>${escapeHtml(channel.retention)}</dd></div>
                  <div><dt>Producer</dt><dd>${escapeHtml(channel.producer)}</dd></div>
                  <div><dt>Consumers</dt><dd>${escapeHtml(channel.consumers)}</dd></div>
                </dl>
                <div class="message-list">
                  ${channel.messages
                    .map((message) => `<code>${escapeHtml(message)}</code>`)
                    .join("")}
                </div>
                <p class="mini-heading" style="margin-top:16px">Code evidence</p>
                ${renderCodeLines(channel.sources)}
              </article>
            `,
          )
          .join("")}
      </div>
      <div class="section-title"><h2>事件到达后的当前消费者行为</h2></div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Event</th><th>Web / Electron</th><th>App</th><th>Backend</th></tr>
          </thead>
          <tbody>
            ${model.events.reactions
              .map(
                (row) => `
                  <tr>
                    <td class="table-path">${escapeHtml(row.event)}</td>
                    <td>${escapeHtml(row.web)}</td>
                    <td>${escapeHtml(row.app)}</td>
                    <td>${escapeHtml(row.backend)}</td>
                  </tr>
                `,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderObjects() {
  return `
    <section aria-label="对象关系与数量">
      <div class="relation-map">
        ${model.objects.relations
          .map(
            (relation) => `
              <div class="relation-row">
                <div class="relation-object">${escapeHtml(relation.from)}</div>
                <div class="cardinality">${escapeHtml(relation.cardinality)}</div>
                <div class="relation-object">${escapeHtml(relation.to)}</div>
                <div class="relation-meaning">${escapeHtml(relation.meaning)}</div>
              </div>
            `,
          )
          .join("")}
      </div>

      <div class="section-title"><h2>当前挂载 / 保留数量事实</h2></div>
      <div class="count-grid">
        ${model.objects.counts
          .map(
            (item) => `
              <article class="count-card">
                <div class="count-value">${escapeHtml(item.value)}</div>
                <h3>${escapeHtml(item.metric)}</h3>
                <p>${escapeHtml(item.unit)}</p>
                <p style="margin-top:7px">${escapeHtml(item.contains)}</p>
                <div class="source">${escapeHtml(item.source)}</div>
              </article>
            `,
          )
          .join("")}
      </div>

      <div class="section-title"><h2>对象身份、所有者与生命周期</h2></div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Object</th><th>Identity</th><th>Owner</th><th>Persistence</th><th>Lifecycle end</th><th>Code</th></tr>
          </thead>
          <tbody>
            ${model.objects.identity
              .map(
                (row) => `
                  <tr>
                    <td class="table-path">${escapeHtml(row.object)}</td>
                    <td class="mono">${escapeHtml(row.key)}</td>
                    <td>${escapeHtml(row.owner)}</td>
                    <td>${escapeHtml(row.persisted)}</td>
                    <td>${escapeHtml(row.endsWhen)}</td>
                    <td class="table-source">${escapeHtml(row.source)}</td>
                  </tr>
                `,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderInterfaces() {
  const types = ["All", "REST", "WebSocket", "Internal"];
  const rows = model.interfaces.filter(
    (entry) => interfaceFilter === "All" || entry.type === interfaceFilter,
  );

  return `
    <section aria-label="接口清单">
      <div class="filter-bar" aria-label="接口类型筛选">
        ${types
          .map(
            (type) => `
              <button
                type="button"
                class="filter-button ${interfaceFilter === type ? "active" : ""}"
                data-interface-filter="${escapeHtml(type)}"
                aria-pressed="${interfaceFilter === type}"
              >
                ${escapeHtml(type)}
              </button>
            `,
          )
          .join("")}
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Type</th><th>Method</th><th>Path / channel</th><th>Purpose</th><th>Payload</th><th>Consumers</th><th>Code</th></tr>
          </thead>
          <tbody>
            ${rows
              .map(
                (row) => `
                  <tr>
                    <td>${escapeHtml(row.type)}</td>
                    <td class="mono">${escapeHtml(row.method)}</td>
                    <td class="table-path">${escapeHtml(row.path)}</td>
                    <td>${escapeHtml(row.purpose)}</td>
                    <td class="mono">${escapeHtml(row.payload)}</td>
                    <td>${escapeHtml(row.consumers)}</td>
                    <td class="table-source">${escapeHtml(row.source)}</td>
                  </tr>
                `,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderActiveContent() {
  if (activeViewId === "input") return renderInput();
  if (activeViewId === "events") return renderEvents();
  if (activeViewId === "objects") return renderObjects();
  if (activeViewId === "interfaces") return renderInterfaces();
  return renderOverview();
}

function renderFooter() {
  return `
    <footer class="footer">
      <span>真实复现诊断图 · P1/P2/P4 已修复 · P3/P5 未达到修改门槛</span>
      <code>docs/prototypes/terminal-project-session-runtime-flow/README.md</code>
    </footer>
  `;
}

function render() {
  const view = getActiveView();
  document.title = `${view.label} · ${model.meta.title}`;
  app.innerHTML = `
    ${renderHeader()}
    <div class="page-grid">
      ${renderSidebar()}
      <section class="content">
        <div class="content-inner">
          ${renderIntro(view)}
          ${renderActiveContent()}
          ${renderFooter()}
        </div>
      </section>
    </div>
  `;
}

function setActiveView(viewId, updateUrl = true) {
  if (!model.views.some((view) => view.id === viewId)) {
    return;
  }
  activeViewId = viewId;
  if (updateUrl) {
    history.replaceState(null, "", `#${viewId}`);
  }
  render();
  window.scrollTo({ top: 0, behavior: "instant" });
}

function bindInteractions() {
  app.addEventListener("click", (event) => {
    const target = event.target.closest("button");
    if (!target) return;

    if (target.dataset.viewId) {
      setActiveView(target.dataset.viewId);
      return;
    }

    if (target.dataset.issueId) {
      selectedIssueId = target.dataset.issueId;
      render();
      return;
    }

    if (target.dataset.scenarioId) {
      activeScenarioId = target.dataset.scenarioId;
      render();
      return;
    }

    if (target.dataset.interfaceFilter) {
      interfaceFilter = target.dataset.interfaceFilter;
      render();
    }
  });

  window.addEventListener("hashchange", () => {
    const viewId = location.hash.slice(1);
    if (viewId && viewId !== activeViewId) {
      setActiveView(viewId, false);
    }
  });
}

function renderLoadError(error) {
  app.innerHTML = `
    <pre class="load-error">${escapeHtml(
      [
        "无法加载架构模型 mock-state.json。",
        "",
        String(error),
        "",
        "请通过 HTTP server 打开：",
        "python3 -m http.server 6188 --directory docs/prototypes/terminal-project-session-runtime-flow",
      ].join("\n"),
    )}</pre>
  `;
}

fetch("./mock-state.json")
  .then((response) => {
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return response.json();
  })
  .then((data) => {
    model = data;
    const requestedView = location.hash.slice(1);
    if (requestedView && model.views.some((view) => view.id === requestedView)) {
      activeViewId = requestedView;
    }
    bindInteractions();
    render();
  })
  .catch(renderLoadError);
