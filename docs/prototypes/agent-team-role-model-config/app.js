const icon = (name) => {
  const paths = {
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    close: '<path d="m7 7 10 10M17 7 7 17"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.34 5.66M20 5v6h-6"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] ?? ""}</svg>`;
};

const deepCopy = (value) => JSON.parse(JSON.stringify(value));

const state = {
  data: null,
  moreMenuOpen: false,
  modalOpen: false,
  selectedRoleId: "code",
  modelPopoverOpen: false,
  modelSearch: "",
  draftRoles: [],
  toast: "",
};

const app = document.querySelector("#app");

const currentRole = () =>
  state.draftRoles.find((role) => role.id === state.selectedRoleId) ??
  state.draftRoles[0];

const catalogFor = (role) => state.data.catalogs[role.cli];

const modelFor = (role) => {
  const catalog = catalogFor(role);
  return catalog.models.find((model) => model.id === role.model) ?? null;
};

const roleSummary = (role) => {
  const model = modelFor(role);
  if (!model) {
    return `${catalogFor(role).label} · 请选择模型`;
  }
  const effort = role.reasoningEffort ? ` · ${role.reasoningEffort}` : "";
  return `${catalogFor(role).label} · ${model.label}${effort}`;
};

const renderMoreMenu = () => {
  if (!state.moreMenuOpen) return "";
  return `
    <div class="more-menu" role="menu" aria-label="More actions">
      ${[
        ["▱", "Preview", ""],
        ["◇", "Open Prototypes", ""],
        ["↶", "Terminal History", ""],
        ["⌁", "Recover Codex", ""],
        ["↑", "日志上报", ""],
        ["◉", "状态查询", ""],
      ]
        .map(
          ([itemIcon, label]) => `
            <button class="menu-item" type="button" role="menuitem" data-passive-menu-item>
              <span class="menu-item-icon">${itemIcon}</span>
              <span class="menu-item-copy"><strong>${label}</strong></span>
            </button>
          `,
        )
        .join("")}
      <div class="menu-divider"></div>
      <button class="menu-item" type="button" role="menuitem" data-open-agent-settings>
        <span class="menu-item-icon">AT</span>
        <span class="menu-item-copy">
          <strong>Agent Team 模型配置</strong>
          <span>为每个角色设置 CLI、模型与参数</span>
        </span>
        <span class="scope-mini">全局</span>
      </button>
    </div>
  `;
};

const renderWorkspace = () => {
  const { workspace } = state.data;
  return `
    <div class="app-shell">
      <header class="workspace-header">
        <div class="app-mark" aria-label="Runweave">RW</div>
        <button class="connection-pill" type="button">
          <span class="status-dot"></span>
          <span>${workspace.connectionName}</span>
          <span style="color:#5f6876">⌄</span>
        </button>
        <span class="header-divider"></span>
        <nav class="project-tabs" aria-label="Projects">
          <button class="tab active" type="button">
            <span class="branch-dot"></span>
            <span>${workspace.projectName}</span>
          </button>
          <button class="tab" type="button">coze-claw</button>
        </nav>
        <span class="header-spacer"></span>
        <button class="icon-button" type="button" aria-label="New terminal" title="New terminal">
          ${icon("plus")}
        </button>
        <div class="more-wrap">
          <button
            class="icon-button ${state.moreMenuOpen ? "active" : ""}"
            type="button"
            aria-label="More actions"
            title="More actions"
            aria-expanded="${state.moreMenuOpen}"
            data-toggle-more
          >
            ${icon("more")}
          </button>
          ${renderMoreMenu()}
        </div>
      </header>
      <section class="workspace">
        <aside class="activity-rail" aria-label="Workspace tools">
          <button class="rail-button active" type="button" title="Explorer">⌑</button>
          <button class="rail-button" type="button" title="Search">⌕</button>
          <button class="rail-button" type="button" title="Git">⑂</button>
          <span style="flex:1"></span>
          <button class="rail-button" type="button" title="Settings">⚙</button>
        </aside>
        <aside class="project-sidebar">
          <div class="sidebar-title">
            <span>Explorer</span>
            <span>···</span>
          </div>
          <div class="tree">
            <div class="tree-row root"><span class="tree-caret">▼</span>${workspace.projectName}</div>
            <div class="tree-row"><span class="tree-caret">▶</span>app</div>
            <div class="tree-row"><span class="tree-caret">▶</span>electron</div>
            <div class="tree-row"><span class="tree-caret">▼</span>frontend</div>
            <div class="tree-row indent active">src</div>
            <div class="tree-row"><span class="tree-caret">▶</span>packages</div>
            <div class="tree-row"><span class="tree-caret">▶</span>docs</div>
            <div class="tree-row">package.json</div>
            <div class="tree-row">AGENTS.md</div>
          </div>
        </aside>
        <section class="terminal-area">
          <div class="terminal-tabs">
            <div class="terminal-tab"><span>›_</span><strong>${workspace.terminalName}</strong><span style="margin-left:auto;color:#626c7b">×</span></div>
          </div>
          <div class="terminal-output">
            ${workspace.terminalLines
              .map((line) => {
                if (line.kind === "prompt") {
                  return `<div class="term-line"><span class="prompt-arrow">❯</span><span class="term-path">${line.path}</span><span class="term-command">${line.text}</span></div>`;
                }
                return `<div class="term-line">${line.text || "&nbsp;"}</div>`;
              })
              .join("")}
          </div>
          <div class="terminal-status">
            <span>● connected</span>
            <span>${workspace.branch}</span>
            <span style="margin-left:auto">${workspace.connectionDetail}</span>
          </div>
        </section>
      </section>
      ${state.modalOpen ? renderModal() : ""}
      ${state.toast ? `<div class="toast" role="status"><span class="toast-check">✓</span>${state.toast}</div>` : ""}
    </div>
  `;
};

const renderRoleList = () =>
  state.draftRoles
    .map(
      (role) => `
        <button
          class="role-card ${role.id === state.selectedRoleId ? "active" : ""}"
          type="button"
          data-role-id="${role.id}"
          aria-pressed="${role.id === state.selectedRoleId}"
        >
          <span class="role-avatar">${role.shortLabel}</span>
          <span class="role-card-copy">
            <span class="role-name">${role.label}</span>
            <span class="role-summary">${roleSummary(role)}</span>
          </span>
        </button>
      `,
    )
    .join("");

const renderModelPopover = (role) => {
  if (!state.modelPopoverOpen) return "";
  const query = state.modelSearch.trim().toLowerCase();
  const models = catalogFor(role).models.filter((model) => {
    if (!query) return true;
    return `${model.label} ${model.id} ${model.description}`
      .toLowerCase()
      .includes(query);
  });
  return `
    <div class="model-popover">
      <div class="model-search-wrap">
        <input
          class="model-search"
          type="search"
          value="${state.modelSearch}"
          placeholder="搜索 ${catalogFor(role).label} 模型"
          aria-label="搜索模型"
          data-model-search
        />
      </div>
      <div class="model-options" role="listbox">
        ${
          models.length
            ? models
                .map(
                  (model) => `
                    <button
                      class="model-option ${model.id === role.model ? "selected" : ""}"
                      type="button"
                      role="option"
                      aria-selected="${model.id === role.model}"
                      data-model-id="${model.id}"
                    >
                      <span class="model-option-copy">
                        <strong>${model.label}</strong>
                        <span>${model.description} · ${Math.round(model.contextWindow / 1000)}K context</span>
                      </span>
                      <span class="model-check">${model.id === role.model ? "✓" : ""}</span>
                    </button>
                  `,
                )
                .join("")
            : '<div style="padding:18px;color:#778190;text-align:center;font-size:10px">没有匹配的模型</div>'
        }
      </div>
    </div>
  `;
};

const renderReasoning = (role, model) => {
  if (!model) {
    return '<div class="reasoning-empty">选择模型后显示可用的 reasoning effort</div>';
  }
  if (!model.reasoningEfforts?.length) {
    return '<div class="reasoning-empty">该模型不提供可配置的 reasoning effort</div>';
  }
  return `
    <div class="reasoning-options">
      ${model.reasoningEfforts
        .map(
          (effort) => `
            <button
              class="reasoning-chip ${role.reasoningEffort === effort ? "active" : ""}"
              type="button"
              data-effort="${effort}"
            >${effort}</button>
          `,
        )
        .join("")}
    </div>
  `;
};

const renderAdvanced = (role, model) => {
  if (!model) return "";
  const summary =
    role.cli === "codex"
      ? role.serviceTier === "fast"
        ? "Fast"
        : "Standard"
      : `Max ${role.maxMode ? "开启" : "关闭"}`;
  return `
    <section class="advanced-card">
      <button class="advanced-trigger" type="button" data-toggle-advanced>
        <span class="chevron">${role.advancedOpen ? "⌄" : "›"}</span>
        <span>高级参数</span>
        <span class="advanced-summary">${summary}</span>
      </button>
      ${
        role.advancedOpen
          ? role.cli === "codex"
            ? `
              <div class="advanced-content single">
                <div class="option-row">
                  <span class="option-copy">
                    <strong>Fast 模式</strong>
                    <span>${model.supportsFastTier ? "使用优先服务层" : "当前模型不支持"}</span>
                  </span>
                  <button
                    class="toggle ${role.serviceTier === "fast" ? "on" : ""}"
                    type="button"
                    aria-label="Fast 模式"
                    aria-pressed="${role.serviceTier === "fast"}"
                    data-toggle-fast
                    ${model.supportsFastTier ? "" : "disabled"}
                  ></button>
                </div>
              </div>
            `
            : `
              <div class="advanced-content">
                <div class="option-row">
                  <span class="option-copy">
                    <strong>Max 模式</strong>
                    <span>${model.supportsMax ? "使用模型提供的最大推理预算" : "当前模型不支持"}</span>
                  </span>
                  <button
                    class="toggle ${role.maxMode ? "on" : ""}"
                    type="button"
                    aria-label="Max 模式"
                    aria-pressed="${role.maxMode}"
                    data-toggle-max
                    ${model.supportsMax ? "" : "disabled"}
                  ></button>
                </div>
                <div class="option-row">
                  <span class="option-copy">
                    <strong>模型能力</strong>
                    <span>${model.reasoningEfforts?.length ? `${model.reasoningEfforts.length} 档 reasoning` : "由 TraeX 自动调度"}</span>
                  </span>
                  <span style="color:#76808f;font-size:10px">${Math.round(model.contextWindow / 1000)}K</span>
                </div>
              </div>
            `
          : ""
      }
    </section>
  `;
};

const renderModal = () => {
  const role = currentRole();
  const catalog = catalogFor(role);
  const model = modelFor(role);
  const canSave = state.draftRoles.every((candidate) => modelFor(candidate));
  return `
    <div class="modal-layer" role="presentation" data-modal-backdrop>
      <section class="settings-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <header class="modal-header">
          <div class="modal-title-block">
            <div class="title-line">
              <h1 id="modal-title">Agent Team 模型配置</h1>
              <span class="global-badge">全局</span>
            </div>
          </div>
          <div class="catalog-status">
            <span class="catalog-pill"><span class="status-dot"></span>Codex ${state.data.catalogs.codex.models.length}</span>
            <span class="catalog-pill"><span class="status-dot"></span>TraeX ${state.data.catalogs.traex.models.length}</span>
          </div>
          <button class="icon-button modal-close" type="button" aria-label="关闭" data-cancel-modal>
            ${icon("close")}
          </button>
        </header>
        <div class="modal-body">
          <aside class="role-list-panel">
            <div class="section-eyebrow">角色默认配置</div>
            <div class="role-list">${renderRoleList()}</div>
            <p class="role-list-note">
              每个角色独立保存 CLI、模型和能力参数。模型列表来自当前连接上已安装的 CLI。
            </p>
          </aside>
          <section class="role-editor">
            <div class="editor-heading">
              <div class="editor-heading-copy">
                <h2>${role.label}</h2>
                <p>${role.intent}</p>
              </div>
            </div>
            <div class="form-grid">
              <div class="form-field full">
                <div class="field-label-row">
                  <span class="field-label">CLI</span>
                  <span class="field-hint">运行时会把下列配置编译为 CLI 参数</span>
                </div>
                <div class="segmented" role="group" aria-label="CLI">
                  ${["codex", "traex"]
                    .map(
                      (cli) => `
                        <button
                          class="segment ${role.cli === cli ? "active" : ""}"
                          type="button"
                          data-cli="${cli}"
                          aria-pressed="${role.cli === cli}"
                        >${state.data.catalogs[cli].label}</button>
                      `,
                    )
                    .join("")}
                </div>
              </div>
              <div class="form-field full">
                <div class="field-label-row">
                  <span class="field-label">模型</span>
                  <span class="field-hint">${catalog.command} · ${catalog.models.length} 个可用模型</span>
                </div>
                <div class="model-picker">
                  <button
                    class="model-trigger"
                    type="button"
                    aria-expanded="${state.modelPopoverOpen}"
                    data-toggle-models
                  >
                    <span class="model-symbol">${role.cli === "codex" ? "CX" : "TX"}</span>
                    <span class="model-trigger-copy">
                      <strong>${model?.label ?? "请选择模型"}</strong>
                      <span>${model?.id ?? "必须显式选择一个可用模型"}</span>
                    </span>
                    <span class="chevron">⌄</span>
                  </button>
                  ${renderModelPopover(role)}
                </div>
              </div>
              <div class="form-field full">
                <div class="field-label-row">
                  <span class="field-label">Reasoning effort</span>
                  <span class="field-hint">仅展示当前模型实际支持的档位</span>
                </div>
                ${renderReasoning(role, model)}
              </div>
              ${renderAdvanced(role, model)}
            </div>
          </section>
        </div>
        <footer class="modal-footer">
          <div class="scope-note">
            <span class="scope-note-icon">◆</span>
            <span>保存后只影响新启动的 Agent Team；运行中和历史 Run 保持原配置。</span>
          </div>
          <span class="footer-spacer"></span>
          <button class="secondary-button" type="button" data-cancel-modal>取消</button>
          <button class="primary-button" type="button" data-save-modal ${canSave ? "" : "disabled"}>保存全局配置</button>
        </footer>
      </section>
    </div>
  `;
};

const render = () => {
  if (!state.data) {
    app.innerHTML = '<div style="padding:24px;color:#8d96a5">正在载入原型…</div>';
    return;
  }
  app.innerHTML = renderWorkspace();
  bindEvents();
};

const updateRole = (patch) => {
  state.draftRoles = state.draftRoles.map((role) =>
    role.id === state.selectedRoleId ? { ...role, ...patch } : role,
  );
};

const normalizeForModel = (role, model) => ({
  reasoningEffort: model.reasoningEfforts?.includes(role.reasoningEffort)
    ? role.reasoningEffort
    : (model.defaultReasoning ?? model.reasoningEfforts?.[0] ?? null),
  serviceTier: model.supportsFastTier ? role.serviceTier : "standard",
  maxMode: model.supportsMax ? role.maxMode : false,
});

const openModal = () => {
  state.draftRoles = deepCopy(state.data.roles);
  state.selectedRoleId = state.data.selectedRoleId ?? "code";
  state.moreMenuOpen = false;
  state.modalOpen = true;
  state.modelPopoverOpen = false;
  state.modelSearch = "";
  render();
};

const closeModal = () => {
  state.modalOpen = false;
  state.modelPopoverOpen = false;
  state.modelSearch = "";
  state.draftRoles = [];
  render();
};

const bindEvents = () => {
  document.querySelector("[data-toggle-more]")?.addEventListener("click", (event) => {
    event.stopPropagation();
    state.moreMenuOpen = !state.moreMenuOpen;
    render();
  });

  document.querySelector("[data-open-agent-settings]")?.addEventListener("click", openModal);

  document.querySelectorAll("[data-passive-menu-item]").forEach((button) => {
    button.addEventListener("click", () => {
      state.moreMenuOpen = false;
      render();
    });
  });

  document.querySelectorAll("[data-cancel-modal]").forEach((button) => {
    button.addEventListener("click", closeModal);
  });

  document.querySelector("[data-modal-backdrop]")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeModal();
  });

  document.querySelector("[data-save-modal]")?.addEventListener("click", () => {
    if (!state.draftRoles.every((role) => modelFor(role))) return;
    state.data.roles = deepCopy(state.draftRoles);
    state.data.selectedRoleId = state.selectedRoleId;
    state.modalOpen = false;
    state.modelPopoverOpen = false;
    state.toast = "Agent Team 全局模型配置已保存";
    render();
    window.setTimeout(() => {
      state.toast = "";
      render();
    }, 2400);
  });

  document.querySelectorAll("[data-role-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedRoleId = button.dataset.roleId;
      state.modelPopoverOpen = false;
      state.modelSearch = "";
      render();
    });
  });

  document.querySelectorAll("[data-cli]").forEach((button) => {
    button.addEventListener("click", () => {
      const cli = button.dataset.cli;
      if (cli === currentRole().cli) return;
      updateRole({
        cli,
        model: null,
        reasoningEffort: null,
        serviceTier: "standard",
        maxMode: false,
      });
      state.modelPopoverOpen = false;
      state.modelSearch = "";
      render();
    });
  });

  document.querySelector("[data-toggle-models]")?.addEventListener("click", () => {
    state.modelPopoverOpen = !state.modelPopoverOpen;
    state.modelSearch = "";
    render();
    if (state.modelPopoverOpen) {
      document.querySelector("[data-model-search]")?.focus();
    }
  });

  document.querySelector("[data-model-search]")?.addEventListener("input", (event) => {
    state.modelSearch = event.target.value;
    render();
    const search = document.querySelector("[data-model-search]");
    search?.focus();
    search?.setSelectionRange(state.modelSearch.length, state.modelSearch.length);
  });

  document.querySelectorAll("[data-model-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const role = currentRole();
      const model = catalogFor(role).models.find(
        (candidate) => candidate.id === button.dataset.modelId,
      );
      if (!model) return;
      updateRole({ model: model.id, ...normalizeForModel(role, model) });
      state.modelPopoverOpen = false;
      state.modelSearch = "";
      render();
    });
  });

  document.querySelectorAll("[data-effort]").forEach((button) => {
    button.addEventListener("click", () => {
      updateRole({ reasoningEffort: button.dataset.effort });
      render();
    });
  });

  document.querySelector("[data-toggle-advanced]")?.addEventListener("click", () => {
    updateRole({ advancedOpen: !currentRole().advancedOpen });
    render();
  });

  document.querySelector("[data-toggle-fast]")?.addEventListener("click", () => {
    updateRole({
      serviceTier: currentRole().serviceTier === "fast" ? "standard" : "fast",
    });
    render();
  });

  document.querySelector("[data-toggle-max]")?.addEventListener("click", () => {
    updateRole({ maxMode: !currentRole().maxMode });
    render();
  });

};

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (state.modelPopoverOpen) {
    state.modelPopoverOpen = false;
    state.modelSearch = "";
    render();
    return;
  }
  if (state.modalOpen) {
    closeModal();
    return;
  }
  if (state.moreMenuOpen) {
    state.moreMenuOpen = false;
    render();
  }
});

const load = async () => {
  try {
    const response = await fetch("./mock-state.json");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json();
    state.selectedRoleId = state.data.selectedRoleId ?? "code";
    render();
  } catch (error) {
    app.innerHTML = `<div style="padding:24px;color:#e58f8f">原型数据载入失败：${error.message}</div>`;
  }
};

load();
