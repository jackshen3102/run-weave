/* global document, fetch, HTMLInputElement, URL */

const app = document.querySelector("#app");
const prototypeAssetVersion =
  new URL(import.meta.url).searchParams.get("v") ?? String(Date.now());

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function cleanQuery(query) {
  return query.trim();
}

function matchesQuery(value, query) {
  const normalizedQuery = cleanQuery(query).toLowerCase();
  if (!normalizedQuery) {
    return true;
  }
  return value.toLowerCase().includes(normalizedQuery);
}

function highlight(value, query) {
  const cleaned = cleanQuery(query);
  if (!cleaned) {
    return escapeHtml(value);
  }
  const index = value.toLowerCase().indexOf(cleaned.toLowerCase());
  if (index < 0) {
    return escapeHtml(value);
  }
  return [
    escapeHtml(value.slice(0, index)),
    "<mark>",
    escapeHtml(value.slice(index, index + cleaned.length)),
    "</mark>",
    escapeHtml(value.slice(index + cleaned.length)),
  ].join("");
}

function modeLabel(mode) {
  if (mode === "content") {
    return "Search in files";
  }
  if (mode === "folder") {
    return "Go to folder";
  }
  return "Go to file";
}

function getResults(data, state) {
  if (state.mode === "content") {
    return data.contentResults.filter((item) =>
      matchesQuery(`${item.path} ${item.preview}`, state.query),
    );
  }
  if (state.mode === "folder") {
    return data.folderResults.filter((item) => matchesQuery(item.path, state.query));
  }
  return data.pathResults.filter((item) => matchesQuery(item.path, state.query));
}

function renderTopBar(data) {
  return `
    <header class="prototype-topbar">
      <div class="prototype-title">
        <strong>Runweave</strong>
        <span>${escapeHtml(data.project.path)}</span>
      </div>
      <div class="prototype-session">
        <span>Terminal</span>
        <strong>feature</strong>
      </div>
    </header>
  `;
}

function renderSidecarHeader() {
  return `
    <header class="sidecar-header">
      <div class="tool-tabs" role="tablist" aria-label="Sidecar tools">
        <button class="is-active" type="button">Preview</button>
        <button type="button">Browser</button>
        <button type="button">Orchestrator</button>
      </div>
      <div class="icon-actions" aria-label="Preview actions">
        <button type="button" title="Refresh">Refresh</button>
        <button type="button" title="Copy path">Copy</button>
        <button type="button" title="Close">Close</button>
      </div>
      <div class="preview-tabs" role="tablist" aria-label="Preview mode">
        <button type="button">Changes</button>
        <button class="is-active" type="button">Explorer</button>
        <button type="button">Open</button>
      </div>
    </header>
  `;
}

function renderTreeRow(item, state) {
  const selected = item.path === state.selectedPath;
  const chevron = item.kind === "folder" ? (item.expanded ? "v" : ">") : "";
  const icon = item.kind === "folder" ? (item.expanded ? "folder-open" : "folder") : "file";
  return `
    <button
      class="tree-row ${selected ? "is-selected" : ""}"
      data-select-path="${escapeHtml(item.path)}"
      style="padding-left: ${item.depth * 16 + 4}px"
      title="${escapeHtml(item.path)}"
      type="button"
    >
      <span class="tree-chevron">${escapeHtml(chevron)}</span>
      <span class="tree-icon">${escapeHtml(icon)}</span>
      <span class="tree-name">${escapeHtml(item.basename)}</span>
    </button>
  `;
}

function renderExplorerTree(data, state) {
  return `
    <aside class="explorer-pane">
      <div class="explorer-toolbar">
        <span>Project Files</span>
        <button type="button" data-action="open-palette">Search</button>
      </div>
      <div class="tree-list">
        ${data.tree.map((item) => renderTreeRow(item, state)).join("")}
      </div>
    </aside>
  `;
}

function renderFilePreview(data, state) {
  const preview = data.filePreview;
  return `
    <section class="file-preview">
      <header class="file-preview-header">
        <div class="file-title">
          <strong>${escapeHtml(state.selectedPath)}</strong>
          <span>${escapeHtml(preview.language)} · ${preview.readonly ? "Read only" : "Editable"}</span>
        </div>
        <button type="button">Save</button>
      </header>
      <div class="editor-surface">
        ${preview.lines
          .map(
            (line, index) => `
              <div class="code-line">
                <span>${index + 1}</span>
                <code>${escapeHtml(line)}</code>
              </div>
            `,
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderPaletteResult(item, state, index) {
  const selected = item.path === state.selectedPath || index === 0;
  const icon =
    state.mode === "content" ? "text" : item.kind === "folder" ? "folder" : "file";
  const badge =
    state.mode === "content"
      ? `${item.line}:${item.column}`
      : item.gitStatus
        ? item.gitStatus.slice(0, 1).toUpperCase()
        : item.kind === "folder"
          ? "DIR"
          : "";
  return `
    <button
      class="command-item ${selected ? "is-selected" : ""} ${
        state.mode === "content" ? "has-match" : ""
      }"
      data-select-path="${escapeHtml(item.path)}"
      type="button"
    >
      <span class="command-icon" aria-hidden="true">${escapeHtml(icon)}</span>
      <span class="command-main">
        <span class="command-name">${highlight(item.basename, state.query)}</span>
        <span class="command-dir">${escapeHtml(item.dirname ?? "")}</span>
        ${
          state.mode === "content" && item.preview
            ? `<span class="command-match">${highlight(item.preview, state.query)}</span>`
            : ""
        }
      </span>
      ${badge ? `<span class="command-badge">${escapeHtml(badge)}</span>` : ""}
    </button>
  `;
}

function renderQuickPalette(data, state) {
  if (!state.paletteOpen) {
    return "";
  }
  const results = getResults(data, state);
  return `
    <div class="palette-backdrop" data-action="close-palette">
      <section class="command-palette" role="dialog" aria-label="Quick file search">
        <header class="command-title">
          <strong>${modeLabel(state.mode)}</strong>
          <span>${escapeHtml(data.project.name)} / ${escapeHtml(data.project.branch)}</span>
        </header>
        <div class="command-tabs" role="tablist" aria-label="Search mode">
          <button class="${state.mode === "path" ? "is-active" : ""}" data-mode="path" type="button">Files</button>
          <button class="${state.mode === "content" ? "is-active" : ""}" data-mode="content" type="button">Content</button>
          <button class="${state.mode === "folder" ? "is-active" : ""}" data-mode="folder" type="button">Folders</button>
        </div>
        <div class="command-input-row">
          <input
            class="command-input"
            data-query-input
            value="${escapeHtml(state.query)}"
            placeholder="${state.mode === "content" ? "Search text in current project..." : "Search file or paste absolute path..."}"
          />
        </div>
        <div class="command-list">
          <div class="command-section">
            ${state.query.trim() ? "Search results" : "Changed files"}
          </div>
          ${
            results.length > 0
              ? results.map((item, index) => renderPaletteResult(item, state, index)).join("")
              : `<div class="command-empty">No results. Press Enter to open the typed path.</div>`
          }
        </div>
        <footer class="command-footer">
          <span>Cmd+P Files</span>
          <span>Cmd+Shift+F Content</span>
          <span>Esc Close</span>
          <span>Enter Open</span>
        </footer>
      </section>
    </div>
  `;
}

function render(data, state) {
  app.innerHTML = `
    ${renderTopBar(data)}
    <section class="terminal-workspace">
      <div class="terminal-surface">
        <div class="terminal-tabbar">
          <button type="button" class="terminal-tab is-active">Runweave</button>
          <button type="button" class="terminal-tab">fix(terminal): handle...</button>
        </div>
        <div class="terminal-screen">
          <div>$ pnpm dev</div>
          <div class="muted">Preview sidecar is open for the current project.</div>
        </div>
      </div>
      <aside class="preview-sidecar">
        ${renderSidecarHeader()}
        <div class="preview-body">
          ${renderExplorerTree(data, state)}
          ${renderFilePreview(data, state)}
        </div>
        <button class="floating-search" data-action="open-palette" type="button">
          Open quick search
        </button>
      </aside>
    </section>
    ${renderQuickPalette(data, state)}
  `;
}

function focusQueryInput() {
  const input = app.querySelector("[data-query-input]");
  if (input instanceof HTMLInputElement) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

function bindInteractions(data) {
  let state = { ...data.initial };
  render(data, state);
  focusQueryInput();

  app.addEventListener("click", (event) => {
    const target = event.target.closest("button, .palette-backdrop");
    if (!target) {
      return;
    }
    if (target.dataset.action === "open-palette") {
      state = { ...state, paletteOpen: true };
      render(data, state);
      focusQueryInput();
      return;
    }
    if (target.dataset.action === "close-palette" && target === event.target) {
      state = { ...state, paletteOpen: false };
      render(data, state);
      return;
    }
    if (target.dataset.mode) {
      state = { ...state, mode: target.dataset.mode };
      render(data, state);
      focusQueryInput();
      return;
    }
    if (target.dataset.selectPath) {
      state = {
        ...state,
        selectedPath: target.dataset.selectPath,
        paletteOpen: false,
      };
      render(data, state);
    }
  });

  app.addEventListener("input", (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.dataset.queryInput !== undefined) {
      state = { ...state, query: target.value };
      render(data, state);
      focusQueryInput();
    }
  });

  document.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    if ((event.metaKey || event.ctrlKey) && key === "p") {
      event.preventDefault();
      state = { ...state, mode: "path", paletteOpen: true };
      render(data, state);
      focusQueryInput();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && key === "f") {
      event.preventDefault();
      state = { ...state, mode: "content", paletteOpen: true };
      render(data, state);
      focusQueryInput();
      return;
    }
    if (event.key === "Escape" && state.paletteOpen) {
      event.preventDefault();
      state = { ...state, paletteOpen: false };
      render(data, state);
    }
  });
}

function renderLoadError(error) {
  app.innerHTML = "";
  const panel = document.createElement("pre");
  panel.style.margin = "0";
  panel.style.padding = "18px";
  panel.style.color = "#fda4af";
  panel.style.whiteSpace = "pre-wrap";
  panel.textContent = [
    "Cannot load mock-state.json.",
    "",
    String(error),
    "",
    "Start with:",
    "python3 -m http.server 6188 --directory docs/prototypes/explorer-search-interactions",
  ].join("\n");
  app.append(panel);
}

fetch(`./mock-state.json?v=${prototypeAssetVersion}`, {
  cache: "no-store",
})
  .then((response) => {
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return response.json();
  })
  .then(bindInteractions)
  .catch(renderLoadError);
