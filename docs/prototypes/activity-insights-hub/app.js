/* global document, fetch, window */

const app = document.querySelector("#app");

const viewCopy = {
  overview: {
    title: "Activity & Insights",
    subtitle: "Traceable facts first, reviewed learnings second",
  },
  facts: {
    title: "Facts",
    subtitle: "Recorded events with their original source and context",
  },
  learnings: {
    title: "Learnings",
    subtitle: "Conclusions remain provisional until their evidence is reviewed",
  },
  sources: {
    title: "Sources",
    subtitle: "Coverage across isolated runtimes and registered producers",
  },
};

const state = {
  data: null,
  activeView: "overview",
  channel: "all",
  period: "7d",
  query: "",
  selected: null,
  toast: "",
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function matchesFilters(item) {
  const matchesChannel =
    state.channel === "all" || item.channel?.includes(state.channel);
  const query = state.query.trim().toLowerCase();
  if (!query) return matchesChannel;

  const searchable = [
    item.title,
    item.description,
    item.kind,
    item.eventId,
    item.project,
    item.source,
    item.threadId,
    item.result,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return matchesChannel && searchable.includes(query);
}

function statusBadge(item) {
  if (item.type === "fact") {
    if (item.status === "delayed") {
      return '<span class="badge medium">Delayed</span>';
    }
    if (item.status === "completed") {
      return '<span class="badge good">Completed</span>';
    }
    return '<span class="badge info">Fact</span>';
  }
  if (item.status === "saved") {
    return '<span class="badge good">Saved</span>';
  }
  return '<span class="badge info">Candidate</span>';
}

function renderShell() {
  const copy = viewCopy[state.activeView];
  const candidateLearnings = state.data.learnings.filter(
    (item) => item.status === "candidate",
  ).length;

  app.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-mark">R</div>
          <div><strong>Runweave</strong><span>Personal Activity Hub</span></div>
        </div>
        <div class="nav-label">Intelligence</div>
        <nav class="nav-list" aria-label="Activity views">
          ${state.data.navigation
            .map(
              (item) => `
                <button class="nav-button ${state.activeView === item.id ? "active" : ""}" data-view="${item.id}">
                  <span class="nav-icon">${item.icon}</span>
                  <span>${escapeHtml(item.label)}</span>
                  ${item.id === "facts" ? `<span class="nav-count">${state.data.facts.length}</span>` : ""}
                  ${item.id === "learnings" ? `<span class="nav-count">${candidateLearnings}</span>` : ""}
                </button>
              `,
            )
            .join("")}
        </nav>
        <div class="sidebar-footer">
          <div class="source-health"><span class="health-dot"></span><span>3 of 4 sources current</span></div>
          <p>Stable, Beta, Dev, CLI, and Hook observations retain their original source identity.</p>
        </div>
      </aside>
      <main class="main">
        <header class="topbar">
          <div class="page-heading"><h1>${copy.title}</h1><p>${copy.subtitle}</p></div>
          <div class="toolbar">
            <div class="search-wrap"><input class="search" data-search type="search" value="${escapeHtml(state.query)}" placeholder="Search event, Thread, project…" /></div>
            <select class="control" data-period aria-label="Time period">
              <option value="24h" ${state.period === "24h" ? "selected" : ""}>Last 24 hours</option>
              <option value="7d" ${state.period === "7d" ? "selected" : ""}>Last 7 days</option>
              <option value="30d" ${state.period === "30d" ? "selected" : ""}>Last 30 days</option>
            </select>
            <select class="control" data-channel aria-label="Runtime channel">
              <option value="all" ${state.channel === "all" ? "selected" : ""}>All runtimes</option>
              <option value="stable" ${state.channel === "stable" ? "selected" : ""}>Stable</option>
              <option value="beta" ${state.channel === "beta" ? "selected" : ""}>Beta</option>
              <option value="dev" ${state.channel === "dev" ? "selected" : ""}>Dev</option>
            </select>
          </div>
        </header>
        <section class="content">${renderActiveView()}</section>
      </main>
    </div>
    <div class="drawer-scrim ${state.selected ? "open" : ""}" data-close-drawer></div>
    <aside class="detail-drawer ${state.selected ? "open" : ""}" aria-hidden="${state.selected ? "false" : "true"}">
      ${state.selected ? renderDrawer(state.selected) : ""}
    </aside>
    <div class="toast ${state.toast ? "visible" : ""}">${escapeHtml(state.toast)}</div>
  `;
}

function renderActiveView() {
  if (state.activeView === "facts") return renderFactsView();
  if (state.activeView === "learnings") return renderLearningsView();
  if (state.activeView === "sources") return renderSourcesView();
  return renderOverview();
}

function renderOverview() {
  const facts = state.data.facts.filter(matchesFilters).slice(0, 5);
  const learnings = state.data.learnings
    .filter(matchesFilters)
    .filter((item) => item.status === "candidate")
    .slice(0, 3);

  return `
    <div class="view-heading">
      <div><h2>Facts first</h2><p>Every displayed conclusion links back to recorded events.</p></div>
      <button class="subtle-button" data-view="sources">Check coverage</button>
    </div>
    <div class="metrics">
      ${state.data.metrics
        .map(
          (metric) => `
            <article class="metric-card"><span class="label">${escapeHtml(metric.label)}</span><strong>${escapeHtml(metric.value)}</strong><span class="change ${metric.tone}">${escapeHtml(metric.change)}</span></article>
          `,
        )
        .join("")}
    </div>
    <div class="overview-grid">
      <div class="column">
        <section class="panel">
          <header class="panel-header"><h3>Recent facts</h3><button class="subtle-button" data-view="facts">View all</button></header>
          <div class="card-list">${facts.length ? facts.map(renderFactCard).join("") : renderEmpty("No facts match the current filters.")}</div>
        </section>
      </div>
      <div class="column">
        <section class="panel">
          <header class="panel-header"><h3>Learning inbox</h3><span>Review before saving</span></header>
          <div class="card-list">${learnings.length ? learnings.map(renderLearningRow).join("") : renderEmpty("No candidate learnings match the current filters.")}</div>
        </section>
        <section class="panel">
          <header class="panel-header"><h3>Facts recorded</h3><span>Last 7 days</span></header>
          <div style="padding:18px 15px 16px">
            <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:8px;height:112px;align-items:end">
              ${[44, 62, 51, 75, 68, 92, 79]
                .map(
                  (height, index) => `<div title="Day ${index + 1}: ${[412, 586, 478, 703, 641, 864, 739][index]} facts" style="height:${height}%;border-radius:5px 5px 2px 2px;background:${index === 5 ? "var(--accent)" : "rgba(116,212,181,.25)"}"></div>`,
                )
                .join("")}
            </div>
            <div style="display:flex;justify-content:space-between;margin-top:10px;color:var(--dim);font-size:9px"><span>Jul 5</span><span>Jul 11</span></div>
          </div>
        </section>
      </div>
    </div>
  `;
}

function renderFactCard(item) {
  return `
    <button class="item-card" data-open="${item.id}">
      <div class="item-top">${statusBadge(item)}<span class="item-title">${escapeHtml(item.title)}</span><span class="item-meta">${escapeHtml(item.createdAt)}</span></div>
      <p class="item-description">${escapeHtml(item.description)}</p>
      <div class="item-footer"><span class="badge">${escapeHtml(item.kind)}</span><span class="badge">${escapeHtml(item.project)}</span><span class="badge">${escapeHtml(item.channel[0])}</span><span class="badge">${escapeHtml(item.source)}</span></div>
    </button>`;
}

function renderLearningRow(item) {
  return `
    <button class="item-card" data-open="${item.id}">
      <div class="item-top">${statusBadge(item)}<span class="item-title">${escapeHtml(item.title)}</span></div>
      <p class="item-description">${escapeHtml(item.description)}</p>
      <div class="item-footer"><span class="badge">${item.factRefs.length} linked facts</span><span class="badge">${escapeHtml(item.observed)}</span></div>
    </button>`;
}

function renderFactsView() {
  const facts = state.data.facts.filter(matchesFilters);
  return `
    <div class="view-heading"><div><h2>Recorded facts</h2><p>Original event kind, source, context, and timestamp.</p></div><span class="badge info">${facts.length} visible</span></div>
    <div class="page-list">
      <div class="list-head"><span>Fact</span><span>Kind</span><span>Runtime</span><span>Project</span><span>Source</span><span>Time</span></div>
      ${facts.length ? facts
        .map(
          (item) => `
            <button class="list-row" data-open="${item.id}">
              <div class="row-title"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.description)}</span></div>
              <div class="row-cell"><span class="badge info">${escapeHtml(item.kind)}</span></div>
              <div class="row-cell"><span class="badge">${escapeHtml(item.channel[0])}</span></div>
              <div class="row-cell">${escapeHtml(item.project)}</div>
              <div class="row-cell">${escapeHtml(item.source)}</div>
              <div class="row-cell">${escapeHtml(item.createdAt)}</div>
            </button>
          `,
        )
        .join("") : renderEmpty("No facts match the current filters.")}
    </div>`;
}

function renderLearningsView() {
  const learnings = state.data.learnings.filter(matchesFilters);
  return `
    <div class="view-heading"><div><h2>Learning inbox</h2><p>Generated conclusions stay provisional until their linked facts are reviewed.</p></div><span class="badge info">${learnings.filter((item) => item.status === "candidate").length} candidates</span></div>
    <div class="learning-grid">
      ${learnings.length ? learnings
        .map(
          (item) => `
            <button class="learning-card" data-open="${item.id}">
              ${statusBadge(item)}
              <h3>${escapeHtml(item.title)}</h3>
              <p>${escapeHtml(item.description)}</p>
              <footer><span>${escapeHtml(item.observed)}</span><span>${item.factRefs.length} linked facts</span></footer>
            </button>
          `,
        )
        .join("") : renderEmpty("No learnings match the current filters.")}
    </div>`;
}

function renderSourcesView() {
  const sources =
    state.channel === "all"
      ? state.data.sources
      : state.data.sources.filter((item) => item.id === state.channel);
  return `
    <div class="view-heading"><div><h2>Source coverage</h2><p>Missing or delayed facts remain visible as coverage gaps.</p></div><span class="badge medium">1 delayed</span></div>
    <div class="source-grid">
      ${sources
        .map(
          (source) => `
            <article class="source-card">
              <header><span class="source-status ${source.status}"></span><div><h3>${escapeHtml(source.name)}</h3><span style="color:var(--dim);font-size:9px">${escapeHtml(source.kind)}</span></div><span>${escapeHtml(source.lastSeen)}</span></header>
              <div class="source-stats"><div><span>FACTS</span><strong>${escapeHtml(source.events)}</strong></div><div><span>CURSOR</span><strong>${escapeHtml(source.cursor)}</strong></div><div><span>COVERAGE</span><strong>${escapeHtml(source.coverage)}</strong></div></div>
            </article>
          `,
        )
        .join("")}
    </div>`;
}

function renderDrawer(item) {
  const isFact = item.type === "fact";
  const relations = isFact
    ? [
        ["Event ID", item.eventId],
        ["Kind", item.kind],
        ["Project", item.project],
        ["Runtime", item.channel.join(" · ")],
        ["Source", item.source],
        ["Thread ID", item.threadId ?? "Not linked"],
      ]
    : [
        ["Learning ID", item.id],
        ["Runtime", item.channel.join(" · ")],
        ["Source", item.source],
        ["Project", item.project],
        ["Thread ID", item.threadId ?? "Not linked"],
        ["Linked facts", `${item.factRefs.length} records`],
      ];

  return `
    <header class="drawer-header"><div><span>${isFact ? "Recorded fact" : "Learning"}</span><h2>${escapeHtml(item.title)}</h2></div><button class="icon-button" data-close-drawer aria-label="Close">×</button></header>
    <div class="drawer-body">
      <div class="item-footer" style="margin-bottom:12px">${statusBadge(item)}<span class="badge">${escapeHtml(isFact ? item.createdAt : item.observed)}</span><span class="badge info">${isFact ? item.evidence.length : item.factRefs.length} evidence</span></div>
      <p class="drawer-summary">${escapeHtml(item.description)}</p>
      ${item.result ? `<section class="drawer-section"><h3>Recorded result</h3><p class="drawer-summary">${escapeHtml(item.result)}</p></section>` : ""}
      <section class="drawer-section"><h3>Related context</h3><div class="relation-grid">${relations.map(([label, value]) => `<div class="relation"><span>${label}</span><strong title="${escapeHtml(value)}">${escapeHtml(value)}</strong></div>`).join("")}</div></section>
      <section class="drawer-section"><h3>${isFact ? "Recorded evidence" : "Linked facts"}</h3><div class="timeline">${item.evidence.map((evidence) => `<article class="timeline-item"><time>${escapeHtml(evidence.time)}</time><strong>${escapeHtml(evidence.title)}</strong><p>${escapeHtml(evidence.detail)}</p></article>`).join("")}</div></section>
    </div>
    <footer class="drawer-footer">
      ${item.threadId ? '<button class="subtle-button" data-action="thread">Open Thread</button>' : ""}
      ${!isFact && item.status === "candidate" ? '<button class="primary-button" data-action="learning">Save learning</button>' : ""}
    </footer>`;
}

function renderEmpty(message) {
  return `<div class="empty">${escapeHtml(message)}</div>`;
}

function findItem(id) {
  return [...state.data.facts, ...state.data.learnings].find(
    (item) => item.id === id,
  ) ?? null;
}

function showToast(message) {
  state.toast = message;
  renderShell();
  window.setTimeout(() => {
    state.toast = "";
    renderShell();
  }, 2200);
}

app.addEventListener("click", (event) => {
  const target = event.target.closest("button, [data-close-drawer]");
  if (!target) return;

  if (target.dataset.view) {
    state.activeView = target.dataset.view;
    state.selected = null;
    renderShell();
    return;
  }
  if (target.dataset.open) {
    state.selected = findItem(target.dataset.open);
    renderShell();
    return;
  }
  if (target.hasAttribute("data-close-drawer")) {
    state.selected = null;
    renderShell();
    return;
  }
  if (target.dataset.action === "thread") {
    showToast(`Opening Thread ${state.selected.threadId.slice(0, 12)}…`);
    return;
  }
  if (target.dataset.action === "learning") {
    state.selected.status = "saved";
    showToast("Learning saved with its fact references");
  }
});

app.addEventListener("change", (event) => {
  if (event.target.matches("[data-channel]")) {
    state.channel = event.target.value;
    state.selected = null;
    renderShell();
  }
  if (event.target.matches("[data-period]")) {
    state.period = event.target.value;
    showToast(
      `Time window changed to ${event.target.options[event.target.selectedIndex].text}`,
    );
  }
});

app.addEventListener("input", (event) => {
  if (!event.target.matches("[data-search]")) return;
  const selectionStart = event.target.selectionStart;
  state.query = event.target.value;
  renderShell();
  const search = app.querySelector("[data-search]");
  search.focus();
  search.setSelectionRange(selectionStart, selectionStart);
});

fetch("./mock-state.json")
  .then((response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  })
  .then((data) => {
    state.data = data;
    renderShell();
  })
  .catch((error) => {
    app.innerHTML = `<pre style="padding:24px;color:#f28b82">Unable to load mock-state.json\n\n${escapeHtml(error)}\n\nRun: python3 -m http.server 6188 --directory docs/prototypes/activity-insights-hub</pre>`;
  });
