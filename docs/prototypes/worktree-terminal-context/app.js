/* global URLSearchParams, document, fetch, window */

const app = document.querySelector("#app");

const params = new URLSearchParams(window.location.search);
const requestedLayout = params.get("layout") ?? "rail";

const viewState = {
  data: null,
  layout: requestedLayout,
  activeProjectId: null,
  activeWorktreeId: null,
  activeSessionByWorktree: {},
  lastWorktreeByProject: {},
  selectedPathByWorktree: {},
  pinnedWorktreeIds: new Set(),
  worktreeRailCollapsed: false,
  previewMode: "changes",
  contextMenuOpen: false,
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function allWorktrees() {
  return viewState.data.projects.flatMap((project) =>
    project.worktrees.map((worktree) => ({ project, worktree })),
  );
}

function getActiveProject() {
  return (
    viewState.data.projects.find(
      (project) => project.id === viewState.activeProjectId,
    ) ?? viewState.data.projects[0]
  );
}

function getActiveWorktree() {
  const match = allWorktrees().find(
    ({ worktree }) => worktree.id === viewState.activeWorktreeId,
  );
  return match?.worktree ?? getActiveProject().worktrees[0];
}

function getActiveSession() {
  const worktree = getActiveWorktree();
  const activeSessionId =
    viewState.activeSessionByWorktree[worktree.id] ??
    worktree.lastActiveSessionId;
  return (
    worktree.sessions.find((session) => session.id === activeSessionId) ??
    worktree.sessions[0]
  );
}

function getWorktreeProject(worktreeId) {
  return allWorktrees().find(({ worktree }) => worktree.id === worktreeId)
    ?.project;
}

function statusDot(status) {
  return `<span class="status-dot ${escapeHtml(status)}" aria-hidden="true"></span>`;
}

function renderBrand() {
  return `
    <div class="brand">
      <span class="brand-mark">R</span>
      <span>${escapeHtml(viewState.data.appName)}</span>
    </div>
    <button class="connection-chip" type="button" aria-label="Current connection">
      <span>${escapeHtml(viewState.data.connection)}</span>
    </button>
  `;
}

function renderProjectTabs() {
  return `
    <div class="tabs-scroll" role="tablist" aria-label="Projects">
      ${viewState.data.projects
        .map(
          (project) => `
            <button
              class="project-tab ${project.id === viewState.activeProjectId ? "active" : ""}"
              type="button"
              role="tab"
              aria-selected="${project.id === viewState.activeProjectId}"
              data-project-id="${escapeHtml(project.id)}"
            >
              ${escapeHtml(project.name)}
            </button>
          `,
        )
        .join("")}
      <button class="new-button" type="button" aria-label="New project" title="New project">+</button>
    </div>
  `;
}

function renderTopbar({ projects = true, flatContexts = false } = {}) {
  return `
    <header class="topbar">
      ${renderBrand()}
      ${projects ? renderProjectTabs() : ""}
      ${flatContexts ? renderFlatContextTabs() : ""}
      ${!projects && !flatContexts ? '<div class="topbar-spacer"></div>' : ""}
      <button class="icon-button quick-input-button" type="button" aria-label="快捷指令" title="快捷指令">⚡</button>
      <button class="icon-button" type="button" aria-label="More actions" title="More actions">⋯</button>
    </header>
  `;
}

function renderWorktreeTabs(project = getActiveProject()) {
  return `
    <div class="tabs-scroll" role="tablist" aria-label="Worktrees">
      ${project.worktrees
        .map(
          (worktree) => `
            <button
              class="worktree-tab ${worktree.id === viewState.activeWorktreeId ? "active" : ""}"
              type="button"
              role="tab"
              aria-selected="${worktree.id === viewState.activeWorktreeId}"
              data-worktree-id="${escapeHtml(worktree.id)}"
              title="${escapeHtml(worktree.path)}"
            >
              ${statusDot(worktree.status)}
              <span class="branch-name">${escapeHtml(worktree.branch)}</span>
              ${
                worktree.dirtyCount
                  ? `<span class="change-count">${worktree.dirtyCount}</span>`
                  : ""
              }
            </button>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderContextBar() {
  return `
    <div class="context-bar">
      <span class="context-label"><span class="branch-glyph">⑂</span> Worktrees</span>
      ${renderWorktreeTabs()}
    </div>
  `;
}

function renderFlatContextTabs() {
  return `
    <div class="tabs-scroll" role="tablist" aria-label="Project contexts">
      ${allWorktrees()
        .map(
          ({ project, worktree }) => `
            <button
              class="flat-context-tab ${worktree.id === viewState.activeWorktreeId ? "active" : ""}"
              type="button"
              role="tab"
              aria-selected="${worktree.id === viewState.activeWorktreeId}"
              data-worktree-id="${escapeHtml(worktree.id)}"
              title="${escapeHtml(worktree.path)}"
            >
              ${statusDot(worktree.status)}
              <span class="repo-name">${escapeHtml(project.name)}</span>
              <span>${escapeHtml(worktree.branch)}</span>
              ${
                worktree.dirtyCount
                  ? `<span class="change-count">${worktree.dirtyCount}</span>`
                  : ""
              }
            </button>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderSessionTab(session, worktree, terminalOwned = false) {
  const activeSession = getActiveSession();
  const isActive = activeSession?.id === session.id;
  return `
    <button
      class="session-tab ${isActive ? "active" : ""}"
      type="button"
      role="tab"
      aria-selected="${isActive}"
      data-session-id="${escapeHtml(session.id)}"
      data-worktree-id="${escapeHtml(worktree.id)}"
      title="${escapeHtml(`${session.name} · ${worktree.branch}`)}"
    >
      ${statusDot(session.status)}
      <span class="session-name">${escapeHtml(session.name)}</span>
      ${terminalOwned ? `<span class="worktree-mini">${escapeHtml(worktree.branch)}</span>` : ""}
      <span class="agent-badge">${escapeHtml(session.agent)}</span>
    </button>
  `;
}

function renderSessionBar(worktree = getActiveWorktree()) {
  return `
    <div class="session-bar" role="tablist" aria-label="Terminal sessions">
      <div class="tabs-scroll">
        ${worktree.sessions
          .map((session) => renderSessionTab(session, worktree))
          .join("")}
        <button class="session-add" type="button" aria-label="New terminal" title="New terminal">+</button>
      </div>
    </div>
  `;
}

function renderTerminalOwnedSessionBar() {
  const project = getActiveProject();
  return `
    <div class="session-bar" role="tablist" aria-label="Terminal sessions grouped by worktree">
      <div class="terminal-owned-groups">
        ${project.worktrees
          .map(
            (worktree) => `
              <div class="terminal-owned-group">
                <div class="terminal-owned-group-label" title="${escapeHtml(worktree.path)}">
                  ${statusDot(worktree.status)}
                  <span>${escapeHtml(worktree.branch)}</span>
                </div>
                ${worktree.sessions
                  .map((session) => renderSessionTab(session, worktree, true))
                  .join("")}
              </div>
            `,
          )
          .join("")}
        <button class="session-add" type="button" aria-label="New terminal" title="New terminal">+</button>
      </div>
    </div>
  `;
}

function renderContextTrigger() {
  const project = getActiveProject();
  const worktree = getActiveWorktree();
  return `
    <button
      class="context-trigger"
      type="button"
      data-toggle-context-menu="true"
      aria-expanded="${viewState.contextMenuOpen}"
    >
      ${statusDot(worktree.status)}
      <strong>${escapeHtml(project.name)}</strong>
      <span>/</span>
      <span>${escapeHtml(worktree.branch)}</span>
      <span>⌄</span>
    </button>
  `;
}

function renderContextPopover(position = "") {
  if (!viewState.contextMenuOpen) return "";
  return `
    <div class="context-popover ${position}" role="dialog" aria-label="Switch worktree">
      <div class="popover-head">Switch context</div>
      ${allWorktrees()
        .map(
          ({ project, worktree }) => `
            <button
              class="popover-item ${worktree.id === viewState.activeWorktreeId ? "active" : ""}"
              type="button"
              data-worktree-id="${escapeHtml(worktree.id)}"
            >
              <span>
                <strong>${escapeHtml(project.name)} · ${escapeHtml(worktree.branch)}</strong>
                <span>${escapeHtml(worktree.path)}</span>
              </span>
              <span class="popover-meta">
                ${worktree.dirtyCount ? `${worktree.dirtyCount} changes` : "clean"}
              </span>
            </button>
          `,
        )
        .join("")}
    </div>
  `;
}

function classifyTerminalLine(line) {
  if (line.startsWith("$")) return "command";
  if (line.includes("ready") || line.includes("Done")) return "success";
  if (line.includes("Edited") || line.includes("Changed")) return "activity";
  return "";
}

function renderTerminalPanel({
  compactTrigger = false,
  showContextHeader = true,
} = {}) {
  const worktree = getActiveWorktree();
  const session = getActiveSession();
  return `
    <section class="terminal-panel" aria-label="Terminal">
      ${
        showContextHeader
          ? `<header class="terminal-context-header">
              ${compactTrigger ? renderContextTrigger() : `<span>${statusDot(worktree.status)}</span><strong>${escapeHtml(worktree.branch)}</strong>`}
              <span class="cwd">${escapeHtml(session.cwd)}</span>
              <span>${escapeHtml(session.agent)}</span>
            </header>`
          : ""
      }
      <div class="terminal-output">
        ${session.lines
          .map(
            (line) => `
              <div class="terminal-line ${classifyTerminalLine(line)}">${escapeHtml(line)}</div>
            `,
          )
          .join("")}
        <span class="terminal-cursor" aria-hidden="true"></span>
      </div>
      <div class="composer">
        <div class="composer-field">Ask Codex or type a command...</div>
      </div>
    </section>
  `;
}

function findSelectedItem(worktree, mode) {
  const items = mode === "changes" ? worktree.changes : worktree.files;
  const storedPath = viewState.selectedPathByWorktree[worktree.id];
  return (
    items.find((item) => item.path === storedPath) ??
    items.find((item) => item.path === worktree.selectedFilePath) ??
    items[0] ??
    worktree.files[0]
  );
}

function previewLinesFor(worktree, selectedPath, mode) {
  if (selectedPath === worktree.selectedFilePath) {
    if (mode === "changes") {
      return [
        `@@ ${selectedPath} @@`,
        ...worktree.filePreview.map((line, index) =>
          index === 0 || index === worktree.filePreview.length - 1
            ? ` ${line}`
            : `+${line}`,
        ),
      ];
    }
    return worktree.filePreview;
  }
  const fileName = selectedPath.split("/").at(-1);
  return mode === "changes"
    ? [
        `@@ ${selectedPath} @@`,
        ` import type { ${fileName.replaceAll(/[^a-zA-Z]/g, "")} } from "./types";`,
        "+",
        "+export const worktreeContext = createContext();",
        "+export const activeRoot = resolveActiveRoot();",
      ]
    : [
        `// ${selectedPath}`,
        "",
        "export function resolveContext() {",
        "  return currentProject;",
        "}",
      ];
}

function renderPreviewList(worktree, mode, selectedPath) {
  const items = mode === "changes" ? worktree.changes : worktree.files;
  if (items.length === 0) {
    return '<div class="list-empty">No changes</div>';
  }
  return items
    .map((item) => {
      const kind = mode === "changes" ? item.kind : item.kind;
      return `
        <button
          class="file-row ${item.path === selectedPath ? "active" : ""}"
          type="button"
          data-file-path="${escapeHtml(item.path)}"
        >
          ${
            mode === "changes"
              ? `<span class="change-kind">${escapeHtml(kind)}</span>`
              : `<span class="file-kind">${escapeHtml(kind)}</span>`
          }
          <span class="file-path">${escapeHtml(item.path)}</span>
          ${
            mode === "changes"
              ? `<span class="change-stat"><span class="add">+${item.additions}</span> <span class="delete">-${item.deletions}</span></span>`
              : ""
          }
        </button>
      `;
    })
    .join("");
}

function renderSidecar() {
  const project = getActiveProject();
  const worktree = getActiveWorktree();
  const selectedItem = findSelectedItem(worktree, viewState.previewMode);
  const selectedPath = selectedItem?.path ?? worktree.selectedFilePath;
  const previewLines = previewLinesFor(
    worktree,
    selectedPath,
    viewState.previewMode,
  );
  return `
    <aside class="sidecar" aria-label="Preview sidecar">
      <div class="sidecar-tools">
        <div class="tool-tabs" role="tablist" aria-label="Sidecar tools">
          <button class="tool-tab active" type="button">Preview</button>
          <button class="tool-tab" type="button">Browser</button>
          <button class="tool-tab" type="button">Agent Team</button>
        </div>
        <div class="sidecar-actions">
          <button class="sidecar-action" type="button" aria-label="Expand preview" title="Expand preview">⛶</button>
          <button class="sidecar-action" type="button" aria-label="Refresh preview" title="Refresh preview">↻</button>
          <button class="sidecar-action" type="button" aria-label="Close preview" title="Close preview">×</button>
        </div>
      </div>
      <div class="preview-modes" role="tablist" aria-label="Preview modes">
        <div class="mode-tabs">
          ${["changes", "explorer", "file"]
            .map(
              (mode) => `
                <button
                  class="mode-tab ${viewState.previewMode === mode ? "active" : ""}"
                  type="button"
                  role="tab"
                  aria-selected="${viewState.previewMode === mode}"
                  data-preview-mode="${mode}"
                >
                  ${mode === "changes" ? "Changes" : mode === "explorer" ? "Explorer" : "Open"}
                </button>
              `,
            )
            .join("")}
        </div>
        <span class="preview-context">
          <strong>${escapeHtml(project.name)}</strong>
          <span>/ ${escapeHtml(worktree.branch)}</span>
        </span>
        <span class="save-status">Read only</span>
      </div>
      <div class="preview-pathbar">
        <span class="preview-root-badge">${escapeHtml(worktree.name)}</span>
        <span class="path">${escapeHtml(selectedPath)}</span>
      </div>
      <div class="preview-content">
        <div class="preview-list">
          ${renderPreviewList(worktree, viewState.previewMode, selectedPath)}
        </div>
        <div class="code-view">
          ${previewLines
            .map(
              (line, index) => `
                <div class="code-line">
                  <span class="code-line-number">${index + 1}</span>
                  <span class="code-line-text">${escapeHtml(line)}</span>
                </div>
              `,
            )
            .join("")}
        </div>
      </div>
    </aside>
  `;
}

function renderWorkspaceBody(options = {}) {
  return `
    <div class="workspace-body">
      ${renderTerminalPanel(options)}
      ${renderSidecar()}
    </div>
  `;
}

function renderNestedLayout() {
  return `
    ${renderTopbar()}
    ${renderContextBar()}
    ${renderSessionBar()}
    ${renderWorkspaceBody()}
  `;
}

function renderFlatLayout() {
  return `
    ${renderTopbar({ projects: false, flatContexts: true })}
    ${renderSessionBar()}
    ${renderWorkspaceBody()}
  `;
}

function renderCompactLayout() {
  return `
    ${renderTopbar()}
    ${renderSessionBar()}
    ${renderWorkspaceBody({ compactTrigger: true })}
    ${renderContextPopover("compact-position")}
  `;
}

function getSortedWorktrees(project) {
  return project.worktrees
    .map((worktree, index) => ({ worktree, index }))
    .sort((left, right) => {
      if (left.worktree.isPrimary !== right.worktree.isPrimary) {
        return left.worktree.isPrimary ? -1 : 1;
      }
      const leftPinned = viewState.pinnedWorktreeIds.has(left.worktree.id);
      const rightPinned = viewState.pinnedWorktreeIds.has(right.worktree.id);
      if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
      const activityDifference =
        Date.parse(right.worktree.lastActivityAt ?? 0) -
        Date.parse(left.worktree.lastActivityAt ?? 0);
      return activityDifference || left.index - right.index;
    })
    .map(({ worktree }) => worktree);
}

function renderPinIcon(pinned) {
  return `
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5 2.5h6l-1.25 4 2 2v1H8.6V14L8 14.8 7.4 14V9.5H4.25v-1l2-2L5 2.5Z" ${pinned ? 'fill="currentColor"' : 'fill="none"'} stroke="currentColor" stroke-linejoin="round" />
    </svg>
  `;
}

function renderRail() {
  const project = getActiveProject();
  if (viewState.worktreeRailCollapsed) {
    return `
      <aside class="project-rail collapsed" aria-label="Collapsed worktrees">
        <button
          class="rail-expand-button"
          type="button"
          data-toggle-worktree-rail="true"
          aria-label="Expand worktrees"
          title="Expand worktrees"
        >›</button>
      </aside>
    `;
  }
  return `
    <aside class="project-rail" aria-label="Discovered worktrees">
      <div class="rail-heading">
        <span>Worktrees <small>${project.worktrees.length}</small></span>
        <div class="rail-heading-actions">
          <span class="rail-live-indicator"><span></span> Auto</span>
          <button
            class="rail-collapse-button"
            type="button"
            data-toggle-worktree-rail="true"
            aria-label="Collapse worktrees"
            title="Collapse worktrees"
          >‹</button>
        </div>
      </div>
      <section class="rail-project">
        ${getSortedWorktrees(project)
          .map(
            (worktree) => `
            <div class="rail-worktree-row">
              <button
                class="rail-worktree-button ${worktree.id === viewState.activeWorktreeId ? "active" : ""}"
                type="button"
                data-worktree-id="${escapeHtml(worktree.id)}"
              >
                ${statusDot(worktree.status)}
                <span class="rail-copy">
                  <strong>${escapeHtml(worktree.name)}</strong>
                  <small>${escapeHtml(worktree.branch)}</small>
                </span>
              </button>
              ${
                worktree.isPrimary
                  ? `<span class="rail-pin-button active permanent" role="img" aria-label="当前项目，始终置顶" title="当前项目，始终置顶">${renderPinIcon(true)}</span>`
                  : `<button
                      class="rail-pin-button ${viewState.pinnedWorktreeIds.has(worktree.id) ? "active" : ""}"
                      type="button"
                      data-toggle-pinned-worktree="${escapeHtml(worktree.id)}"
                      aria-label="${viewState.pinnedWorktreeIds.has(worktree.id) ? "取消固定" : "固定到顶部"} ${escapeHtml(worktree.name)}"
                      aria-pressed="${viewState.pinnedWorktreeIds.has(worktree.id)}"
                      title="${viewState.pinnedWorktreeIds.has(worktree.id) ? "取消固定" : "固定到顶部"}"
                    >
                      ${renderPinIcon(viewState.pinnedWorktreeIds.has(worktree.id))}
                    </button>`
              }
            </div>
          `,
          )
          .join("")}
      </section>
    </aside>
  `;
}

function renderRailLayout() {
  return `
    ${renderTopbar()}
    <div class="rail-layout ${viewState.worktreeRailCollapsed ? "rail-collapsed" : ""}">
      ${renderRail()}
      <div class="rail-main">
        ${renderSessionBar()}
        ${renderWorkspaceBody({ showContextHeader: false })}
      </div>
    </div>
  `;
}

function renderTerminalOwnedLayout() {
  const worktree = getActiveWorktree();
  return `
    ${renderTopbar()}
    ${renderTerminalOwnedSessionBar()}
    <div class="context-summary">
      ${statusDot(worktree.status)}
      <strong>${escapeHtml(worktree.branch)}</strong>
      <span class="summary-path">${escapeHtml(worktree.path)}</span>
      ${worktree.dirtyCount ? `<span class="change-count">${worktree.dirtyCount}</span>` : ""}
    </div>
    ${renderWorkspaceBody()}
  `;
}

function render() {
  const validLayout = viewState.data.layouts.some(
    (layout) => layout.id === viewState.layout,
  );
  if (!validLayout) viewState.layout = "rail";

  const layoutMarkup =
    viewState.layout === "flat"
      ? renderFlatLayout()
      : viewState.layout === "compact"
        ? renderCompactLayout()
        : viewState.layout === "rail"
          ? renderRailLayout()
          : viewState.layout === "terminal-owned"
            ? renderTerminalOwnedLayout()
            : renderNestedLayout();

  app.innerHTML = `
    <section class="product-frame" data-layout="${escapeHtml(viewState.layout)}">
      ${layoutMarkup}
    </section>
  `;
}

function selectProject(projectId) {
  const project = viewState.data.projects.find((item) => item.id === projectId);
  if (!project) return;
  viewState.activeProjectId = project.id;
  viewState.activeWorktreeId =
    viewState.lastWorktreeByProject[project.id] ?? project.worktrees[0]?.id;
  viewState.contextMenuOpen = false;
}

function selectWorktree(worktreeId) {
  const project = getWorktreeProject(worktreeId);
  if (!project) return;
  viewState.activeProjectId = project.id;
  viewState.activeWorktreeId = worktreeId;
  viewState.lastWorktreeByProject[project.id] = worktreeId;
  viewState.contextMenuOpen = false;
}

function selectSession(sessionId, worktreeId) {
  selectWorktree(worktreeId);
  viewState.activeSessionByWorktree[worktreeId] = sessionId;
}

function setPreviewMode(mode) {
  if (!["changes", "explorer", "file"].includes(mode)) return;
  viewState.previewMode = mode;
  const worktree = getActiveWorktree();
  const items = mode === "changes" ? worktree.changes : worktree.files;
  if (items[0]) {
    viewState.selectedPathByWorktree[worktree.id] = items[0].path;
  }
}

app.addEventListener("click", (event) => {
  const target = event.target.closest("button");
  if (!target) return;

  if (target.dataset.projectId) {
    selectProject(target.dataset.projectId);
    render();
    return;
  }

  if (target.dataset.toggleWorktreeRail) {
    viewState.worktreeRailCollapsed = !viewState.worktreeRailCollapsed;
    render();
    return;
  }

  if (target.dataset.togglePinnedWorktree) {
    const worktreeId = target.dataset.togglePinnedWorktree;
    if (allWorktrees().find(({ worktree }) => worktree.id === worktreeId)?.worktree.isPrimary) {
      return;
    }
    if (viewState.pinnedWorktreeIds.has(worktreeId)) {
      viewState.pinnedWorktreeIds.delete(worktreeId);
    } else {
      viewState.pinnedWorktreeIds.add(worktreeId);
    }
    render();
    return;
  }

  if (target.dataset.sessionId && target.dataset.worktreeId) {
    selectSession(target.dataset.sessionId, target.dataset.worktreeId);
    render();
    return;
  }

  if (target.dataset.worktreeId) {
    selectWorktree(target.dataset.worktreeId);
    render();
    return;
  }

  if (target.dataset.previewMode) {
    setPreviewMode(target.dataset.previewMode);
    render();
    return;
  }

  if (target.dataset.filePath) {
    viewState.selectedPathByWorktree[getActiveWorktree().id] =
      target.dataset.filePath;
    render();
    return;
  }

  if (target.dataset.toggleContextMenu) {
    viewState.contextMenuOpen = !viewState.contextMenuOpen;
    render();
    return;
  }
});

function renderLoadError(error) {
  app.innerHTML = `
    <pre class="load-error">${escapeHtml(
      [
        "无法加载 mock-state.json。",
        "",
        String(error),
        "",
        "请通过静态服务器打开：",
        "python3 -m http.server 6188 --directory docs/prototypes/worktree-terminal-context",
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
    viewState.data = data;
    viewState.activeProjectId = data.activeProjectId;
    viewState.activeWorktreeId =
      params.get("worktree") ?? data.activeWorktreeId;
    for (const { project, worktree } of allWorktrees()) {
      viewState.activeSessionByWorktree[worktree.id] =
        worktree.lastActiveSessionId;
      viewState.lastWorktreeByProject[project.id] ??= worktree.id;
      viewState.selectedPathByWorktree[worktree.id] = worktree.selectedFilePath;
      if (worktree.pinned) {
        viewState.pinnedWorktreeIds.add(worktree.id);
      }
    }
    const requestedWorktreeProject = getWorktreeProject(
      viewState.activeWorktreeId,
    );
    if (requestedWorktreeProject) {
      viewState.activeProjectId = requestedWorktreeProject.id;
      viewState.lastWorktreeByProject[requestedWorktreeProject.id] =
        viewState.activeWorktreeId;
    }
    render();
  })
  .catch(renderLoadError);
