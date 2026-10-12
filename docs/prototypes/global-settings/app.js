import { createConnections } from "./connections.js";
import { createMobile } from "./mobile.js";
import { createDiagnostics } from "./diagnostics.js";
import { createSettingsBehavior } from "./settings-behavior.js";
const $ = (s) => document.querySelector(s);
const esc = (v = "") =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const paths = {
  back: "M19 12H5m7-7-7 7 7 7",
  sun: "M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4",
  keyboard: "M3 6h18v13H3zM6 10h1m3 0h1m3 0h1m3 0h1M6 14h1m3 0h1m3 0h4",
  link: "M10 13a5 5 0 0 0 7 0l4-4a5 5 0 0 0-7-7l-3 3M14 11a5 5 0 0 0-7 0l-4 4a5 5 0 0 0 7 7l3-3",
  user: "M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M4 21v-2a8 8 0 0 1 16 0v2",
  lock: "M6 10h12v11H6zM8 10V6a4 4 0 0 1 8 0v4",
  activity: "M2 12h5l3-8 4 16 3-8h5",
  sliders: "M4 5h16M4 12h16M4 19h16M8 2v6m8 1v6M9 16v6",
  monitor: "M3 3h18v14H3zM8 21h8m-4-4v4",
  check: "m5 12 4 4L19 6",
  chevron: "m9 5 7 7-7 7",
  up: "m6 14 6-6 6 6",
  down: "m6 10 6 6 6-6",
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  plus: "M12 4v16M4 12h16",
  menu: "M4 6h16M4 12h16M4 18h16",
  zap: "M13 2 3 14h9l-1 8 10-12h-9z",
  server: "M3 3h18v7H3zM3 14h18v7H3zM6 6h.01M6 17h.01",
  notebook: "M4 3h15v18H4zM2 7h4M2 12h4M2 17h4M9 7h6M9 12h3m1 5 6-6 2 2-6 6-3 1z",
  calendar: "M8 2v4m8-4v4M3 10h18M21 12V4H3v17h9M22 18a4 4 0 1 1-8 0 4 4 0 0 1 8 0m-4-2v2l1 1",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  phone: "M7 2h10v20H7zM10 18h4",
  globe:
    "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M3 12h18M12 3c-5 5-5 13 0 18 5-5 5-13 0-18",
};
const icon = (n) =>
  `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[n] || paths.grid}"/></svg>`;
const button = (label, action, cls = "", extra = "") =>
  `<button class="btn ${cls}" data-action="${action}" ${extra}>${esc(label)}</button>`;
const input = (field, label, value, type = "text") =>
  `<input type="${type}" data-field="${esc(field)}" aria-label="${esc(label)}" value="${esc(value)}" ${type === "password" ? `autocomplete="${field === "oldPassword" || field === "auth-password" || state?.page === "suiji" ? "current-password" : "new-password"}"` : ""}>`;
const select = (field, label, value, options) =>
  `<select data-field="${field}" aria-label="${esc(label)}">${options
    .map((o) => {
      const [id, title] = Array.isArray(o) ? o : [o, o];
      return `<option value="${esc(id)}" ${id === value ? "selected" : ""}>${esc(title)}</option>`;
    })
    .join("")}</select>`;
const toggle = (field, label, value, disabled = false) =>
  `<label class="switch"><input type="checkbox" data-field="${field}" aria-label="${esc(label)}" ${value ? "checked" : ""} ${disabled ? "disabled" : ""}><span></span></label>`;
const row = (title, description, control) =>
  `<div class="row"><div><strong>${esc(title)}</strong>${description ? `<p>${esc(description)}</p>` : ""}</div><div class="control">${control}</div></div>`;
const section = (title, body) =>
  `<section class="section"><div class="section-heading"><h2>${esc(title)}</h2></div>${body}</section>`;
const card = (body) => `<div class="card">${body}</div>`;
const clone = (v) => structuredClone(v);
let fixture, state, timer, connectionsUI, mobileUI, diagnosticsUI, behavior;
const current = () => fixture.pages.find((p) => p.id === state.page);
const target = () => state.connections.find((c) => c.id === state.target);
const config = () => state.computer[state.target];
const draft = () => state.draft;
const offline = () => current()?.scope === "computer" && !target().online;
const requiresLogin = () =>
  current()?.scope === "computer" && state.reauth[state.target];
const isEditing = () =>
  !requiresLogin() &&
  (["notifications", "monitoring", "advanced"].includes(state.page) ||
    (state.page === "connections" && state.detail) ||
    (state.page === "access" &&
      state.tab === "password" &&
      !state.reauth[state.target]));
function notification(message) {
  clearTimeout(timer);
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  timer = setTimeout(() => ($("#toast").hidden = true), 2500);
}
function confirm(title, message, action, label = "放弃修改") {
  $("#confirm").innerHTML =
    `<h2 id="dialog-title">${esc(title)}</h2><p>${esc(message)}</p><div class="actions">${button("取消", "dismiss")}${button(label, "confirm", "primary")}</div>`;
  state.confirm = action;
  $("#confirm").showModal();
}
function guard(fn) {
  if (state.busy) return notification("正在处理，请稍候。");
  if (state.dirty)
    confirm(
      "放弃未保存的修改？",
      "当前修改尚未保存，离开后将恢复已保存的配置。",
      () => {
        state.dirty = false;
        prepare();
        fn();
      },
    );
  else fn();
}
function prepare() {
  state.dirty = false;
  state.error = "";
  if (state.page === "notifications")
    state.draft = { enabled: state.notifications };
  else if (state.page === "suiji")
    state.draft = { ...clone(state.accounts[state.environment]), password: "" };
  else if (["monitoring", "advanced"].includes(state.page))
    state.draft = clone(config());
  else if (state.page === "connections") connectionsUI.prepare();
  else if (state.page === "access")
    state.draft = { oldPassword: "", password: "", repeat: "", username: "" };
  else state.draft = null;
  state.secretActions = {};
}
function navigate(
  page,
  { detail = null, tab = null, historyMode = "push" } = {},
) {
  guard(() => {
    if (page !== "workspace" && !fixture.pages.some((p) => p.id === page))
      page = "appearance";
    if (state.page === "access" && state.tab === "mobile") mobileUI.cancel();
    state.page = page;
    state.detail = detail;
    state.tab =
      tab ||
      (page === "connections"
        ? "saved"
        : state.page === "advanced"
          ? "models"
          : page === "status"
            ? "runtime"
            : page === "access"
              ? "password"
              : "");
    prepare();
    history[historyMode === "replace" ? "replaceState" : "pushState"](
      {},
      "",
      `#/${page}${detail ? "/" + detail : ""}`,
    );
    render();
  });
}
function switchTarget(id) {
  if (id === state.target) return;
  guard(() => {
    mobileUI.cancel();
    state.target = id;
    prepare();
    render();
    notification(`正在查看 ${target().name} 的配置`);
  });
  renderSidebar();
}
function scopeText() {
  return current().scope === "computer"
    ? `所选电脑 · ${target().name}`
    : current().scope === "account"
      ? "随记账户"
      : "本台应用";
}
function renderSidebar() {
  const groups = ["本台应用", "连接与服务", "所选电脑", "状态与诊断"];
  $("#sidebar").innerHTML =
    `<button class="back" data-action="workspace">${icon("back")}返回工作区</button><h2 class="side-title">全局设置</h2><nav aria-label="设置分类">${groups
      .map(
        (g) =>
          `<div class="nav-group"><p class="nav-label">${g}</p>${g === "所选电脑" ? `<select class="target-select" id="settings-target" aria-label="所选电脑">${state.connections.map((c) => `<option value="${c.id}" ${c.id === state.target ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>` : ""}${fixture.pages
            .filter((p) => p.group === g)
            .map(
              (p) =>
                `<a class="nav-link ${p.id === state.page ? "active" : ""}" ${p.id === state.page ? 'aria-current="page"' : ""} href="#/${p.id}" data-page="${p.id}">${icon(p.icon)}${p.title}</a>`,
            )
            .join("")}</div>`,
      )
      .join(
        "",
      )}</nav><div class="side-foot"><i class="dot"></i>Runweave Desktop</div>`;
}
function savebar(label = "保存修改") {
  return `<footer class="savebar"><span class="save-label">${state.dirty ? "有未保存的修改" : "所有修改已保存"}</span><span class="spacer"></span>${button("取消修改", "reset", "ghost", !state.dirty ? "disabled" : "")}${button(label, "save", "primary", !state.dirty || offline() || state.busy || (state.page === "connections" && !connectionsUI.canSave()) || (state.page === "advanced" && (state.configDiskError || (state.tab === "models" && behavior.modelError()))) ? "disabled" : "")}</footer>`;
}
function tabs(items) {
  return `<nav class="tabs" aria-label="页面分类">${items.map(([id, title]) => `<button data-tab="${id}" class="${state.tab === id ? "active" : ""}" ${state.tab === id ? 'aria-current="page"' : ""}>${title}</button>`).join("")}</nav>`;
}
function render() {
  const active = document.activeElement;
  const fieldName = active?.dataset.field;
  const caret = active?.selectionStart;
  const oldScroll = $("#content").scrollTop;
  const openDetails = [
    ...document.querySelectorAll("#content details[open]"),
  ].map(
    (el) =>
      el.dataset.detail || el.querySelector(":scope > summary")?.textContent,
  );
  $("#content").setAttribute("aria-busy", String(Boolean(state.busy)));
  const workspace = state.page === "workspace";
  $("#workspace").hidden = !workspace;
  $("#settings").hidden = workspace;
  document.title = workspace
    ? "Runweave · browser-viewer"
    : `${current().title} · 全局设置`;
  if (workspace) {
    if (!state.visibleTools.includes(state.tool))
      state.tool = state.tools.find((t) => state.visibleTools.includes(t));
    renderWorkspace();
    return;
  }
  renderSidebar();
  const page = current();
  $("#content").innerHTML =
    `<div class="content-wrap"><header class="page-head"><div><h1 tabindex="-1">${state.page === "connections" && state.detail ? (state.tab === "hosts" ? (state.detail === "new" ? "添加 SSH 主机" : "编辑 SSH 主机") : state.detail === "new" ? "添加连接" : "编辑连接") : page.title}</h1><p class="subtitle">${descriptions[page.id]}</p></div><span class="scope">${icon(page.scope === "computer" ? "monitor" : page.scope === "account" ? "user" : "sliders")}${esc(scopeText())}</span></header>${offline() ? `<div class="note"><span>无法连接 ${esc(target().name)}，当前显示上次读取的配置。</span><span class="spacer"></span>${button("重新连接", "reconnect", "ghost")}</div>` : ""}${requiresLogin() ? behavior.loginView() : body()}<p id="form-error" role="alert" ${state.error ? "" : "hidden"}>${esc(state.error)}</p>${isEditing() ? savebar(state.page === "advanced" && state.tab === "models" ? "保存默认模型" : state.page === "connections" && state.detail === "new" ? (state.tab === "hosts" ? "添加 SSH 主机" : "添加连接") : "保存修改") : ""}</div>`;
  document.querySelectorAll("#content details").forEach((el) => {
    if (
      openDetails.includes(
        el.dataset.detail || el.querySelector(":scope > summary")?.textContent,
      )
    )
      el.open = true;
  });
  $("#content").scrollTop = 0;
  $("#content h1").focus({ preventScroll: true });
  if (state.busy)
    document
      .querySelectorAll("#content input, #content select, #content button")
      .forEach((el) => {
        el.disabled = true;
      });
  if (fieldName) {
    const next = document.querySelector(
      `[data-field="${CSS.escape(fieldName)}"]`,
    );
    if (next) {
      next.focus({ preventScroll: true });
      if (caret != null && next.type !== "number" && next.tagName === "INPUT") {
        try {
          next.setSelectionRange(caret, caret);
        } catch {}
      }
      $("#content").scrollTop = oldScroll;
    }
  }
}
const descriptions = {
  appearance: "选择应用外观与工具标签的默认布局。",
  notifications: "管理本台桌面的系统通知。",
  shortcuts: "查看桌面应用现有的键盘快捷键。",
  connections: "管理已保存的电脑连接与 SSH 主机。",
  suiji: "管理随记账户与服务环境。",
  access: "管理所选电脑的登录凭据与手机接入。",
  monitoring: "管理所选电脑的后台资源采样与提醒。",
  advanced: "修改所选电脑的实例配置与默认值。",
  status: "查看所选电脑的运行状态与资源。",
  desktop: "查看本台桌面的版本与诊断信息。",
};
function body() {
  switch (state.page) {
    case "appearance":
      return appearance();
    case "notifications":
      return behavior.notificationView();
    case "shortcuts":
      return (
        section(
          "应用快捷键",
          card(
            fixture.shortcuts
              .map(([title, key]) => row(title, "", `<kbd>${esc(key)}</kbd>`))
              .join(""),
          ),
        ) + `<p class="muted small">快捷键遵循当前桌面应用与系统菜单。</p>`
      );
    case "connections":
      return connections();
    case "suiji":
      return account();
    case "access":
      return access();
    case "monitoring":
      return (
        section(
          "监控与提醒",
          card(
            row(
              "后台资源监控",
              "关闭页面后仍会继续采样。",
              toggle("monitor", "后台资源监控", draft().monitor),
            ) +
              row(
                "资源占用提醒",
                "满足持续高占用条件后提醒。",
                toggle("alerts", "资源占用提醒", draft().alerts),
              ),
          ),
        ) +
        section(
          "远程操作权限",
          card(
            row(
              "允许远程结束进程",
              state.target === "local"
                ? "允许已登录客户端结束这台电脑的普通进程。"
                : "仅能在该电脑本机修改此权限。",
              toggle(
                "remoteControl",
                "允许远程结束进程",
                draft().remoteControl,
                state.target !== "local",
              ),
            ),
          ),
        )
      );
    case "advanced":
      return advanced();
    case "status":
      return status();
    case "desktop":
      return desktop();
  }
}
function appearance() {
  return (
    section(
      "主题",
      `<div class="theme-grid">${[
        ["light", "浅色"],
        ["dark", "深色"],
        ["system", "跟随系统"],
      ]
        .map(
          ([id, title]) =>
            `<button class="theme ${state.theme === id ? "selected" : ""}" data-theme="${id}" aria-pressed="${state.theme === id}"><div class="mini-window ${id}"><div class="mini-app"><aside></aside><div><i></i><i></i><i></i></div></div></div><span class="theme-label">${title}${state.theme === id ? icon("check") : ""}</span></button>`,
        )
        .join("")}</div>`,
    ) +
    section(
      "右侧工具标签",
      `<p class="muted small" style="margin:-6px 0 16px">控制工具标签的默认显示与顺序。</p><div class="card">${state.tools.map((t, i) => `<div class="row tool-row"><div class="tool-name">${icon(t.startsWith("Browser") ? "globe" : "grid")}<strong>${esc(t)}</strong></div><div class="actions"><button class="reorder" data-move="${i}" data-delta="-1" aria-label="前移 ${esc(t)}" ${i === 0 ? "disabled" : ""}>${icon("up")}</button><button class="reorder" data-move="${i}" data-delta="1" aria-label="后移 ${esc(t)}" ${i === state.tools.length - 1 ? "disabled" : ""}>${icon("down")}</button><label class="switch"><input type="checkbox" data-tool="${esc(t)}" aria-label="显示 ${esc(t)}" ${state.visibleTools.includes(t) ? "checked" : ""}><span></span></label></div></div>`).join("")}</div><p class="saved-note">${icon("check")}自动保存</p>`,
    )
  );
}
function connections() {
  return connectionsUI.render() + connectionsUI.editorActions();
}
function field(key, title, value, type = "text") {
  return `<label class="field">${esc(title)}${input(key, title, value, type)}</label>`;
}
function account() {
  return (
    behavior.accountBanner() +
    `<nav class="tabs" aria-label="随记环境">${[
      ["production", "正式环境"],
      ["development", "开发环境"],
    ]
      .map(
        ([id, title]) =>
          `<button data-environment="${id}" class="${state.environment === id ? "active" : ""}">${title}</button>`,
      )
      .join(
        "",
      )}</nav>${draft().loggedIn ? card(row("已登录", esc(draft().username) + " · " + esc(draft().endpoint), `<div class="actions">${button("修改账户配置", "edit-account")}${button("退出账户", "logout-account", "danger")}</div>`)) : `<div class="card form-grid">${field("endpoint", "随记服务地址", draft().endpoint, "url")}${field("username", "随记账号", draft().username)}${field("password", "随记密码", draft().password, "password")}<div class="actions">${button("登录随记", "login-account", "primary")}${state.error ? button("重试连接", "login-account") : ""}</div></div>`}<p class="subtitle">随记账户独立于电脑连接，各环境分别保存。</p>`
  );
}
function access() {
  return (
    tabs([
      ["password", "登录凭据"],
      ["mobile", "手机接入"],
    ]) +
    (state.tab === "password"
      ? state.reauth[state.target]
        ? `<div class="note">请重新登录 ${esc(target().name)}。</div><div class="card form-grid">${field("username", "登录用户名", draft().username)}${field("password", "登录密码", draft().password, "password")}${button("登录", "reauth", "primary", offline() ? "disabled" : "")}</div>`
        : `<div class="card form-grid"><div><h2>修改登录密码</h2><p class="subtitle">作用于 ${esc(target().name)} 的 Backend 登录。</p></div>${field("oldPassword", "当前密码", draft().oldPassword, "password")}${field("password", "新密码", draft().password, "password")}${field("repeat", "确认新密码", draft().repeat, "password")}</div>`
      : mobileUI.render())
  );
}

function advanced() {
  const tabList = tabs([
    ["models", "默认模型"],
    ["tasks", "后台任务配置"],
    ["instance", "实例配置"],
  ]);
  const pending = state.pending[state.target]
    ? '<div class="note">配置已保存，部分修改等待所属服务重新加载或重启。</div>'
    : "";
  if (state.tab === "models") return tabList + behavior.modelView();
  const fields = fixture.fields.filter((f) =>
    state.tab === "tasks"
      ? f.path.startsWith("scheduledTasks.")
      : !f.path.startsWith("scheduledTasks."),
  );
  const groups = [...new Set(fields.map((f) => f.domain))];
  return (
    tabList +
    behavior.configBanner() +
    pending +
    `<div class="section-heading"><p class="muted">${esc(target().name)} · 保存版本 ${state.revisions[state.target] || 1}</p>${button("重新读取配置", "reload-config", "ghost")}</div>` +
    groups
      .map((domain) =>
        section(
          fixture.domains[domain] || domain,
          card(
            fields
              .filter((f) => f.domain === domain)
              .map((f) => {
                const value = draft().fields[f.path];
                const secretAction = state.secretActions[f.path] || "keep";
                const control = f.sensitive
                  ? select(
                      "secret:" + f.path,
                      f.description + "操作",
                      secretAction,
                      [
                        [
                          "keep",
                          config().secrets[f.path]
                            ? "已配置，保留现有值"
                            : "未配置，保持不变",
                        ],
                        ["replace", "替换"],
                        ["delete", "删除"],
                      ],
                    ) +
                    (secretAction === "replace"
                      ? input(
                          "config:" + f.path,
                          f.description,
                          value || "",
                          "password",
                        )
                      : "")
                  : input(
                      "config:" + f.path,
                      f.description,
                      value == null
                        ? ""
                        : typeof value === "string"
                          ? value
                          : JSON.stringify(value),
                    ) +
                    button(
                      "恢复默认",
                      "default-config",
                      "ghost",
                      `data-path="${esc(f.path)}" aria-label="恢复默认 ${esc(f.description)}"`,
                    );
                return (
                  row(
                    f.description,
                    `${esc(f.path)} · ${f.apply === "restart" ? "重启后生效" : "重新加载后生效"}`,
                    `<div class="config-control">${control}</div>`,
                  ) + behavior.fieldStatus(f)
                );
              })
              .join(""),
          ),
        ),
      )
      .join("")
  );
}

function status() {
  return diagnosticsUI.render();
}
function desktop() {
  return diagnosticsUI.desktop();
}
function setField(key, value) {
  if (
    connectionsUI.setField(key, value) ||
    mobileUI.setField(key, value) ||
    diagnosticsUI.setField(key, value) ||
    behavior.setField(key, value)
  )
    return;
  if (key.startsWith("role.")) {
    draft().roles[state.role][key.slice(5)] = value;
    if (key === "role.provider") {
      draft().roles[state.role].model =
        value === "Codex" ? "gpt-6-sol" : "默认模型";
    }
  } else if (key.startsWith("secret:")) {
    const path = key.slice(7);
    state.secretActions[path] = value;
    if (value === "keep") delete draft().fields[path];
    else draft().fields[path] = value === "delete" ? null : "";
  } else if (key.startsWith("config:")) draft().fields[key.slice(7)] = value;
  else draft()[key] = value;
  state.dirty = true;
  state.error = "";
  updateSavebar();
  if (key === "kind" || key === "role.provider" || key.startsWith("secret:")) {
    const scroll = $("#content").scrollTop;
    render();
    $("#content").scrollTop = scroll;
  }
}
function updateSavebar() {
  const save = $('[data-action="save"]');
  if (save)
    save.disabled =
      !state.dirty ||
      offline() ||
      state.busy ||
      (state.page === "connections" && !connectionsUI.canSave()) ||
      (state.page === "advanced" &&
        (state.configDiskError ||
          (state.tab === "models" && behavior.modelError())));
  const reset = $('[data-action="reset"]');
  if (reset) reset.disabled = !state.dirty;
  const label = $(".save-label");
  if (label)
    label.textContent = state.dirty ? "有未保存的修改" : "所有修改已保存";
}
function validate() {
  if (state.page === "advanced" && state.tab === "models")
    return behavior.modelError();
  if (state.page === "connections") {
    if (!draft().name.trim()) return "请填写连接名称。";
    try {
      if (!["http:", "https:"].includes(new URL(draft().endpoint).protocol))
        return "Backend 地址需要使用 HTTP 或 HTTPS。";
    } catch {
      return "请填写有效的 Backend 地址。";
    }
    if (
      draft().kind === "SSH" &&
      (!draft().host.trim() ||
        !draft().username.trim() ||
        !(Number(draft().port) > 0 && Number(draft().port) < 65536))
    )
      return "请填写 SSH 主机、用户和有效端口。";
  }
  if (state.page === "suiji") {
    try {
      if (!["http:", "https:"].includes(new URL(draft().endpoint).protocol))
        return "请输入 HTTP 或 HTTPS 服务地址。";
    } catch {
      return "请输入有效的服务地址。";
    }
  }
  if (
    state.page === "access" &&
    (!draft().oldPassword ||
      !draft().password ||
      draft().password !== draft().repeat)
  )
    return "请输入当前密码与新密码，并确保两次新密码一致。";
  if (state.page === "advanced" && state.tab !== "models") {
    for (const f of fixture.fields) {
      const v = draft().fields[f.path];
      if (f.sensitive) {
        if (state.secretActions[f.path] === "replace" && !v)
          return "替换凭据时请填写新值；删除请使用删除选项。";
        continue;
      }
      if (v == null || v === "" || f.type === "string") continue;
      let parsed;
      try {
        parsed = typeof v === "string" ? JSON.parse(v) : v;
      } catch {
        return `${f.description}格式不正确。`;
      }
      if (f.type === "boolean" && typeof parsed !== "boolean")
        return `${f.description}需要 true 或 false。`;
      if (
        f.type.startsWith("array") &&
        (!Array.isArray(parsed) || parsed.some((x) => typeof x !== "string"))
      )
        return `${f.description}需要 JSON 字符串数组。`;
      if (
        /number|integer/.test(f.type) &&
        (typeof parsed !== "number" ||
          !Number.isFinite(parsed) ||
          (f.type === "integer" && !Number.isInteger(parsed)))
      )
        return `${f.description}需要有效的${f.type === "integer" ? "整数" : "数字"}。`;
    }
  }
  return "";
}
function save() {
  if (
    !state.dirty ||
    offline() ||
    requiresLogin() ||
    (state.busy && !state.commitReady)
  )
    return;
  if (state.page === "connections") {
    connectionsUI.save();
    return;
  }
  const error = validate();
  if (error) {
    state.error = error;
    $("#form-error").textContent = error;
    $("#form-error").hidden = false;
    return;
  }
  if (behavior.beforeSave()) return;
  if (state.scenario === "conflict" && !state.conflictHandled) {
    confirm(
      "配置已在其他位置修改",
      "当前输入已保留。重新读取后，可核对最新配置再修改。",
      () => {
        state.conflictHandled = true;
        prepare();
        render();
      },
      "重新读取",
    );
    return;
  }
  let message = "修改已保存";
  if (state.page === "notifications") state.notifications = draft().enabled;
  if (state.page === "suiji")
    state.accounts[state.environment] = clone(draft());
  if (state.page === "monitoring") {
    Object.assign(config(), {
      monitor: draft().monitor,
      alerts: draft().alerts,
      remoteControl: draft().remoteControl,
    });
  }
  if (state.page === "advanced") {
    if (state.tab === "models") {
      config().roles = clone(draft().roles);
      message = "全部角色默认配置已保存";
    } else {
      for (const f of fixture.fields) {
        if (f.sensitive) {
          if (state.secretActions[f.path] === "replace")
            config().secrets[f.path] = true;
          if (state.secretActions[f.path] === "delete")
            config().secrets[f.path] = false;
        } else {
          const v = draft().fields[f.path];
          config().fields[f.path] =
            v == null || v === ""
              ? null
              : f.type === "string" || typeof v !== "string"
                ? v
                : JSON.parse(v);
        }
      }
      state.revisions[state.target] = (state.revisions[state.target] || 1) + 1;
      state.pending[state.target] = true;
      message = "配置已保存，等待所属服务重新加载或重启";
    }
  }
  if (state.page === "connections") {
    if (state.detail === "new") {
      const id = "connection-" + Date.now();
      state.connections.push({ ...clone(draft()), id, online: true });
      state.computer[id] = clone(fixture.computer.local);
      state.resources[id] = clone(fixture.resources);
      state.devResource[id] = false;
      state.approvals[id] = false;
    } else
      Object.assign(
        state.connections.find((c) => c.id === state.detail),
        clone(draft()),
      );
    state.detail = null;
    history.replaceState({}, "", "#/connections");
  }
  if (state.page === "access") {
    state.reauth[state.target] = true;
    message = "登录密码已更新，请重新登录";
  }
  prepare();
  render();
  notification(message);
}
function download(name, payload) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function action(action, el) {
  if (state.busy) return;
  if (
    connectionsUI.action(action, el) ||
    mobileUI.action(action, el) ||
    diagnosticsUI.action(action, el) ||
    behavior.action(action, el)
  )
    return;
  switch (action) {
    case "workspace":
      navigate("workspace");
      break;
    case "settings":
      navigate("appearance");
      break;
    case "confirm":
      $("#confirm").close();
      {
        const fn = state.confirm;
        state.confirm = null;
        fn?.();
      }
      break;
    case "dismiss":
      $("#confirm").close();
      state.confirm = null;
      break;
    case "default-config":
      draft().fields[el.dataset.path] = null;
      state.dirty = true;
      render();
      break;
    case "reload-config":
      guard(() => {
        prepare();
        render();
        notification("已重新读取配置");
      });
      break;
    case "edit-account":
      draft().loggedIn = false;
      render();
      break;
    case "logout-account":
      confirm(
        "退出当前随记账户？",
        "保留服务地址、账号和该环境的草稿。",
        () => {
          state.accounts[state.environment].loggedIn = false;
          prepare();
          render();
        },
        "退出账户",
      );
      break;
    case "login-account": {
      const error =
        validate() ||
        (!draft().username.trim() || !draft().password
          ? "请输入账号和密码。"
          : "");
      if (error) {
        state.error = error;
        render();
        break;
      }
      state.accounts[state.environment] = {
        endpoint: draft().endpoint,
        username: draft().username.trim(),
        loggedIn: true,
      };
      prepare();
      render();
      notification("已登录随记");
      break;
    }
    case "reauth":
      if (offline()) break;
      if (!draft().username.trim() || !draft().password) {
        state.error = "请输入用户名和密码。";
        render();
        break;
      }
      state.reauth[state.target] = false;
      prepare();
      render();
      notification("已重新登录");
      break;
    case "save":
      save();
      break;
    case "reset":
      guard(() => {
        prepare();
        render();
      });
      break;
    case "reconnect":
      target().online = true;
      render();
      notification("连接已恢复");
      break;
    case "connection-list":
      navigate("connections");
      break;
    case "new-connection":
      navigate("connections", { detail: "new" });
      break;
    case "edit-connection":
      navigate("connections", { detail: el.dataset.id });
      break;
    case "delete-connection":
      confirm(
        "删除这条连接？",
        "只移除已保存的连接定义，不删除远端项目或终端。",
        () => {
          state.connections = state.connections.filter(
            (c) => c.id !== state.detail,
          );
          if (state.target === state.detail) state.target = "local";
          state.dirty = false;
          navigate("connections");
          notification("连接已删除");
        },
        "删除连接",
      );
      break;
    case "approve-mobile":
    case "deny-mobile":
      if (!offline()) {
        state.approvals[state.target] = false;
        render();
        notification(
          action === "approve-mobile" ? "已允许此手机登录" : "已拒绝此请求",
        );
      }
      break;
    case "open-advanced":
      navigate("advanced", { tab: "instance" });
      break;
    case "refresh":
      notification("资源状态已刷新");
      break;
    case "end-process":
      confirm(
        `结束 ${el.dataset.name}？`,
        `此操作将结束 ${target().name} 上的该应用进程。`,
        () => {
          state.resources[state.target] = state.resources[state.target].filter(
            (r) => r[0] !== el.dataset.name,
          );
          render();
          notification("进程已结束");
        },
        "结束进程",
      );
      break;
    case "release-resource":
      confirm(
        "释放开发资源？",
        `将释放 ${target().name} 上的空闲模拟器。`,
        () => {
          state.devResource[state.target] = false;
          render();
          notification("资源已释放");
        },
        "释放资源",
      );
      break;
    case "record-logs":
      state.recording[state.target] = !state.recording[state.target];
      if (!state.recording[state.target]) state.logReady[state.target] = true;
      render();
      break;
    case "download-logs":
      download("runweave-prototype-logs.json", {
        prototype: true,
        computer: target().name,
        events: ["记录开始", "记录结束"],
      });
      break;
    case "download-desktop":
      download("runweave-prototype-desktop.json", {
        prototype: true,
        scope: "本台桌面",
        channel: "Stable",
      });
      break;
    case "reload-runtime":
      confirm(
        "重新加载本机运行时？",
        "本台桌面连接将暂时中断。远端电脑不会重新加载。",
        () => notification("本机运行时已重新加载"),
        "重新加载",
      );
      break;
    case "ws-menu":
      $("#workspace-menu").hidden = !$("#workspace-menu").hidden;
      break;
    case "ws-history":
      $("#workspace-menu").hidden = true;
      showWorkspaceContext(
        "终端历史",
        "桌面页面重构 · wt-1\n\n已读取项目结构与设置入口。\n正在整理全局设置的作用范围。",
      );
      break;
    case "ws-status":
      $("#workspace-menu").hidden = true;
      showWorkspaceContext(
        "当前终端状态",
        "桌面页面重构\nAgent: Codex\nState: idle\nWorktree: wt-1",
      );
      break;
  }
}
function showWorkspaceContext(title, body) {
  $("#workspace-preview").innerHTML =
    `<div class="context-content"><h2>${esc(title)}</h2><p style="white-space:pre-wrap;margin-top:20px">${esc(body)}</p>${button("返回 Preview", "ws-preview", "ghost")}</div>`;
}
function applyTheme() {
  const resolved =
    state.theme === "system"
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : state.theme;
  document.documentElement.dataset.theme = resolved;
}
function renderWorkspace() {
  $("#workspace").innerHTML =
    `<header class="ws-header"><button data-action="settings" aria-label="全局设置">${icon("menu")}</button><span><i class="dot"></i> 本机 Mac⌄</span><span class="project">browser-viewer ×</span><span>＋</span><span class="spacer"></span><div class="ws-shortcuts">${[["zap", "快捷指令"], ["server", "Services"], ["notebook", "随记"], ["calendar", "定时任务"], ["activity", "运行状态"]].map(([glyph, label]) => `<button class="ws-shortcut" type="button" aria-label="${label}" title="${label}">${icon(glyph)}</button>`).join("")}<button class="ws-shortcut" data-action="ws-menu" aria-label="终端菜单" title="更多操作">${icon("more")}</button></div></header><div class="ws-body"><aside class="ws-rail"><small>WORKTREES</small>${["main", "wt-1", "wt-2"].map((t) => `<button class="worktree ${state.worktree === t ? "active" : ""}" data-worktree="${t}">${t}<small>${t === "wt-1" ? "detached · 2 terminals" : "main"}</small></button>`).join("")}</aside><section class="ws-main"><div class="sessions"><span><i class="dot"></i> 桌面页面重构</span><span>＋</span></div><div class="ws-split"><section class="terminal"><div class="transcript"><strong>› OpenAI Codex</strong><br>model: gpt-6-sol · high<br>directory: ~/Code/browser-viewer/.worktree/wt-1<br><br><strong>› 调整桌面全局设置的分类与交互。</strong><br><br>已核对设置入口与配置归属。<br>项目、终端与右侧工具区保持原位置。<br><br>✓ 当前任务已完成范围梳理<br>✓ 浏览器交互保持现状<br><br>等待下一条消息</div><textarea aria-label="终端输入" id="terminal-input" placeholder="输入消息…">${esc(state.composer)}</textarea><div class="composer-info">Codex · gpt-6-sol · high <span style="float:right">Full access</span></div></section><aside class="ws-tools"><div class="tool-tabs">${state.tools
      .filter((t) => state.visibleTools.includes(t))
      .map(
        (t) =>
          `<button data-ws-tool="${t}" class="${state.tool === t ? "active" : ""}">${t}</button>`,
      )
      .join(
        "",
      )}</div><div id="workspace-preview"></div></aside></div><footer class="ws-foot">${state.worktree} / 桌面页面重构</footer></section></div><div id="workspace-menu" class="workspace-menu" hidden><button data-action="ws-history">终端历史与输出</button><button data-action="ws-status">当前终端状态</button></div>`;
  renderWorkspacePreview();
}
function renderWorkspacePreview() {
  if (state.tool === "Preview")
    $("#workspace-preview").innerHTML =
      '<div class="preview"><h3>frontend/src/components/terminal/workspace/header.tsx</h3><pre>export function TerminalWorkspaceHeader() {\n  const runtime = useTerminalRuntime();\n\n  return (\n    &lt;header&gt;\n      &lt;TerminalAppMenu /&gt;\n      &lt;ConnectionSwitcher /&gt;\n      &lt;ProjectTabs /&gt;\n    &lt;/header&gt;\n  );\n}</pre></div>';
  else
    $("#workspace-preview").innerHTML =
      `<div class="context-content"><h2>${esc(state.tool)}</h2><p style="margin-top:15px">${state.tool.startsWith("Browser") ? esc(state.browserUrl || "localhost:5173") : state.tool === "Agent Team" ? "当前终端 · 桌面页面重构" : "当前工作区 · wt-1"}</p></div>`;
}
function bind() {
  document.addEventListener("keydown", (event) => {
    if (
      event.key !== "Enter" ||
      event.target.tagName !== "INPUT" ||
      event.target.type === "checkbox" ||
      state.busy ||
      $("#confirm").open
    )
      return;
    if (requiresLogin()) {
      event.preventDefault();
      action("auth-login", event.target);
    } else if (state.page === "suiji" && !draft().loggedIn) {
      event.preventDefault();
      action("login-account", event.target);
    } else if (
      (state.page === "connections" && state.detail) ||
      (state.page === "access" && state.tab === "password")
    ) {
      event.preventDefault();
      save();
    }
  });
  document.addEventListener("click", (event) => {
    if (state.busy) {
      event.preventDefault();
      return;
    }
    const page = event.target.closest("[data-page]");
    if (page) {
      event.preventDefault();
      navigate(page.dataset.page);
      return;
    }
    const theme = event.target.closest("[data-theme]");
    if (theme?.tagName === "BUTTON") {
      state.theme = theme.dataset.theme;
      applyTheme();
      behavior.persist();
      render();
      return;
    }
    const tab = event.target.closest("[data-tab]");
    if (tab) {
      guard(() => {
        if (state.page === "access" && state.tab === "mobile")
          mobileUI.cancel();
        state.detail = null;
        state.tab = tab.dataset.tab;
        prepare();
        render();
      });
      return;
    }
    const role = event.target.closest("[data-role]");
    if (role) {
      state.role = role.dataset.role;
      state.modelSearch = "";
      render();
      return;
    }
    const env = event.target.closest("[data-environment]");
    if (env) {
      guard(() => {
        state.environment = env.dataset.environment;
        prepare();
        render();
      });
      return;
    }
    const move = event.target.closest("[data-move]");
    if (move && !move.disabled) {
      const i = Number(move.dataset.move),
        j = i + Number(move.dataset.delta);
      [state.tools[i], state.tools[j]] = [state.tools[j], state.tools[i]];
      behavior.persist();
      const scroll = $("#content").scrollTop;
      render();
      $("#content").scrollTop = scroll;
      return;
    }
    const tree = event.target.closest("[data-worktree]");
    if (tree) {
      state.worktree = tree.dataset.worktree;
      renderWorkspace();
      return;
    }
    const tool = event.target.closest("[data-ws-tool]");
    if (tool) {
      state.tool = tool.dataset.wsTool;
      renderWorkspace();
      return;
    }
    const el = event.target.closest("[data-action]");
    if (el && !el.disabled) {
      if (el.dataset.action === "ws-preview") {
        state.tool = "Preview";
        renderWorkspacePreview();
      } else action(el.dataset.action, el);
    }
  });
  document.addEventListener("input", (event) => {
    const el = event.target;
    if (el.id === "terminal-input") state.composer = el.value;
    else if (
      el.dataset.field &&
      el.type !== "checkbox" &&
      el.tagName !== "SELECT"
    )
      setField(el.dataset.field, el.value);
  });
  document.addEventListener("change", (event) => {
    const el = event.target;
    if (el.id === "settings-target") {
      switchTarget(el.value);
      return;
    }
    if (el.dataset.tool) {
      const t = el.dataset.tool;
      if (el.checked) state.visibleTools.push(t);
      else if (state.visibleTools.length > 1)
        state.visibleTools = state.visibleTools.filter((x) => x !== t);
      else {
        el.checked = true;
        notification("至少保留一个工具标签");
      }
      behavior.persist();
      return;
    }
    if (el.dataset.field && (el.type === "checkbox" || el.tagName === "SELECT"))
      setField(
        el.dataset.field,
        el.type === "checkbox" ? el.checked : el.value,
      );
  });
  addEventListener("popstate", () => {
    const [page, detail] = location.hash.slice(2).split("/");
    if (state.dirty)
      history.pushState(
        {},
        "",
        `#/${state.page}${state.detail ? "/" + state.detail : ""}`,
      );
    navigate(page || "appearance", {
      detail: detail || null,
      historyMode: "replace",
    });
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (state.theme === "system") applyTheme();
  });
}
fetch("./mock-state.json")
  .then((r) => {
    if (!r.ok) throw Error("无法读取页面数据");
    return r.json();
  })
  .then((data) => {
    fixture = data;
    const params = new URLSearchParams(location.search),
      [requested, detail] = location.hash.slice(2).split("/");
    state = {
      page:
        fixture.pages.some((p) => p.id === requested) ||
        requested === "workspace"
          ? requested
          : "appearance",
      target: "local",
      theme: fixture.theme,
      notifications: true,
      tools: clone(fixture.tools),
      visibleTools: clone(fixture.visibleTools),
      connections: clone(fixture.connections),
      computer: clone(fixture.computer),
      accounts: clone(fixture.accounts),
      environment: "production",
      role: "主 Agent",
      tab: "",
      detail: detail || null,
      draft: null,
      dirty: false,
      error: "",
      busy: false,
      operations: [],
      pending: {},
      revisions: {},
      secretActions: {},
      reauth: {},
      approvals: { local: true, dev: false },
      resources: {
        local: clone(fixture.resources),
        dev: clone(fixture.resources),
      },
      devResource: { local: true, dev: true },
      recording: {},
      logReady: {},
      scenario: params.get("state"),
      composer: "",
      worktree: "wt-1",
      tool: "Preview",
    };
    initializeDetails(params);
    if (params.get("remoteControl") === "allowed")
      state.computer.dev.remoteControl = true;
    if (state.scenario === "offline") state.connections[0].online = false;
    if (state.scenario === "empty") {
      state.connections = state.connections.filter((c) => c.id === "local");
      state.approvals.local = false;
      state.devResource.local = false;
    }
    if (
      state.page !== "connections" ||
      (state.detail !== "new" &&
        !state.connections.some((c) => c.id === state.detail))
    )
      state.detail = null;
    state.tab =
      state.page === "connections"
        ? "saved"
        : state.page === "advanced"
          ? "models"
          : state.page === "status"
            ? "runtime"
            : state.page === "access"
              ? "password"
              : "";
    if (params.get("tab")) state.tab = params.get("tab");
    prepare();
    applyTheme();
    renderWorkspace();
    bind();
    render();
  })
  .catch((error) => {
    $("#content").innerHTML =
      `<div class="content-wrap"><h1>无法加载设置</h1><p>${esc(error.message)}</p></div>`;
  });

function initializeDetails(params) {
  const usedFaults = new Set();
  const ui = {
    state,
    fixture,
    params,
    esc,
    button,
    row,
    card,
    section,
    field,
    select,
    toggle,
    tabs,
    target,
    config,
    offline,
    prepare,
    render,
    updateSavebar,
    navigate,
    guard,
    confirm,
    notify: notification,
    applyTheme,
    validate,
    commit: save,
    download,
    desktopAvailable: () => params.get("host") !== "web",
    delay: (ms = 450) => new Promise((resolve) => setTimeout(resolve, ms)),
    fault: (name) => {
      if (params.get("fault") !== name || usedFaults.has(name)) return false;
      usedFaults.add(name);
      return true;
    },
    run: async (fn) => {
      if (state.busy) return;
      state.busy = true;
      state.error = "";
      render();
      try {
        await fn();
      } catch (error) {
        state.error = error.message || String(error);
      } finally {
        state.busy = false;
        render();
      }
    },
    copy: async (text) => {
      try {
        await navigator.clipboard.writeText(text);
        notification("已复制");
      } catch {
        state.error = "无法访问剪贴板，请重试。";
        render();
      }
    },
    openBrowser: (url, profileId = "profile-1") => {
      state.operations.push({
        operation: "openBrowser",
        url,
        profileId,
        placement: "new-group",
      });
      state.browserUrl = url;
      state.tool = `Browser ${profileId.slice(-1)}`;
      if (!state.visibleTools.includes(state.tool))
        state.visibleTools.push(state.tool);
      navigate("workspace");
    },
  };
  connectionsUI = createConnections(ui);
  mobileUI = createMobile(ui);
  diagnosticsUI = createDiagnostics(ui);
  behavior = createSettingsBehavior(ui);
  connectionsUI.init();
  mobileUI.init();
  diagnosticsUI.init();
  behavior.init();
  diagnosticsUI.scenario();
  // The helper is hidden and read-only; it exposes only mock event identities for verification.
  Object.defineProperty(window, "prototypeEvidence", {
    value: () =>
      structuredClone({
        operations: state.operations,
        hosts: state.hosts,
        mobile: state.mobile,
        computer: state.computer,
      }),
    writable: false,
  });
}
