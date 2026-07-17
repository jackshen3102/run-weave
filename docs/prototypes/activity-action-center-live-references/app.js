/* global HTMLButtonElement, HTMLElement, HTMLInputElement, HTMLTextAreaElement, URLSearchParams, document, fetch, navigator, window */

const app = document.querySelector("#app");
const modalRoot = document.querySelector("#modal-root");
const toastRegion = document.querySelector("#toast-region");

const ICON_PATHS = {
  arrowLeft: '<path d="m15 18-6-6 6-6"/><path d="M9 12h10"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  chevronDown: '<path d="m7 10 5 5 5-5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  close: '<path d="m7 7 10 10M17 7 7 17"/>',
  copy: '<rect x="8" y="8" width="10" height="10" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  database: '<ellipse cx="12" cy="5" rx="7" ry="3"/><path d="M5 5v6c0 1.7 3.1 3 7 3s7-1.3 7-3V5"/><path d="M5 11v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
  file: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v5h5"/>',
  inbox: '<path d="M4 5h16v13H4z"/><path d="m4 13 4-4h8l4 4"/><path d="M8 13h8"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.2"/><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.2-1.2"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/>',
  shield: '<path d="M12 3 5 6v5c0 4.8 2.7 8 7 10 4.3-2 7-5.2 7-10V6z"/><path d="m9 12 2 2 4-5"/>',
  source: '<path d="M8 4v5M16 4v5M5 9h14v4a7 7 0 0 1-14 0z"/>',
  terminal: '<path d="m5 7 4 4-4 4M11 16h7"/><rect x="3" y="4" width="18" height="16" rx="2"/>',
  users: '<path d="M16 20v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="9.5" cy="7" r="4"/><path d="M18 8a3 3 0 0 1 0 6M21 20v-2a4 4 0 0 0-3-3.87"/>',
};

const state = {
  data: null,
  filterId: "attention",
  activeItemId: null,
  selectedReferenceId: null,
  search: "",
  dialog: null,
  resumeNote: "",
  selectedReferenceIds: [],
  pickerSourceId: "recent",
  pickerSearch: "",
  pendingPickerReferenceIds: [],
  findingReason: "",
};

function icon(name, className = "icon") {
  return `<span class="${className}" aria-hidden="true"><svg viewBox="0 0 24 24">${ICON_PATHS[name] ?? ICON_PATHS.file}</svg></span>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function uniqueReferences(items) {
  const byId = new Map();
  for (const item of items) {
    for (const reference of item.references ?? []) {
      if (!byId.has(reference.id)) byId.set(reference.id, reference);
    }
  }
  return [...byId.values()];
}

function allReferences() {
  return uniqueReferences(state.data.attentionItems);
}

function referenceById(referenceId) {
  return allReferences().find((reference) => reference.id === referenceId) ?? null;
}

function itemById(itemId) {
  return state.data.attentionItems.find((item) => item.id === itemId) ?? null;
}

function matchesFilter(item) {
  if (state.filterId === "all") return true;
  return item.status === state.filterId;
}

function visibleItems() {
  const query = state.search.trim().toLowerCase();
  return state.data.attentionItems.filter((item) => {
    if (!matchesFilter(item)) return false;
    if (!query) return true;
    return [
      item.title,
      item.summary,
      item.kind,
      item.projectLabel,
      item.runId,
      item.terminalLabel,
      item.acceptance?.sourceCaseId,
    ]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query));
  });
}

function ensureActiveSelection() {
  const items = visibleItems();
  if (!items.some((item) => item.id === state.activeItemId)) {
    state.activeItemId = items[0]?.id ?? null;
  }
  const item = itemById(state.activeItemId);
  if (!item?.references?.some((ref) => ref.id === state.selectedReferenceId)) {
    state.selectedReferenceId = item?.references?.[0]?.id ?? null;
  }
}

function statusCount(filterId) {
  if (filterId === "all") return state.data.attentionItems.length;
  return state.data.attentionItems.filter((item) => item.status === filterId).length;
}

function navItemTemplate(item) {
  const active = item.id === "attention";
  return `
    <button
      type="button"
      class="nav-item ${active ? "active" : ""}"
      aria-current="${active ? "page" : "false"}"
      data-nav-id="${escapeHtml(item.id)}"
    >
      ${icon(item.icon, "nav-icon")}
      <span class="nav-label">${escapeHtml(item.label)}</span>
      ${item.id === "attention" ? `<span class="nav-badge">${statusCount("attention")}</span>` : ""}
    </button>
  `;
}

function renderSidebar() {
  return `
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">R</div>
        <div>
          <p class="brand-name">RUNWEAVE</p>
          <p class="brand-subtitle">Activity</p>
        </div>
      </div>
      <nav class="navigation" aria-label="Activity views">
        ${state.data.navigation
          .map(
            (group) => `
              <section class="nav-group">
                <p class="nav-group-label">${escapeHtml(group.group)}</p>
                ${group.items.map(navItemTemplate).join("")}
              </section>
            `,
          )
          .join("")}
      </nav>
      <div class="sidebar-health">
        <div class="sidebar-health-row">
          <span class="health-dot"></span>
          <span>${state.data.workspace.currentSources} of ${state.data.workspace.sourceCount} sources current</span>
        </div>
      </div>
    </aside>
  `;
}

function renderPageHeader() {
  return `
    <header class="page-header">
      <div class="page-title-row">
        <button class="back-button" type="button" aria-label="Back home">
          ${icon("arrowLeft")}
        </button>
        <div class="page-copy">
          <h1>${escapeHtml(state.data.workspace.title)}</h1>
          <p>${escapeHtml(state.data.workspace.subtitle)}</p>
        </div>
      </div>
      <div class="header-tools">
        <label class="header-search">
          ${icon("search")}
          <span class="sr-only">Search attention item, terminal, Run</span>
          <input
            type="search"
            placeholder="Search event, Thread, project"
            value="${escapeHtml(state.search)}"
            data-input="global-search"
          />
        </label>
        <button class="runtime-button" type="button">
          ${escapeHtml(state.data.workspace.runtimeFilter)}
          ${icon("chevronDown")}
        </button>
      </div>
    </header>
  `;
}

function priorityClass(item) {
  if (item.priority === "blocking") return "blocking";
  if (item.priority === "review") return "review";
  return "normal";
}

function queueItemTemplate(item) {
  return `
    <button
      type="button"
      class="queue-item ${item.id === state.activeItemId ? "active" : ""}"
      data-item-id="${escapeHtml(item.id)}"
      aria-current="${item.id === state.activeItemId ? "true" : "false"}"
    >
      <div class="queue-item-top">
        <span class="kind-label">${escapeHtml(item.kind)}</span>
        <time>${escapeHtml(item.updatedAt)}</time>
      </div>
      <h3>${escapeHtml(item.title)}</h3>
      <p>${escapeHtml(item.summary)}</p>
      <div class="queue-item-meta">
        <span class="status-pill ${priorityClass(item)}">${escapeHtml(item.priorityLabel)}</span>
        <span class="queue-project">${escapeHtml(item.projectLabel)}</span>
      </div>
    </button>
  `;
}

function renderQueuePanel(items) {
  return `
    <section class="queue-panel" aria-label="Attention queue">
      <div class="queue-header">
        <div class="queue-title-row">
          <h2>Needs Attention</h2>
          <span class="queue-count">${statusCount("attention")} open</span>
        </div>
        <p>Structured gates that require a decision.</p>
        <label class="queue-search">
          ${icon("search")}
          <span class="sr-only">Search queue</span>
          <input
            type="search"
            placeholder="Search Run, terminal, case"
            value="${escapeHtml(state.search)}"
            data-input="queue-search"
          />
        </label>
        <div class="filter-tabs" aria-label="Attention filters">
          ${state.data.filters
            .map(
              (filter) => `
                <button
                  type="button"
                  class="filter-tab ${filter.id === state.filterId ? "active" : ""}"
                  data-filter-id="${escapeHtml(filter.id)}"
                >
                  ${escapeHtml(filter.label)} ${statusCount(filter.id)}
                </button>
              `,
            )
            .join("")}
        </div>
      </div>
      <div class="queue-list">
        ${
          items.length
            ? items.map(queueItemTemplate).join("")
            : `
              <div class="empty-state">
                <div>
                  <strong>No matching items</strong>
                  <p>Change the filter or search to inspect another recorded gate.</p>
                </div>
              </div>
            `
        }
      </div>
    </section>
  `;
}

function actionButtonTemplate(action, item) {
  const danger = action.id === "reject";
  return `
    <button
      type="button"
      class="button ${action.variant === "primary" ? "primary" : ""} ${danger ? "danger" : ""}"
      data-item-action="${escapeHtml(action.id)}"
      data-item-id="${escapeHtml(item.id)}"
    >
      ${action.id === "focus" ? icon("terminal") : ""}
      ${action.id === "resume" ? icon("pause") : ""}
      ${escapeHtml(action.label)}
    </button>
  `;
}

function renderBreakerBody(item) {
  return `
    <section class="section-card">
      <div class="section-header">
        <div>
          <h3>Loop state</h3>
          <p>Backend-owned progress and circuit-breaker facts</p>
        </div>
        <span class="section-meta">Round ${item.loop.round}</span>
      </div>
      <div class="section-body">
        <div class="loop-grid">
          <div class="metric">
            <span>Round</span>
            <strong>${item.loop.round}</strong>
          </div>
          <div class="metric danger">
            <span>No progress</span>
            <strong>${item.loop.noProgressCount} / ${item.loop.maxNoProgress}</strong>
          </div>
          <div class="metric">
            <span>Acceptance</span>
            <strong>${item.loop.bestPassCount} / ${item.loop.acceptanceCount}</strong>
          </div>
          <div class="metric">
            <span>Last worker</span>
            <strong>${escapeHtml(item.loop.lastWorkerRole)}</strong>
          </div>
        </div>
      </div>
    </section>
    <section class="section-card">
      <div class="section-header">
        <div>
          <h3>Blocking acceptance case</h3>
          <p>Traceable source retained from the Agent Team run</p>
        </div>
        <span class="status-pill blocking">Fail</span>
      </div>
      <div class="section-body">
        <article class="case-card">
          <div class="case-heading">
            <strong>${escapeHtml(item.acceptance.title)}</strong>
            <code>${escapeHtml(item.acceptance.sourceCaseId)}</code>
          </div>
          <p>${escapeHtml(item.acceptance.resultSummary)}</p>
          <span class="case-path">${escapeHtml(item.acceptance.sourceFilePath)}</span>
        </article>
      </div>
    </section>
  `;
}

function renderSplitBody(item) {
  return `
    <section class="section-card">
      <div class="section-header">
        <div>
          <h3>Split proposal</h3>
          <p>Generated by the main Agent, pending the existing split gate</p>
        </div>
        <span class="meta-chip">source=${escapeHtml(item.proposal.source)}</span>
      </div>
      <div class="section-body">
        <article class="proposal-summary">
          <strong>${escapeHtml(item.proposal.summary)}</strong>
          <p>
            ${escapeHtml(item.proposal.acceptanceSource)} ·
            ${escapeHtml(item.proposal.testCaseFilePath)}
          </p>
          <div class="workers">
            ${item.proposal.workers
              .map(
                (worker) => `
                  <div class="worker-row">
                    <span class="worker-role">${escapeHtml(worker.role)}</span>
                    <span class="worker-intent">${escapeHtml(worker.intent)}</span>
                  </div>
                `,
              )
              .join("")}
          </div>
        </article>
      </div>
    </section>
  `;
}

function renderFindingBody(item) {
  return `
    <section class="section-card">
      <div class="section-header">
        <div>
          <h3>Review finding</h3>
          <p>Observed fact remains immutable after disposition</p>
        </div>
        <span class="status-pill blocking">${escapeHtml(item.finding.severity)}</span>
      </div>
      <div class="section-body">
        <article class="finding-card">
          <strong>${escapeHtml(item.finding.invariantKey)}</strong>
          <p><b>Expected</b> · ${escapeHtml(item.finding.expected)}</p>
          <p><b>Actual</b> · ${escapeHtml(item.finding.actual)}</p>
          <p><b>Mapped case</b> · ${escapeHtml(item.finding.caseImpacts.join(", "))}</p>
        </article>
      </div>
    </section>
  `;
}

function renderHistory(item) {
  return `
    <section class="section-card">
      <div class="section-header">
        <h3>Recorded activity</h3>
        <span class="section-meta">Current projection</span>
      </div>
      <div class="history-list">
        ${(item.history ?? [])
          .map(
            (entry) => `
              <div class="history-row">
                <span class="history-marker ${escapeHtml(entry.tone)}"></span>
                <div class="history-copy">
                  <strong>${escapeHtml(entry.label)}</strong>
                  <span>${escapeHtml(entry.meta)}</span>
                </div>
              </div>
            `,
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderDetailPanel(item) {
  if (!item) {
    return `
      <section class="detail-panel">
        <div class="empty-state"><div><strong>Select an item</strong><p>Choose an attention item to inspect its current facts and actions.</p></div></div>
      </section>
    `;
  }
  const specialBody = item.loop
    ? renderBreakerBody(item)
    : item.proposal
      ? renderSplitBody(item)
      : item.finding
        ? renderFindingBody(item)
        : "";
  return `
    <section class="detail-panel" aria-label="Attention item details">
      <header class="detail-header">
        <div class="detail-header-copy">
          <p class="eyebrow">${escapeHtml(item.kind)}</p>
          <h2>${escapeHtml(item.runId ?? item.terminalSessionId)}</h2>
        </div>
        <div class="detail-header-actions">
          ${(item.actions ?? []).map((action) => actionButtonTemplate(action, item)).join("")}
        </div>
      </header>
      <div class="detail-content">
        <article class="hero-card ${priorityClass(item)}">
          <div class="hero-main">
            <div class="hero-topline">
              <span class="status-pill ${priorityClass(item)}">${escapeHtml(item.priorityLabel)}</span>
              <span class="meta-chip">${escapeHtml(item.projectLabel)}</span>
              <span class="meta-chip">${escapeHtml(item.updatedAt)}</span>
            </div>
            <h1>${escapeHtml(item.title)}</h1>
            <p class="hero-summary">${escapeHtml(item.summary)}</p>
            <p class="hero-reason">${escapeHtml(item.reason)}</p>
          </div>
          <div class="hero-meta-grid">
            <div class="hero-meta-cell"><span>Run</span><strong>${escapeHtml(item.runId ?? "—")}</strong></div>
            <div class="hero-meta-cell"><span>Terminal</span><strong>${escapeHtml(item.terminalLabel ?? item.terminalSessionId)}</strong></div>
            <div class="hero-meta-cell"><span>Target</span><strong>${escapeHtml(item.panelLabel ?? "Recorded event")}</strong></div>
          </div>
        </article>
        ${specialBody}
        ${renderHistory(item)}
      </div>
    </section>
  `;
}

function referenceIconName(kind) {
  if (kind === "terminal") return "terminal";
  if (kind === "run") return "users";
  if (kind === "acceptance") return "check";
  return "file";
}

function referenceRowTemplate(reference) {
  return `
    <article class="reference-row ${reference.id === state.selectedReferenceId ? "active" : ""}" data-reference-row="${escapeHtml(reference.id)}">
      <div class="reference-main">
        <span class="reference-icon">${icon(referenceIconName(reference.kind))}</span>
        <div class="reference-copy">
          <strong>${escapeHtml(reference.label)}</strong>
          <p>${escapeHtml(reference.description)}</p>
        </div>
      </div>
      <div class="reference-row-actions">
        <button type="button" class="mini-icon-button" aria-label="Copy ${escapeHtml(reference.label)} reference" data-copy-reference="${escapeHtml(reference.id)}">
          ${icon("copy")}
        </button>
      </div>
    </article>
  `;
}

function renderReferenceDetail(reference) {
  if (!reference) return "";
  return `
    <section class="reference-detail" aria-label="Selected reference">
      <div class="reference-detail-top">
        <span class="reference-kind">${escapeHtml(reference.kind)}</span>
        <span class="live-badge">Live</span>
      </div>
      <code>${escapeHtml(reference.uri)}</code>
      <dl class="reference-definition">
        <dt>Scope</dt><dd>${escapeHtml(reference.scope)}</dd>
        <dt>Updated</dt><dd>${escapeHtml(reference.updatedAt)}</dd>
        <dt>Resolution</dt><dd>On demand</dd>
        <dt>Authority</dt><dd>Read-only context</dd>
      </dl>
      <button type="button" class="button small" data-copy-reference="${escapeHtml(reference.id)}" style="margin-top:12px">
        ${icon("copy")} Copy reference
      </button>
    </section>
  `;
}

function renderContextPanel(item) {
  const references = item?.references ?? [];
  const selectedReference =
    references.find((reference) => reference.id === state.selectedReferenceId) ??
    references[0] ??
    null;
  return `
    <aside class="context-panel" aria-label="Live reference context">
      <header class="context-header">
        <h2>Context</h2>
        <span class="section-meta">${references.length} live references</span>
      </header>
      <p class="context-intro">References preserve object identity and resolve current data only when an Agent needs it.</p>
      <div class="references-list">
        ${references.map(referenceRowTemplate).join("")}
      </div>
      ${renderReferenceDetail(selectedReference)}
    </aside>
  `;
}

function renderApp() {
  ensureActiveSelection();
  const items = visibleItems();
  const activeItem = itemById(state.activeItemId);
  app.innerHTML = `
    <div class="activity-shell">
      ${renderSidebar()}
      <section class="workspace">
        ${renderPageHeader()}
        <div class="page-content">
          <div class="action-board">
            ${renderQueuePanel(items)}
            ${renderDetailPanel(activeItem)}
            ${renderContextPanel(activeItem)}
          </div>
        </div>
      </section>
    </div>
  `;
}

function selectedReferenceChip(reference) {
  return `
    <span class="selected-reference-chip">
      <span>${escapeHtml(reference.kind)}</span>
      <strong>${escapeHtml(reference.label)}</strong>
      <button type="button" class="chip-remove" aria-label="Remove ${escapeHtml(reference.label)}" data-remove-selected-reference="${escapeHtml(reference.id)}">
        ${icon("close")}
      </button>
    </span>
  `;
}

function renderResumeDialog() {
  const item = itemById(state.activeItemId);
  if (!item) return "";
  const selectedReferences = state.selectedReferenceIds
    .map(referenceById)
    .filter(Boolean);
  return `
    <div class="dialog-backdrop" data-dialog-backdrop="true">
      <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="resume-title">
        <header class="dialog-header">
          <div>
            <h2 id="resume-title">Resume Agent Team</h2>
            <p>The note is injected into the main Agent context and resets the circuit breaker.</p>
          </div>
          <button type="button" class="icon-button" aria-label="Close resume dialog" data-close-dialog="true">${icon("close")}</button>
        </header>
        <div class="dialog-body">
          <div class="resume-context">
            <span class="meta-chip">${escapeHtml(item.runId)}</span>
            <span class="meta-chip">${escapeHtml(item.terminalLabel)}</span>
            <span class="meta-chip">${escapeHtml(item.acceptance?.sourceCaseId ?? "need_human")}</span>
          </div>
          <label class="form-label" for="resume-note">Intervention note</label>
          <textarea
            id="resume-note"
            class="note-field"
            data-input="resume-note"
            placeholder="说明已确认的问题、下一步策略或需要主 Agent 遵守的边界…"
          >${escapeHtml(state.resumeNote)}</textarea>
          <div class="reference-composer-row">
            <span>References remain live and read-only when the Agent resolves them.</span>
            <button type="button" class="button small" data-open-picker="true">${icon("plus")} Add reference</button>
          </div>
          <div class="selected-references">
            ${selectedReferences.map(selectedReferenceChip).join("")}
          </div>
          <div class="reference-safety">
            Resolution is restricted to the current project scope. A reference shares identity and current metadata; it does not grant permission to mutate the referenced Run, Terminal, Case, or artifact.
          </div>
        </div>
        <footer class="dialog-footer">
          <button type="button" class="button ghost" data-close-dialog="true">Cancel</button>
          <button type="button" class="button primary" data-submit-resume="true" ${state.resumeNote.trim() ? "" : "disabled"}>Resume run</button>
        </footer>
      </section>
    </div>
  `;
}

function pickerReferences() {
  const source = state.data.referenceSources.find(
    (candidate) => candidate.id === state.pickerSourceId,
  );
  const allowedIds = new Set(source?.items ?? []);
  const query = state.pickerSearch.trim().toLowerCase();
  return allReferences().filter((reference) => {
    if (!allowedIds.has(reference.id)) return false;
    if (!query) return true;
    return [reference.label, reference.description, reference.uri, reference.kind]
      .join(" ")
      .toLowerCase()
      .includes(query);
  });
}

function pickerItemTemplate(reference) {
  const selected = state.pendingPickerReferenceIds.includes(reference.id);
  return `
    <button type="button" class="picker-item ${selected ? "selected" : ""}" data-picker-reference="${escapeHtml(reference.id)}">
      <div class="reference-main">
        <span class="reference-icon">${icon(referenceIconName(reference.kind))}</span>
        <div class="reference-copy">
          <strong>${escapeHtml(reference.label)}</strong>
          <p>${escapeHtml(reference.description)}</p>
        </div>
      </div>
      <span class="live-badge">Live</span>
      <span class="picker-check">${icon("check")}</span>
    </button>
  `;
}

function renderPickerDialog() {
  const items = pickerReferences();
  return `
    <div class="dialog-backdrop" data-dialog-backdrop="true">
      <section class="dialog picker-dialog" role="dialog" aria-modal="true" aria-labelledby="picker-title">
        <header class="dialog-header">
          <div>
            <h2 id="picker-title">Add reference</h2>
            <p>Select current Runweave objects. The composer stores handles, not expanded content.</p>
          </div>
          <button type="button" class="icon-button" aria-label="Close reference picker" data-close-picker="true">${icon("close")}</button>
        </header>
        <div class="dialog-body">
          <div class="picker-toolbar">
            <nav class="picker-sources" aria-label="Reference sources">
              ${state.data.referenceSources
                .map(
                  (source) => `
                    <button type="button" class="picker-source ${source.id === state.pickerSourceId ? "active" : ""}" data-picker-source="${escapeHtml(source.id)}">
                      <span>${escapeHtml(source.label)}</span>
                      <span>${source.items.length}</span>
                    </button>
                  `,
                )
                .join("")}
            </nav>
            <section class="picker-results">
              <label class="picker-search">
                ${icon("search")}
                <span class="sr-only">Search references</span>
                <input type="search" placeholder="Search Terminal, Run, Case, artifact" value="${escapeHtml(state.pickerSearch)}" data-input="picker-search" />
              </label>
              <div class="picker-list">
                ${
                  items.length
                    ? items.map(pickerItemTemplate).join("")
                    : `<div class="empty-state"><div><strong>No references found</strong><p>Try another source or search term.</p></div></div>`
                }
              </div>
            </section>
          </div>
        </div>
        <footer class="dialog-footer">
          <button type="button" class="button ghost" data-close-picker="true">Cancel</button>
          <button type="button" class="button primary" data-add-picker-references="true">
            Add ${state.pendingPickerReferenceIds.length} reference${state.pendingPickerReferenceIds.length === 1 ? "" : "s"}
          </button>
        </footer>
      </section>
    </div>
  `;
}

function renderFindingDialog() {
  const item = itemById(state.activeItemId);
  if (!item?.finding) return "";
  return `
    <div class="dialog-backdrop" data-dialog-backdrop="true">
      <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="finding-title">
        <header class="dialog-header">
          <div>
            <h2 id="finding-title">Finding 范围裁决</h2>
            <p>${escapeHtml(item.finding.invariantKey)} · ${escapeHtml(item.finding.verificationMode)}</p>
          </div>
          <button type="button" class="icon-button" aria-label="Close finding dialog" data-close-dialog="true">${icon("close")}</button>
        </header>
        <div class="dialog-body">
          <article class="finding-card">
            <strong>${escapeHtml(item.title)}</strong>
            <p><b>Expected</b> · ${escapeHtml(item.finding.expected)}</p>
            <p><b>Actual</b> · ${escapeHtml(item.finding.actual)}</p>
            <p><b>Mapped case</b> · ${escapeHtml(item.finding.caseImpacts.join(", "))}</p>
          </article>
          <label class="form-label" for="finding-reason" style="margin-top:14px">Decision reason</label>
          <textarea id="finding-reason" class="note-field" data-input="finding-reason" placeholder="说明为什么继续修复、标记范围外或本轮豁免…">${escapeHtml(state.findingReason)}</textarea>
        </div>
        <footer class="dialog-footer">
          <button type="button" class="button" data-finding-decision="blocking" ${state.findingReason.trim() ? "" : "disabled"}>继续修复</button>
          <button type="button" class="button" data-finding-decision="out_of_scope" ${state.findingReason.trim() ? "" : "disabled"}>标记范围外</button>
          <button type="button" class="button" data-finding-decision="waived" ${state.findingReason.trim() ? "" : "disabled"}>本轮豁免</button>
        </footer>
      </section>
    </div>
  `;
}

function renderModal() {
  if (state.dialog === "resume") {
    modalRoot.innerHTML = renderResumeDialog();
  } else if (state.dialog === "picker") {
    modalRoot.innerHTML = renderPickerDialog();
  } else if (state.dialog === "finding") {
    modalRoot.innerHTML = renderFindingDialog();
  } else {
    modalRoot.innerHTML = "";
  }
}

function showToast(title, detail) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.innerHTML = `
    <span class="toast-dot"></span>
    <div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span></div>
  `;
  toastRegion.append(toast);
  window.setTimeout(() => toast.remove(), 3600);
}

function setItemResolved(item, resolution) {
  item.status = "resolved";
  item.priority = "normal";
  item.priorityLabel = "Resolved";
  item.updatedAt = "Just now";
  item.history = [
    ...(item.history ?? []),
    { label: resolution, meta: "Human action · Just now", tone: "success" },
  ];
  if (state.filterId === "attention") {
    state.activeItemId = null;
  }
  state.dialog = null;
  renderApp();
  renderModal();
}

function openResumeDialog(item) {
  state.activeItemId = item.id;
  state.dialog = "resume";
  state.resumeNote = "";
  state.selectedReferenceIds = [];
  renderModal();
  window.requestAnimationFrame(() =>
    document.querySelector("#resume-note")?.focus(),
  );
}

function openPicker() {
  state.dialog = "picker";
  state.pendingPickerReferenceIds = [...state.selectedReferenceIds];
  state.pickerSearch = "";
  renderModal();
}

function closePicker() {
  state.dialog = "resume";
  state.pendingPickerReferenceIds = [];
  state.pickerSearch = "";
  renderModal();
}

function closeDialog() {
  state.dialog = null;
  renderModal();
}

async function copyReference(reference) {
  try {
    await navigator.clipboard.writeText(reference.uri);
  } catch {
    const fallback = document.createElement("textarea");
    fallback.value = reference.uri;
    fallback.style.position = "fixed";
    fallback.style.opacity = "0";
    document.body.append(fallback);
    fallback.select();
    document.execCommand("copy");
    fallback.remove();
  }
  showToast("Reference copied", `${reference.label} · live handle`);
}

function handleItemAction(item, actionId) {
  if (actionId === "focus") {
    showToast("Pane focused", `${item.panelLabel ?? item.terminalLabel} · ${item.terminalSessionId}`);
    document.body.dataset.focusedPanel = item.panelId ?? item.terminalSessionId;
    return;
  }
  if (actionId === "resume") {
    openResumeDialog(item);
    return;
  }
  if (actionId === "confirm") {
    setItemResolved(item, "Split confirmed");
    showToast("Split confirmed", `${item.proposal.workers.length} workers can enter executing`);
    return;
  }
  if (actionId === "reject") {
    setItemResolved(item, "Split rejected");
    showToast("Split rejected", "The main Agent can revise the proposal");
    return;
  }
  if (actionId === "review-finding") {
    state.dialog = "finding";
    state.findingReason = "";
    renderModal();
    window.requestAnimationFrame(() =>
      document.querySelector("#finding-reason")?.focus(),
    );
  }
}

function submitResume() {
  const item = itemById(state.activeItemId);
  if (!item || !state.resumeNote.trim()) return;
  const referenceLines = state.selectedReferenceIds
    .map(referenceById)
    .filter(Boolean)
    .map((reference) => `[${reference.label}](${reference.uri})`);
  item.resolutionNote = [state.resumeNote.trim(), ...referenceLines].join("\n");
  setItemResolved(item, "Run resumed with intervention note");
  showToast(
    "Agent Team resumed",
    `${referenceLines.length} live reference${referenceLines.length === 1 ? "" : "s"} attached`,
  );
}

function submitFindingDecision(disposition) {
  const item = itemById(state.activeItemId);
  if (!item || !state.findingReason.trim()) return;
  item.findingDecision = {
    disposition,
    reason: state.findingReason.trim(),
  };
  const labels = {
    blocking: "Finding marked blocking",
    out_of_scope: "Finding marked out of scope",
    waived: "Finding waived for this run",
  };
  setItemResolved(item, labels[disposition]);
  showToast("Finding decision recorded", labels[disposition]);
}

function handleClick(event) {
  const button = event.target.closest("button");
  const referenceRow = event.target.closest("[data-reference-row]");

  if (referenceRow && !button?.dataset.copyReference) {
    state.selectedReferenceId = referenceRow.dataset.referenceRow;
    renderApp();
    return;
  }
  if (!button) return;

  if (button.dataset.itemId && !button.dataset.itemAction) {
    state.activeItemId = button.dataset.itemId;
    state.selectedReferenceId = null;
    renderApp();
    return;
  }
  if (button.dataset.filterId) {
    state.filterId = button.dataset.filterId;
    state.activeItemId = null;
    renderApp();
    return;
  }
  if (button.dataset.itemAction) {
    const item = itemById(button.dataset.itemId);
    if (item) handleItemAction(item, button.dataset.itemAction);
    return;
  }
  if (button.dataset.copyReference) {
    const reference = referenceById(button.dataset.copyReference);
    if (reference) void copyReference(reference);
    return;
  }
  if (button.dataset.closeDialog) {
    closeDialog();
    return;
  }
  if (button.dataset.openPicker) {
    openPicker();
    return;
  }
  if (button.dataset.closePicker) {
    closePicker();
    return;
  }
  if (button.dataset.pickerSource) {
    state.pickerSourceId = button.dataset.pickerSource;
    state.pickerSearch = "";
    renderModal();
    return;
  }
  if (button.dataset.pickerReference) {
    const referenceId = button.dataset.pickerReference;
    state.pendingPickerReferenceIds = state.pendingPickerReferenceIds.includes(
      referenceId,
    )
      ? state.pendingPickerReferenceIds.filter((id) => id !== referenceId)
      : [...state.pendingPickerReferenceIds, referenceId];
    renderModal();
    return;
  }
  if (button.dataset.addPickerReferences) {
    state.selectedReferenceIds = [...state.pendingPickerReferenceIds];
    closePicker();
    return;
  }
  if (button.dataset.removeSelectedReference) {
    state.selectedReferenceIds = state.selectedReferenceIds.filter(
      (id) => id !== button.dataset.removeSelectedReference,
    );
    renderModal();
    return;
  }
  if (button.dataset.submitResume) {
    submitResume();
    return;
  }
  if (button.dataset.findingDecision) {
    submitFindingDecision(button.dataset.findingDecision);
  }
}

function handleInput(event) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) {
    return;
  }
  if (input.dataset.input === "global-search" || input.dataset.input === "queue-search") {
    state.search = input.value;
    renderApp();
    const selector = `[data-input="${input.dataset.input}"]`;
    const nextInput = document.querySelector(selector);
    if (nextInput instanceof HTMLInputElement) {
      nextInput.focus();
      nextInput.setSelectionRange(nextInput.value.length, nextInput.value.length);
    }
    return;
  }
  if (input.dataset.input === "picker-search") {
    state.pickerSearch = input.value;
    renderModal();
    const nextInput = document.querySelector('[data-input="picker-search"]');
    if (nextInput instanceof HTMLInputElement) {
      nextInput.focus();
      nextInput.setSelectionRange(nextInput.value.length, nextInput.value.length);
    }
    return;
  }
  if (input.dataset.input === "resume-note") {
    state.resumeNote = input.value;
    const submit = document.querySelector("[data-submit-resume]");
    if (submit instanceof HTMLButtonElement) submit.disabled = !state.resumeNote.trim();
    return;
  }
  if (input.dataset.input === "finding-reason") {
    state.findingReason = input.value;
    document.querySelectorAll("[data-finding-decision]").forEach((decision) => {
      if (decision instanceof HTMLButtonElement) {
        decision.disabled = !state.findingReason.trim();
      }
    });
  }
}

function handleBackdropClick(event) {
  if (event.target instanceof HTMLElement && event.target.dataset.dialogBackdrop) {
    if (state.dialog === "picker") closePicker();
    else closeDialog();
  }
}

function handleKeydown(event) {
  if (event.key !== "Escape" || !state.dialog) return;
  if (state.dialog === "picker") closePicker();
  else closeDialog();
}

function bindInteractions() {
  app.addEventListener("click", handleClick);
  app.addEventListener("input", handleInput);
  modalRoot.addEventListener("click", handleClick);
  modalRoot.addEventListener("click", handleBackdropClick);
  modalRoot.addEventListener("input", handleInput);
  window.addEventListener("keydown", handleKeydown);
}

function applyUrlState() {
  const params = new URLSearchParams(window.location.search);
  const requestedItemId = params.get("item");
  if (requestedItemId && itemById(requestedItemId)) {
    state.activeItemId = requestedItemId;
  }
  if (params.has("picker")) {
    const breaker = itemById("attention-breaker");
    if (breaker) {
      state.activeItemId = breaker.id;
      state.dialog = "picker";
    }
  }
}

function renderLoadError(error) {
  app.innerHTML = "";
  const panel = document.createElement("pre");
  panel.style.margin = "0";
  panel.style.padding = "18px";
  panel.style.whiteSpace = "pre-wrap";
  panel.style.color = "var(--danger)";
  panel.textContent = [
    "无法加载 mock-state.json。",
    "",
    String(error),
    "",
    "请用以下命令启动原型：",
    "python3 -m http.server 6188 --directory docs/prototypes/activity-action-center-live-references",
  ].join("\n");
  app.append(panel);
}

fetch("./mock-state.json", { cache: "no-store" })
  .then((response) => {
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return response.json();
  })
  .then((data) => {
    state.data = data;
    state.filterId = data.activeFilterId;
    state.activeItemId = data.activeItemId;
    bindInteractions();
    applyUrlState();
    renderApp();
    renderModal();
  })
  .catch(renderLoadError);
