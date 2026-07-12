/* global document, fetch */

const app = document.querySelector("#app");
let state = null;
let view = "facts";
let search = "";
let runtime = "";
let timelineType = "thread";
let timelineId = "";

function factMarkup(fact) {
  return `<article class="fact">
    <div>
      <div class="fact-title"><span class="badge">Recorded</span><strong>${fact.eventName}</strong></div>
      <p class="scope">${fact.scope}</p>
      <div class="chips"><span class="chip">${fact.runtime}</span><span class="chip">${fact.surface}</span><span class="chip">offset ${fact.offset}</span></div>
    </div>
    <time>${new Date(fact.occurredAt).toLocaleString([], { month:"short", day:"numeric", hour:"2-digit", minute:"2-digit" })}</time>
  </article>`;
}

function filteredFacts() {
  const needle = search.trim().toLowerCase();
  return state.facts.filter((fact) =>
    (!runtime || fact.runtime === runtime) &&
    (!needle || `${fact.eventName} ${fact.scope}`.toLowerCase().includes(needle))
  );
}

function factsView() {
  const facts = filteredFacts();
  return `<section class="section">
    <header class="section-head"><div><h2>Facts</h2><p>Frozen at offset ${state.facts.at(-1)?.offset ?? 0}</p></div><span>${facts.length} recorded</span></header>
    ${facts.length ? facts.map(factMarkup).join("") : '<div class="empty">No recorded facts match these filters.</div>'}
  </section>`;
}

function timelineView() {
  const facts = timelineId.trim()
    ? state.facts.filter((fact) => fact.scope.toLowerCase().includes(timelineId.trim().toLowerCase()))
    : [];
  return `<section class="section">
    <header class="section-head"><div><h2>Interaction Timeline</h2><p>Explicit IDs only; time proximity never creates a link.</p></div></header>
    <div class="timeline-form"><select id="timeline-type"><option value="interaction">Interaction</option><option value="correlation">Correlation</option><option value="thread">Thread</option><option value="run">Run</option></select><input id="timeline-id" value="${timelineId}" placeholder="Enter ${timelineType} ID" /></div>
    ${timelineId.trim() ? (facts.length ? facts.map(factMarkup).join("") : '<div class="empty">No facts are linked to this ID.</div>') : '<div class="empty">Enter an explicit ID to open a timeline.</div>'}
  </section>`;
}

function sourcesView() {
  const current = state.sources.filter((source) => source.gaps === 0).length;
  return `<section class="section"><header class="section-head"><div><h2>Sources</h2><p>${current} current of ${state.sources.length} observed sources</p></div></header>${state.sources.map((source) => `<article class="source"><div><strong>${source.name}</strong><small>${source.identity} · ${source.runtime}</small></div><span>${source.sequence}</span><span class="${source.gaps ? "gap" : ""}">${source.gaps} gaps</span><span>${source.lastSeen}</span></article>`).join("")}</section>`;
}

function policyView() {
  return `<section class="policy-grid">${state.policy.map((item) => `<article class="policy-card"><span>${item.label}</span><strong>${item.value}</strong><p>${item.detail}</p></article>`).join("")}</section>`;
}

function renderContent() {
  const content = app.querySelector(".content");
  if (!content) return;
  content.innerHTML = view === "facts" ? factsView() : view === "timeline" ? timelineView() : view === "sources" ? sourcesView() : policyView();
  const typeSelect = app.querySelector("#timeline-type");
  if (typeSelect) typeSelect.value = timelineType;
}

function render() {
  const current = state.sources.filter((source) => source.gaps === 0).length;
  app.innerHTML = `<div class="shell">
    <aside class="sidebar"><div class="brand"><div class="logo">R</div><div><strong>RUNWEAVE</strong><span>Activity Facts</span></div></div>
      <nav class="nav" aria-label="Activity views">${[["facts","Facts"],["timeline","Timeline"],["sources","Sources"],["policy","Data Policy"]].map(([id,label]) => `<button data-view="${id}" class="${view===id?"active":""}">${label}</button>`).join("")}</nav>
      <div class="source-summary">${current} of ${state.sources.length} sources current</div>
    </aside>
    <section class="main"><header class="topbar"><div><h1>Activity Facts</h1><p class="subtitle">Recorded facts and deterministic computed values</p></div><div class="filters"><input id="search" class="search" value="${search}" placeholder="Search event, Thread, project" /><select id="runtime"><option value="">All runtimes</option><option value="stable">Stable</option><option value="beta">Beta</option><option value="dev">Dev</option><option value="external">External</option></select></div></header>
      <div class="content">${view === "facts" ? factsView() : view === "timeline" ? timelineView() : view === "sources" ? sourcesView() : policyView()}</div>
    </section>
  </div>`;
  app.querySelector("#runtime").value = runtime;
  const typeSelect = app.querySelector("#timeline-type");
  if (typeSelect) typeSelect.value = timelineType;
}

app.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-view]");
  if (!button) return;
  view = button.dataset.view;
  render();
});
app.addEventListener("input", (event) => {
  if (event.target.id === "search") {
    search = event.target.value;
    renderContent();
  }
  if (event.target.id === "timeline-id") timelineId = event.target.value;
});
app.addEventListener("change", (event) => {
  if (event.target.id === "runtime") runtime = event.target.value;
  if (event.target.id === "timeline-type") timelineType = event.target.value;
  renderContent();
});

fetch("./mock-state.json").then((response) => response.json()).then((data) => { state = data; render(); });
