/* global URLSearchParams, document, fetch, setTimeout, structuredClone, window */

const app = document.querySelector("#app");

const escapeHtml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

function renderMarker(annotation, className) {
  return `<button type="button" class="marker ${className}" data-marker-id="${annotation.id}" aria-label="定位评论 ${annotation.index}">${annotation.index}</button>`;
}

function renderPage(state) {
  const byTarget = Object.fromEntries(
    state.annotations.map((annotation) => [annotation.targetId, annotation]),
  );
  const marker = (targetId, className) =>
    byTarget[targetId] ? renderMarker(byTarget[targetId], className) : "";
  return `
    <div class="web-header">
      <div class="brand"><span class="brand-mark">A</span>Acme</div>
      <nav class="web-nav"><span>Overview</span><span>Projects</span><span class="active">Settings</span></nav>
      <div class="avatar">YL</div>
    </div>
    <div class="page-content">
      <div class="eyebrow">${escapeHtml(state.page.workspace)}</div>
      <h1>${escapeHtml(state.page.title)}</h1>
      <p class="page-subtitle">Manage your plan, seats, and billing details.</p>

      <div class="section-label">Current plan</div>
      <div class="plan-grid">
        <div class="plan-card">
          <div class="plan-name">Starter</div>
          <div class="plan-copy">For personal projects and small experiments.</div>
          <div class="price">$0 <small>/ month</small></div>
        </div>
        <div class="plan-card selected" data-target="plan-card">
          ${marker("plan-card", "plan-marker")}
          <span class="selected-chip">Current</span>
          <div class="plan-name">Pro</div>
          <div class="plan-copy">Advanced collaboration for growing teams.</div>
          <div class="price">$29 <small>/ month</small></div>
        </div>
      </div>

      <div class="section-label">Billing details</div>
      <div class="settings-card">
        <div class="setting-row" data-target="seat-control">
          ${marker("seat-control", "row-marker")}
          <div class="setting-copy"><div class="setting-title">Team seats</div><div class="setting-hint">Seats available to workspace members</div></div>
          <div class="stepper"><button type="button">−</button><span>8 seats</span><button type="button">+</button></div>
        </div>
        <div class="setting-row" data-target="invoice-email">
          ${marker("invoice-email", "row-marker")}
          <div class="setting-copy"><div class="setting-title">Invoice email</div><div class="setting-hint">Monthly receipts are sent to this address</div></div>
          <div class="fake-input">finance@acme.dev</div>
        </div>
      </div>
      <div class="page-actions" data-target="save-button">
        ${marker("save-button", "action-marker")}
        <button type="button" class="web-button secondary">Cancel</button>
        <button type="button" class="web-button primary">Save changes</button>
      </div>
    </div>`;
}

function renderCommentCard(annotation, state) {
  const editing = state.editingId === annotation.id;
  const frozen = state.submitStatus === "sending";
  return `
    <article class="comment-card ${state.focusedId === annotation.id ? "is-focused" : ""}" data-comment-id="${annotation.id}">
      <div class="comment-meta">
        <button type="button" class="comment-number" data-focus-id="${annotation.id}" aria-label="定位评论 ${annotation.index}">${annotation.index}</button>
        <span class="comment-target">${escapeHtml(annotation.targetLabel)} · “${escapeHtml(annotation.targetText)}”</span>
        <div class="card-menu">
          <button type="button" class="card-action" data-edit-id="${annotation.id}" title="编辑评论" aria-label="编辑评论" ${frozen ? "disabled" : ""}>✎</button>
          <button type="button" class="card-action" data-delete-id="${annotation.id}" title="删除评论" aria-label="删除评论" ${frozen ? "disabled" : ""}>×</button>
        </div>
      </div>
      ${
        editing
          ? `
        <textarea class="edit-textarea" data-edit-input="${annotation.id}" aria-label="编辑评论 ${annotation.index}">${escapeHtml(annotation.comment)}</textarea>
        <div class="edit-actions">
          <button type="button" class="small-button" data-cancel-edit>取消</button>
          <button type="button" class="small-button primary" data-save-edit="${annotation.id}">保存</button>
        </div>`
          : `<p class="comment-text">${escapeHtml(annotation.comment)}</p>`
      }
    </article>`;
}

function renderPanel(state) {
  const status =
    state.submitStatus === "error"
      ? `<div class="status-box error">发送失败，评论草稿仍然保留。你可以检查 Agent 终端后重试。</div>`
      : state.submitStatus === "success"
        ? `<div class="status-box success">已发送给当前 Agent，页面评论已归档。</div>`
        : "";
  const sendLabel =
    state.submitStatus === "sending"
      ? `<span class="spinner"></span>正在发送…`
      : state.submitStatus === "error"
        ? `重试发送 ${state.annotations.length} 条评论`
        : `发送 ${state.annotations.length} 条给 Agent`;
  return `
    <aside class="comments-panel" ${state.panelOpen ? "" : "hidden"} aria-label="页面评论">
      <div class="panel-header">
        <div class="panel-title">页面评论</div>
        <span class="panel-count">${state.annotations.length}</span>
        <button type="button" class="panel-icon" data-close-panel aria-label="收起评论面板" title="收起评论面板">×</button>
      </div>
      <div class="panel-summary">${escapeHtml(state.page.title)}<br />${escapeHtml(state.page.url)}</div>
      <div class="comment-list">
        ${
          state.annotations.length > 0
            ? state.annotations
                .map((annotation) => renderCommentCard(annotation, state))
                .join("")
            : `<div class="empty-comments"><div><div class="empty-icon">＋</div>点击页面中的元素添加评论。<br />每条评论会记录目标和页面上下文。</div></div>`
        }
      </div>
      <div class="panel-footer">
        ${status}
        <button type="button" class="send-button" data-send-comments ${state.annotations.length === 0 || state.submitStatus === "sending" ? "disabled" : ""}>${sendLabel}</button>
        ${state.annotations.length > 0 ? `<button type="button" class="footer-secondary" data-discard-comments ${state.submitStatus === "sending" ? "disabled" : ""}>放弃全部草稿</button>` : ""}
      </div>
    </aside>`;
}

function renderComposer(state) {
  if (!state.composerTarget) return "";
  const target = state.composerTarget;
  const index = state.annotations.length + 1;
  const topByTarget = {
    "plan-card": "210px",
    "seat-control": "430px",
    "invoice-email": "492px",
    "save-button": "545px",
  };
  return `
    <div class="composer" style="top:${topByTarget[target.id] ?? "220px"}; right:${state.panelOpen ? "330px" : "18px"}" role="dialog" aria-label="添加页面评论">
      <div class="composer-target"><span class="composer-target-number">${index}</span><span>${escapeHtml(target.label)} · “${escapeHtml(target.text)}”</span></div>
      <textarea autofocus data-composer-input aria-label="评论内容" placeholder="描述你希望 Agent 修改什么…">${escapeHtml(state.composerText)}</textarea>
      <div class="composer-footer">
        <span class="shortcut">⌘ Enter 添加</span>
        <button type="button" class="small-button" data-cancel-compose>取消</button>
        <button type="button" class="small-button primary" data-add-comment ${state.composerText.trim() ? "" : "disabled"}>添加评论</button>
      </div>
    </div>`;
}

function render(state) {
  const hasComments = state.annotations.length > 0;
  app.innerHTML = `
    <div class="app-shell">
      <section class="terminal-pane" aria-label="Terminal">
        <div class="terminal-tabs"><div class="terminal-tab"><span class="terminal-dot"></span>Codex · acme-dashboard</div></div>
        <div class="terminal-body">
          <p><span class="terminal-muted">~/Code/acme-dashboard</span> codex</p>
          <p>› I’m ready. Show me the browser comments and I’ll update the billing experience.</p>
          <p class="terminal-muted">  Waiting for input…</p>
        </div>
      </section>
      <section class="browser-pane" aria-label="Terminal Browser">
        <div class="browser-tabs">
          <div class="browser-tab"><span class="tab-favicon">A</span><span class="tab-title">${escapeHtml(state.page.title)}</span><span class="tab-close">×</span></div>
          <button type="button" class="new-tab" data-navigation-action="new-tab" aria-label="新建标签页">＋</button>
        </div>
        <div class="navigation">
          <button type="button" class="icon-button" data-navigation-action="back" aria-label="后退">←</button>
          <button type="button" class="icon-button" data-navigation-action="forward" aria-label="前进">→</button>
          <button type="button" class="icon-button" data-navigation-action="reload" aria-label="刷新">↻</button>
          <input class="address" value="${escapeHtml(state.page.url)}" aria-label="Browser address" data-address />
          <button type="button" class="icon-button" aria-label="复制地址">⧉</button>
          <button type="button" class="icon-button" aria-label="代理">◉</button>
          ${hasComments ? `<button type="button" class="icon-button ${state.panelOpen || state.selecting ? "is-active" : ""}" data-comments-button aria-label="页面评论">♧<span class="count-badge">${state.annotations.length}</span></button>` : ""}
          <button type="button" class="icon-button" data-more-button aria-expanded="${state.menuOpen}" aria-label="更多浏览器工具">•••</button>
        </div>
        <div class="mode-bar" ${state.selecting ? "" : "hidden"}>
          <div class="mode-icon">＋</div>
          <div class="mode-copy"><div class="mode-title">评论模式</div><div class="mode-hint">点击页面元素添加评论；网页交互暂时停用</div></div>
          <button type="button" class="text-button" data-finish-selecting>完成选择</button>
        </div>
        <div class="browser-workspace">
          <div class="page-viewport ${state.selecting ? "is-selecting" : ""}">${renderPage(state)}</div>
          ${renderPanel(state)}
          ${renderComposer(state)}
        </div>
        <div class="tool-menu" ${state.menuOpen ? "" : "hidden"} aria-label="更多浏览器工具">
          ${!hasComments ? `<button type="button" class="tool-item" data-start-comments><span>♧</span><span>添加页面评论</span></button>` : ""}
          <button type="button" class="tool-item"><span>▣</span><span>移动设备模式</span></button>
          <button type="button" class="tool-item"><span>≡</span><span>请求头规则</span></button>
          <button type="button" class="tool-item"><span>⌁</span><span>开发者工具</span></button>
        </div>
      </section>
    </div>
    <div class="dialog-backdrop" ${state.dialog ? "" : "hidden"}>
      <div class="dialog" role="alertdialog" aria-modal="true">
        <h2>${state.dialog?.type === "discard" ? "放弃全部评论？" : "离开当前页面？"}</h2>
        <p>${state.dialog?.type === "discard" ? `这会删除当前页面的 ${state.annotations.length} 条评论草稿，且无法恢复。` : `当前页面还有 ${state.annotations.length} 条评论草稿。导航后页面目标可能失效。`}</p>
        <div class="dialog-actions">
          <button type="button" class="dialog-button" data-cancel-dialog>继续编辑</button>
          <button type="button" class="dialog-button danger" data-confirm-dialog>${state.dialog?.type === "discard" ? "放弃草稿" : "放弃并离开"}</button>
        </div>
      </div>
    </div>`;
}

function createInitialState(data) {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get("state") ?? "review";
  const annotations =
    mode === "idle" || mode === "selecting" ? [] : data.annotations;
  return {
    ...data,
    annotations: structuredClone(annotations),
    selecting: mode === "selecting",
    panelOpen: mode !== "idle",
    menuOpen: mode === "idle",
    composerTarget: null,
    composerText: "",
    editingId: null,
    focusedId: null,
    submitStatus:
      mode === "error" ? "error" : mode === "success" ? "success" : "idle",
    failNextSubmit: params.get("fail") === "1" || mode === "error",
    dialog: null,
  };
}

function bind(data) {
  let state = createInitialState(data);
  const update = (patch) => {
    state = { ...state, ...patch };
    render(state);
  };

  const addComment = () => {
    if (state.submitStatus === "sending") return;
    const target = state.composerTarget;
    const comment = state.composerText.trim();
    if (!target || !comment) return;
    const next = [
      ...state.annotations,
      {
        id: `comment-${Date.now()}`,
        index: state.annotations.length + 1,
        targetId: target.id,
        targetLabel: target.label,
        targetText: target.text,
        comment,
      },
    ];
    update({
      annotations: next,
      composerTarget: null,
      composerText: "",
      panelOpen: true,
      focusedId: next.at(-1).id,
    });
  };

  render(state);
  app.addEventListener("click", (event) => {
    const targetElement = event.target.closest("[data-target]");
    if (targetElement && state.selecting && !event.target.closest(".marker")) {
      const target = state.targets.find(
        (item) => item.id === targetElement.dataset.target,
      );
      if (
        target &&
        !state.annotations.some((item) => item.targetId === target.id)
      ) {
        update({
          composerTarget: target,
          composerText: "",
          panelOpen: true,
          menuOpen: false,
        });
      }
      return;
    }
    if (event.target.closest("[data-more-button]")) {
      update({ menuOpen: !state.menuOpen });
      return;
    }
    if (event.target.closest("[data-start-comments]")) {
      update({
        selecting: true,
        panelOpen: true,
        menuOpen: false,
        submitStatus: "idle",
      });
      return;
    }
    if (event.target.closest("[data-comments-button]")) {
      update({
        panelOpen: true,
        selecting:
          state.submitStatus === "sending" ? false : !state.selecting,
        menuOpen: false,
      });
      return;
    }
    if (event.target.closest("[data-finish-selecting]")) {
      update({ selecting: false, composerTarget: null });
      return;
    }
    if (event.target.closest("[data-close-panel]")) {
      update({ panelOpen: false, selecting: false, composerTarget: null });
      return;
    }
    if (event.target.closest("[data-cancel-compose]")) {
      update({ composerTarget: null, composerText: "" });
      return;
    }
    if (event.target.closest("[data-add-comment]")) {
      addComment();
      return;
    }
    const focusButton = event.target.closest(
      "[data-focus-id], [data-marker-id]",
    );
    if (focusButton) {
      update({
        focusedId: focusButton.dataset.focusId ?? focusButton.dataset.markerId,
        panelOpen: true,
      });
      return;
    }
    const editButton = event.target.closest("[data-edit-id]");
    if (editButton) {
      if (state.submitStatus === "sending") return;
      update({
        editingId: editButton.dataset.editId,
        focusedId: editButton.dataset.editId,
      });
      return;
    }
    if (event.target.closest("[data-cancel-edit]")) {
      update({ editingId: null });
      return;
    }
    const saveEditButton = event.target.closest("[data-save-edit]");
    if (saveEditButton) {
      if (state.submitStatus === "sending") return;
      const input = app.querySelector(
        `[data-edit-input="${saveEditButton.dataset.saveEdit}"]`,
      );
      const comment = input?.value.trim();
      if (comment) {
        update({
          annotations: state.annotations.map((item) =>
            item.id === saveEditButton.dataset.saveEdit
              ? { ...item, comment }
              : item,
          ),
          editingId: null,
        });
      }
      return;
    }
    const deleteButton = event.target.closest("[data-delete-id]");
    if (deleteButton) {
      if (state.submitStatus === "sending") return;
      const remaining = state.annotations
        .filter((item) => item.id !== deleteButton.dataset.deleteId)
        .map((item, index) => ({ ...item, index: index + 1 }));
      update({ annotations: remaining, focusedId: null, editingId: null });
      return;
    }
    if (event.target.closest("[data-discard-comments]")) {
      if (state.submitStatus === "sending") return;
      update({ dialog: { type: "discard" } });
      return;
    }
    if (event.target.closest("[data-cancel-dialog]")) {
      update({ dialog: null });
      return;
    }
    if (event.target.closest("[data-confirm-dialog]")) {
      update({
        annotations: [],
        selecting: false,
        panelOpen: false,
        submitStatus: "idle",
        dialog: null,
        composerTarget: null,
      });
      return;
    }
    if (event.target.closest("[data-send-comments]")) {
      if (!state.annotations.length || state.submitStatus === "sending") return;
      update({
        submitStatus: "sending",
        selecting: false,
        composerTarget: null,
      });
      setTimeout(() => {
        if (state.failNextSubmit) {
          update({
            submitStatus: "error",
            failNextSubmit: false,
            panelOpen: true,
          });
        } else {
          update({ submitStatus: "success", panelOpen: true });
          setTimeout(
            () =>
              update({
                annotations: [],
                submitStatus: "idle",
                panelOpen: false,
                focusedId: null,
              }),
            1400,
          );
        }
      }, 900);
    }
  });

  app.addEventListener("input", (event) => {
    if (event.target.matches("[data-composer-input]")) {
      state = { ...state, composerText: event.target.value };
      const button = app.querySelector("[data-add-comment]");
      if (button) button.disabled = !state.composerText.trim();
    }
  });

  app.addEventListener("keydown", (event) => {
    if (
      event.target.matches("[data-composer-input]") &&
      event.key === "Enter" &&
      (event.metaKey || event.ctrlKey)
    ) {
      event.preventDefault();
      addComment();
    }
    if (event.key === "Escape" && state.composerTarget) {
      update({ composerTarget: null, composerText: "" });
    }
  });
}

fetch("./mock-state.json")
  .then((response) => response.json())
  .then(bind);
