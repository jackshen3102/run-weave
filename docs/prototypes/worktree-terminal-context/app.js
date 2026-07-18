/* global document, fetch, localStorage, window */

const app = document.querySelector("#app");
const DEFAULT_WORKTREE_RAIL_WIDTH = 236;
const MIN_WORKTREE_RAIL_WIDTH = 180;
const MAX_WORKTREE_RAIL_WIDTH = 420;
const WORKTREE_RAIL_WIDTH_STORAGE_KEY =
  "runweave.prototype.worktree-rail-width";

const viewState = {
  data: null,
  activeParentProjectId: null,
  activeProjectId: null,
  activeSessionByProject: {},
  lastProjectByParent: {},
  selectedPathByProject: {},
  pinnedProjectIds: new Set(),
  worktreeRailCollapsed: false,
  worktreeRailWidth: DEFAULT_WORKTREE_RAIL_WIDTH,
  previewMode: "changes",
};

function clampWorktreeRailWidth(width) {
  return Math.min(
    MAX_WORKTREE_RAIL_WIDTH,
    Math.max(MIN_WORKTREE_RAIL_WIDTH, width),
  );
}

function readWorktreeRailWidth() {
  const storedWidth = Number.parseInt(
    localStorage.getItem(WORKTREE_RAIL_WIDTH_STORAGE_KEY) ?? "",
    10,
  );
  return Number.isFinite(storedWidth)
    ? clampWorktreeRailWidth(storedWidth)
    : DEFAULT_WORKTREE_RAIL_WIDTH;
}

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
      (project) => project.id === viewState.activeParentProjectId,
    ) ?? viewState.data.projects[0]
  );
}

function getActiveWorktree() {
  const match = allWorktrees().find(
    ({ worktree }) => worktree.projectId === viewState.activeProjectId,
  );
  return match?.worktree ?? getActiveProject().worktrees[0];
}

function getActiveSession() {
  const worktree = getActiveWorktree();
  const activeSessionId =
    viewState.activeSessionByProject[worktree.projectId] ??
    worktree.lastActiveSessionId;
  return (
    worktree.sessions.find((session) => session.id === activeSessionId) ??
    worktree.sessions[0]
  );
}

function getWorktreeProject(projectId) {
  return allWorktrees().find(({ worktree }) => worktree.projectId === projectId)
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
              class="project-tab ${project.id === viewState.activeParentProjectId ? "active" : ""}"
              type="button"
              role="tab"
              aria-selected="${project.id === viewState.activeParentProjectId}"
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

function renderTopbar() {
  return `
    <header class="topbar">
      ${renderBrand()}
      ${renderProjectTabs()}
      <button class="icon-button quick-input-button" type="button" aria-label="快捷指令" title="快捷指令">⚡</button>
      <button class="icon-button" type="button" aria-label="More actions" title="More actions">⋯</button>
    </header>
  `;
}

function renderSessionTab(session, worktree) {
  const activeSession = getActiveSession();
  const isActive = activeSession?.id === session.id;
  return `
    <button
      class="session-tab ${isActive ? "active" : ""}"
      type="button"
      role="tab"
      aria-selected="${isActive}"
      data-session-id="${escapeHtml(session.id)}"
      data-context-project-id="${escapeHtml(worktree.projectId)}"
      title="${escapeHtml(`${session.name} · ${worktree.branch}`)}"
    >
      ${statusDot(session.status)}
      <span class="session-name">${escapeHtml(session.name)}</span>
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

function classifyTerminalLine(line) {
  if (line.startsWith("$")) return "command";
  if (line.includes("ready") || line.includes("Done")) return "success";
  if (line.includes("Edited") || line.includes("Changed")) return "activity";
  return "";
}

function renderTerminalPanel({ showContextHeader = true } = {}) {
  const worktree = getActiveWorktree();
  const session = getActiveSession();
  return `
    <section class="terminal-panel" aria-label="Terminal">
      ${
        showContextHeader
          ? `<header class="terminal-context-header">
              <span>${statusDot(worktree.status)}</span><strong>${escapeHtml(worktree.branch)}</strong>
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
  const storedPath = viewState.selectedPathByProject[worktree.projectId];
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

function getSortedWorktrees(project) {
  return project.worktrees
    .map((worktree, index) => ({ worktree, index }))
    .sort((left, right) => {
      if (left.worktree.isPrimary !== right.worktree.isPrimary) {
        return left.worktree.isPrimary ? -1 : 1;
      }
      const leftPinned = viewState.pinnedProjectIds.has(
        left.worktree.projectId,
      );
      const rightPinned = viewState.pinnedProjectIds.has(
        right.worktree.projectId,
      );
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
                class="rail-worktree-button ${worktree.projectId === viewState.activeProjectId ? "active" : ""}"
                type="button"
                data-context-project-id="${escapeHtml(worktree.projectId)}"
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
                      class="rail-pin-button ${viewState.pinnedProjectIds.has(worktree.projectId) ? "active" : ""}"
                      type="button"
                      data-toggle-pinned-project="${escapeHtml(worktree.projectId)}"
                      aria-label="${viewState.pinnedProjectIds.has(worktree.projectId) ? "取消固定" : "固定到顶部"} ${escapeHtml(worktree.name)}"
                      aria-pressed="${viewState.pinnedProjectIds.has(worktree.projectId)}"
                      title="${viewState.pinnedProjectIds.has(worktree.projectId) ? "取消固定" : "固定到顶部"}"
                    >
                      ${renderPinIcon(viewState.pinnedProjectIds.has(worktree.projectId))}
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
    <div
      class="rail-layout ${viewState.worktreeRailCollapsed ? "rail-collapsed" : ""}"
      style="--worktree-rail-width: ${viewState.worktreeRailWidth}px"
    >
      ${renderRail()}
      ${
        viewState.worktreeRailCollapsed
          ? ""
          : `<div
              class="rail-resize-handle"
              data-resize-worktree-rail="true"
              role="separator"
              tabindex="0"
              aria-label="Resize Worktrees panel"
              aria-orientation="vertical"
              aria-valuemin="${MIN_WORKTREE_RAIL_WIDTH}"
              aria-valuemax="${MAX_WORKTREE_RAIL_WIDTH}"
              aria-valuenow="${viewState.worktreeRailWidth}"
            ></div>`
      }
      <div class="rail-main">
        ${renderSessionBar()}
        ${renderWorkspaceBody({ showContextHeader: false })}
      </div>
    </div>
  `;
}

function render() {
  app.innerHTML = `
    <section class="product-frame" data-layout="rail">
      ${renderRailLayout()}
    </section>
  `;
}

function selectProject(projectId) {
  const project = viewState.data.projects.find((item) => item.id === projectId);
  if (!project) return;
  viewState.activeParentProjectId = project.id;
  viewState.activeProjectId =
    viewState.lastProjectByParent[project.id] ??
    project.worktrees[0]?.projectId;
}

function selectWorktreeProject(projectId) {
  const project = getWorktreeProject(projectId);
  if (!project) return;
  viewState.activeParentProjectId = project.id;
  viewState.activeProjectId = projectId;
  viewState.lastProjectByParent[project.id] = projectId;
}

function selectSession(sessionId, projectId) {
  selectWorktreeProject(projectId);
  viewState.activeSessionByProject[projectId] = sessionId;
}

function setPreviewMode(mode) {
  if (!["changes", "explorer", "file"].includes(mode)) return;
  viewState.previewMode = mode;
  const worktree = getActiveWorktree();
  const items = mode === "changes" ? worktree.changes : worktree.files;
  if (items[0]) {
    viewState.selectedPathByProject[worktree.projectId] = items[0].path;
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

  if (target.dataset.togglePinnedProject) {
    const projectId = target.dataset.togglePinnedProject;
    if (
      allWorktrees().find(({ worktree }) => worktree.projectId === projectId)
        ?.worktree.isPrimary
    ) {
      return;
    }
    if (viewState.pinnedProjectIds.has(projectId)) {
      viewState.pinnedProjectIds.delete(projectId);
    } else {
      viewState.pinnedProjectIds.add(projectId);
    }
    render();
    return;
  }

  if (target.dataset.sessionId && target.dataset.contextProjectId) {
    selectSession(target.dataset.sessionId, target.dataset.contextProjectId);
    render();
    return;
  }

  if (target.dataset.contextProjectId) {
    selectWorktreeProject(target.dataset.contextProjectId);
    render();
    return;
  }

  if (target.dataset.previewMode) {
    setPreviewMode(target.dataset.previewMode);
    render();
    return;
  }

  if (target.dataset.filePath) {
    viewState.selectedPathByProject[getActiveWorktree().projectId] =
      target.dataset.filePath;
    render();
    return;
  }
});

app.addEventListener("pointerdown", (event) => {
  const handle = event.target.closest("[data-resize-worktree-rail]");
  if (!handle || viewState.worktreeRailCollapsed) return;

  event.preventDefault();
  const layout = handle.closest(".rail-layout");
  const layoutLeft = layout.getBoundingClientRect().left;
  const previousCursor = document.body.style.cursor;
  const previousUserSelect = document.body.style.userSelect;
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
  layout.classList.add("rail-resizing");

  const resize = (moveEvent) => {
    viewState.worktreeRailWidth = clampWorktreeRailWidth(
      Math.round(moveEvent.clientX - layoutLeft),
    );
    layout.style.setProperty(
      "--worktree-rail-width",
      `${viewState.worktreeRailWidth}px`,
    );
    handle.setAttribute("aria-valuenow", String(viewState.worktreeRailWidth));
  };
  const stop = () => {
    window.removeEventListener("pointermove", resize);
    window.removeEventListener("pointerup", stop);
    window.removeEventListener("pointercancel", stop);
    document.body.style.cursor = previousCursor;
    document.body.style.userSelect = previousUserSelect;
    layout.classList.remove("rail-resizing");
    localStorage.setItem(
      WORKTREE_RAIL_WIDTH_STORAGE_KEY,
      String(viewState.worktreeRailWidth),
    );
  };

  window.addEventListener("pointermove", resize);
  window.addEventListener("pointerup", stop);
  window.addEventListener("pointercancel", stop);
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
    viewState.worktreeRailWidth = readWorktreeRailWidth();
    viewState.activeParentProjectId = data.activeParentProjectId;
    viewState.activeProjectId = data.activeProjectId;
    for (const { project, worktree } of allWorktrees()) {
      viewState.activeSessionByProject[worktree.projectId] =
        worktree.lastActiveSessionId;
      viewState.lastProjectByParent[project.id] ??= worktree.projectId;
      viewState.selectedPathByProject[worktree.projectId] =
        worktree.selectedFilePath;
      if (worktree.pinned) {
        viewState.pinnedProjectIds.add(worktree.projectId);
      }
    }
    const requestedWorktreeProject = getWorktreeProject(
      viewState.activeProjectId,
    );
    if (requestedWorktreeProject) {
      viewState.activeParentProjectId = requestedWorktreeProject.id;
      viewState.lastProjectByParent[requestedWorktreeProject.id] =
        viewState.activeProjectId;
    }
    render();
  })
  .catch(renderLoadError);
