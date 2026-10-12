/* Standalone interaction prototype. All changes are in-memory fixture changes. */
const $ = (selector, root = document) => root.querySelector(selector);
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const paths = {
  menu: "M4 6h16M4 12h16M4 18h16",
  back: "M15 5l-7 7 7 7M8 12h12",
  chevron: "M9 5l7 7-7 7",
  down: "M6 9l6 6 6-6",
  plus: "M12 5v14M5 12h14",
  check: "M5 12l4 4L19 6",
  close: "M6 6l12 12M18 6L6 18",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  monitor: "M3 4h18v13H3zM8 21h8M12 17v4",
  phone: "M7 2h10v20H7zM11 18h2",
  network: "M4 5h6v5H4zM14 14h6v5h-6zM7 10v7h7",
  activity: "M2 12h4l3-8 6 16 3-8h4",
  history: "M4 5v5h5M4 10a8 8 0 118 10M12 7v5l3 2",
  notebook: "M5 3h15v18H5zM2 7h5M2 12h5M2 17h5M10 8h6M10 12h6",
  file: "M5 3h9l5 5v13H5zM14 3v5h5M9 12h6M9 16h6",
  layers: "M12 3l10 5-10 5L2 8zM2 12l10 5 10-5M2 16l10 5 10-5",
  zap: "M13 2L4 14h7l-1 8 10-13h-7z",
  calendar: "M4 5h16v16H4zM4 10h16M8 2v6M16 2v6",
  play: "M7 4l14 8-14 8z",
  sparkles: "M12 3l2 6 6 3-6 2-2 7-3-7-6-2 6-3zM20 2v4M18 4h4",
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  search: "M21 21l-5-5M18 10a8 8 0 11-16 0 8 8 0 0116 0",
  user: "M16 7a4 4 0 11-8 0 4 4 0 018 0M4 21v-2a8 8 0 0116 0v2",
  sun: "M16 12a4 4 0 11-8 0 4 4 0 018 0M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1 1M18 18l1 1M5 19l1-1M18 6l1-1",
  globe:
    "M22 12a10 10 0 11-20 0 10 10 0 0120 0M2 12h20M12 2c6 6 6 14 0 20-6-6-6-14 0-20",
  bell: "M5 16h14l-2-3V8a5 5 0 00-10 0v5zM10 20h4",
  database:
    "M20 5c0 4-16 4-16 0s16-4 16 0v14c0 4-16 4-16 0V5M4 12c0 4 16 4 16 0",
  sliders: "M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6",
  keyboard:
    "M2 5h20v14H2zM6 9h.1M10 9h.1M14 9h.1M18 9h.1M6 13h.1M10 13h.1M14 13h.1M18 13h.1M8 16h8",
  server: "M3 3h18v7H3zM3 14h18v7H3zM7 6h.1M7 17h.1",
  shield: "M12 2l9 4v6c0 5-9 10-9 10S3 17 3 12V6zM8 12l3 3 5-6",
  gauge: "M4 19a10 10 0 1116 0M12 13l5-6M10 17h4",
  trash: "M3 6h18M8 6V3h8v3M5 6l1 15h12l1-15M10 10v7M14 10v7",
  branch: "M6 3v14a3 3 0 103 3M6 12h6a6 6 0 006-6V3",
  terminal: "M4 5l7 7-7 7M13 19h7",
  arrow: "M12 19V5M6 11l6-6 6 6",
  external: "M14 3h7v7M21 3L10 14M10 3H3v18h18v-7",
  copy: "M9 9h12v12H9zM5 15H2V2h13v3",
  refresh: "M20 7V2l-4 4M4 17v5l4-4M20 7a9 9 0 00-16 2M4 17a9 9 0 0016-2",
  lock: "M5 10h14v12H5zM8 10V6a4 4 0 018 0v4",
  folder: "M3 6h7l2 3h9v12H3z",
};
const icon = (name = "grid") =>
  `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.grid}"/></svg>`;
const btn = (text, action, style = "", data = "") =>
  `<button class="btn ${style}" data-action="${action}" ${data}>${escape(text)}</button>`;
const link = (id, text, cls = "") =>
  `<a href="#/${escape(id)}" data-route="${escape(id)}" class="${cls}">${escape(text)}</a>`;
const badge = (status) =>
  `<span class="badge ${/正常|已完成|已连接|已启用|当前连接|可连接|已验证/.test(status) ? "green" : /待|使用中|进行中/.test(status) ? "amber" : ""}">${/正常|已连接|当前连接/.test(status) ? '<i class="dot"></i>' : ""}${escape(status)}</span>`;
let data, state;
let toastTimer, menuTrigger;
const pageFor = (route) =>
  (route === "app"
    ? [{ id: "app", title: "功能与设置", group: "应用", scope: "local" }]
    : data.pages
  )
    .filter((p) => route === p.id || route.startsWith(p.id + "/"))
    .sort((a, b) => b.id.length - a.id.length)[0];
const tailFor = (page) =>
  state.route
    .slice(page.id.length + 1)
    .split("/")
    .filter(Boolean);
const scopeLabel = (page) =>
  ({
    local: "本台桌面",
    connection: `当前连接 · ${state.connection}`,
    project: `${data.workspace.project} / ${state.worktree}`,
    suiji: `随记 · ${state.settings.suijiEnvironment}`,
  })[page.scope];
const isUnavailable = (page) =>
  state.scenario === "offline" && page.scope === "connection";
const values = () => state.draft || state.settings;
function notify(message) {
  clearTimeout(toastTimer);
  $("#toast").innerHTML = icon("check") + escape(message);
  $("#toast").hidden = false;
  toastTimer = setTimeout(() => ($("#toast").hidden = true), 2800);
}
function confirmAction(title, message, label, action) {
  closeMenu();
  const dialog = $("#confirmation");
  dialog.innerHTML = `<h2 id="confirmation-title">${escape(title)}</h2><p>${escape(message)}</p><div class="actions">${btn("取消", "dialog-cancel")}${btn(label, "dialog-confirm", "primary")}</div>`;
  state.confirm = action;
  dialog.showModal();
}
function leaveGuard(action) {
  if (!state.dirty) {
    action();
    return;
  }
  confirmAction(
    "放弃未保存的修改？",
    "本页修改尚未保存。返回后，已保存的配置仍会保留。",
    "放弃修改",
    () => {
      state.dirty = false;
      state.draft = null;
      action();
    },
  );
}
function navigate(route, { replace = false, fromBrowser = false } = {}) {
  leaveGuard(() => {
    if (!pageFor(route) && route !== "workspace") route = "workspace";
    const sameCategory =
      pageFor(state.route)?.group === pageFor(route)?.group &&
      state.route === pageFor(state.route)?.id &&
      route === pageFor(route)?.id;
    if (state.route !== route && !replace && !sameCategory)
      state.trail.push({
        route: state.route,
        scroll: $(".page-scroll")?.scrollTop || 0,
      });
    if (route === "app") state.trail = [{ route: "workspace", scroll: 0 }];
    state.route = route;
    state.draft = null;
    state.dirty = false;
    closeMenu();
    if (!fromBrowser)
      history[replace ? "replaceState" : "pushState"]({}, "", `#/${route}`);
    render();
  });
}
function back() {
  leaveGuard(() => {
    const prev = state.trail.pop() || { route: "workspace", scroll: 0 };
    state.route = prev.route;
    state.draft = null;
    state.dirty = false;
    history.pushState({}, "", `#/${state.route}`);
    render();
    if ($(".page-scroll")) $(".page-scroll").scrollTop = prev.scroll;
  });
}
function closeMenu() {
  const pop = $("#popover");
  pop.hidden = true;
  menuTrigger?.setAttribute("aria-expanded", "false");
}
function menuItem(id, label) {
  const p = pageFor(id);
  return `<a class="menu-item" role="menuitem" href="#/${id}" data-route="${id}">${icon(p?.icon)}<span>${escape(label || p?.title || id)}</span>${icon("chevron")}</a>`;
}
function openMenu(kind, trigger) {
  if (kind === "app") {
    navigate("app");
    return;
  }
  const pop = $("#popover");
  if (!pop.hidden && state.menu === kind) {
    closeMenu();
    return;
  }
  state.menu = kind;
  menuTrigger = trigger;
  trigger?.setAttribute("aria-expanded", "true");
  pop.style.left = "8px";
  pop.style.right = "auto";
  pop.style.top = (state.route === "workspace" ? 73 : 95) + "px";
  let html = "";
  if (kind === "connection") {
    html = `<div class="compact-menu" role="menu" aria-label="切换连接"><div class="menu-help">切换连接</div>${data.pages
      .find((p) => p.id === "connections")
      .items.map(
        (i) =>
          `<button class="menu-item" data-action="switch-connection" data-value="${escape(i.title)}">${icon("monitor")}<span>${escape(i.title)}</span><span class="spacer"></span>${state.connection === i.title ? icon("check") : ""}</button>`,
      )
      .join(
        "",
      )}<div class="divider"></div>${["mobile", "quota", "connections"].map((id) => menuItem(id)).join("")}</div>`;
  } else if (kind === "quick") {
    pop.style.left = "auto";
    pop.style.right = "14px";
    html = `<div class="compact-menu" role="menu" aria-label="快捷指令"><div class="menu-help">${escape(data.workspace.project)} / ${escape(state.worktree)}</div>${data.pages
      .find((p) => p.id === "commands")
      .items.map(
        (i) =>
          `<button class="menu-item" data-action="quick-insert" data-id="${i.id}">${icon("zap")}${escape(i.title)}<span class="spacer"></span>${icon("arrow")}</button>`,
      )
      .join(
        "",
      )}<div class="divider"></div>${menuItem("commands", "管理快捷指令")}${menuItem("runs")}</div>`;
  } else if (kind === "tools") {
    pop.style.left = "auto";
    pop.style.right = "12px";
    html = `<div class="compact-menu" role="menu" aria-label="右侧工具">${data.workspace.tools.map((t) => `<button class="menu-item" data-action="tool" data-value="${escape(t)}">${icon(t.startsWith("Browser") ? "globe" : "layers")}${escape(t)}${state.tool === t ? icon("check") : ""}</button>`).join("")}<div class="divider"></div>${menuItem("settings/appearance", "管理工具标签")}</div>`;
  } else if (kind === "services") {
    pop.style.left = "auto";
    pop.style.right = "40px";
    html = `<div class="compact-menu"><div class="menu-help">${escape(data.workspace.project)} / ${escape(state.worktree)}</div><div class="setting-row"><div><strong>Frontend</strong><p>localhost:5173</p></div>${badge(state.serviceRunning ? "运行中" : "已停止")}</div>${btn(state.serviceRunning ? "停止服务" : "启动服务", "service-toggle")}${menuItem("dev-resources", "查看开发资源")}</div>`;
  } else {
    pop.style.left = "auto";
    pop.style.right = "8px";
    html = `<div class="compact-menu" role="menu" aria-label="当前会话操作"><div class="menu-help">${escape(state.session)}</div><button class="menu-item" data-action="tool" data-value="会话阅读">${icon("notebook")}阅读会话</button><button class="menu-item" data-action="output">${icon("copy")}复制终端输出</button><button class="menu-item" data-action="share">${icon("external")}分享终端快照</button><button class="menu-item" data-action="recover">${icon("refresh")}恢复 Agent</button><button class="menu-item" data-action="fork">${icon("branch")}Fork Thread</button><div class="divider"></div>${menuItem("prototypes")}</div>`;
  }
  pop.innerHTML = html;
  pop.hidden = false;
  pop.querySelector("a,button")?.focus();
}
function renderWorkspace() {
  const w = data.workspace;
  $("#workspace").innerHTML = `
 <header class="workspace-header"><button class="icon-btn" data-menu="app" aria-label="应用菜单">${icon("menu")}</button><button class="connection-button" data-menu="connection" aria-label="当前连接"><i class="dot"></i><span id="connection-label">${escape(state.connection)}</span>${icon("down")}</button><button class="project-tab" data-action="project">${escape(w.project)}<span class="faint">×</span></button><button class="icon-btn" data-action="project-new" aria-label="新建项目">${icon("plus")}</button><span class="spacer"></span><button class="header-action" data-menu="quick" aria-label="快捷指令">${icon("zap")}<span>快捷指令</span></button><button class="header-action" data-menu="services" aria-label="开发服务">${icon("server")}<span>Services</span></button><button class="header-action" data-route="notes" aria-label="随记">${icon("notebook")}</button><button class="header-action" data-route="schedules" aria-label="定时任务">${icon("calendar")}</button><button class="header-action" data-route="runtime" aria-label="运行状态"><i class="dot"></i></button><button class="icon-btn" data-menu="more" aria-label="更多操作">${icon("more")}</button></header>
 <div class="workspace-body"><aside class="worktrees"><div class="rail-label">WORKTREES<span>‹</span></div>${["main", "wt-1", "wt-2"].map((t, i) => `<button class="worktree ${state.worktree === t ? "active" : ""}" data-action="worktree" data-value="${t}"><strong>${icon("branch")}${t}${t === "wt-1" ? '<span class="spacer"></span><i class="dot"></i>' : ""}</strong><small>${["main", "detached · 2 terminals", "fix/ios-connection"][i]}</small></button>`).join("")}<div class="rail-foot">browser-viewer<br><span>本地工作区</span></div></aside><div class="working-area"><div class="session-bar">${w.sessions.map((s) => `<button class="session ${state.session === s ? "active" : ""}" data-action="session" data-value="${escape(s)}"><i class="dot"></i>${escape(s)}<span class="faint">×</span></button>`).join("")}<button class="icon-btn" data-action="new-session" aria-label="新建终端">${icon("plus")}</button></div><div class="terminal-and-sidecar"><section class="terminal-pane"><div class="terminal-transcript" id="transcript"><div class="terminal-brand"><strong>› OpenAI Codex</strong><br><span class="faint">model: gpt-6-sol · high</span><br><span class="faint">directory: ~/Code/browser-viewer/.worktree/${escape(state.worktree)}</span></div><p class="user-line">› 整理桌面端的菜单和二级页面，保持项目、终端和右侧布局。</p><p>我先检查现有的页面路由和工作区入口。</p><p class="task-step">✓ 已读取 frontend/src/App.tsx<br>✓ 已检查 workspace/header.tsx<br>✓ 已核对设置与功能页面</p><pre>frontend/src/<br>  pages/                 页面路由<br>  features/              功能模块<br>  components/terminal/   终端工作区</pre><p>设置按主题组织，功能页保留各自的业务流程。<br>返回工作区时恢复当前项目和会话。</p><p class="faint">• 等待下一条消息</p></div><div class="composer"><textarea id="composer" aria-label="终端输入" placeholder="输入消息…">${escape(state.composer)}</textarea><div class="composer-bottom"><span>Codex</span><span>·</span><span>gpt-6-sol</span><span>· high</span><span>Full access</span><button class="send" data-action="send" aria-label="发送">${icon("arrow")}</button></div></div></section><aside class="sidecar" aria-label="右侧工具区"><div class="tool-tabs">${data.workspace.visibleTools.map((t) => `<button class="${state.tool === t ? "active" : ""}" data-action="tool" data-value="${escape(t)}">${escape(t)}</button>`).join("")}<span class="spacer"></span><button data-menu="tools" aria-label="管理右侧工具">${icon("sliders")}</button></div><div id="sidecar-body" style="display:flex;flex-direction:column;flex:1;min-height:0"></div></aside></div><footer class="workspace-footer"><span>${escape(state.worktree)} / ${escape(state.session)}</span><span>UTF-8 · tmux</span></footer></div></div>`;
  renderSidecar();
}
function renderSidecar() {
  const target = $("#sidecar-body");
  if (!target) return;
  const t = state.tool;
  if (t === "Preview")
    target.innerHTML = `<div class="file-toolbar">${icon("file")}<span>frontend/src/pages/terminal-page.tsx</span><span class="spacer"></span><span>TSX</span></div><div class="code-view">${data.workspace.code.map((line, i) => `<div class="code-line"><span class="line-number">${i + 1}</span><span class="${line.startsWith("import") ? "code-key" : line.includes('"') ? "code-string" : ""}">${escape(line)}</span></div>`).join("")}</div><div class="mini-status">TypeScript React<span style="float:right">Ln 1, Col 1</span></div>`;
  else if (t.startsWith("Browser"))
    target.innerHTML = `<div class="file-toolbar">${icon("back")}${icon("refresh")}<span class="grow">localhost:5173</span><button class="icon-btn" data-route="settings/browser" aria-label="浏览器设置">${icon("sliders")}</button></div><div class="preserved-content"><h2>${escape(t)}</h2><p>browser-viewer · 开发页面</p><div class="preserved-row"><span>页面连接</span><i class="dot"></i></div><div class="preserved-row"><span>代理</span><span>Whistle</span></div></div>`;
  else
    target.innerHTML = `<div class="file-toolbar">${icon("layers")}${escape(t)}</div><div class="preserved-content"><h2>${escape(state.session)}</h2><p>${escape(data.workspace.project)} / ${escape(state.worktree)}</p><div class="preserved-row"><span>当前会话</span><span>Codex</span></div><div class="preserved-row"><span>状态</span><span>等待输入</span></div>${t === "Agent Team" ? `<p>${link("settings/models", "Agent Team 模型配置", "text-btn")}</p>` : ""}</div>`;
  document
    .querySelectorAll(".tool-tabs button[data-value]")
    .forEach((b) => b.classList.toggle("active", b.dataset.value === t));
}
function render() {
  const workspace = state.route === "workspace";
  $("#workspace").hidden = !workspace;
  $("#secondary").hidden = workspace;
  document.title = workspace
    ? "Runweave · browser-viewer"
    : `${pageFor(state.route)?.title || "Runweave"} · Runweave`;
  if (workspace) return;
  if (state.route === "app") return renderAppPage();
  renderPage();
}
function renderAppPage() {
  const groups = data.menu
    .map((g) => {
      const entries = g.title === "设置" ? ["settings/appearance"] : g.entries;
      return `<section class="app-section"><h2>${icon(g.icon)}${escape(g.title)}</h2><div class="app-section-links">${entries
        .map((id) => {
          const page = pageFor(id);
          return `<a class="menu-item" href="#/${id}" data-route="${id}">${icon(page.icon)}<span>${escape(g.title === "设置" ? "偏好设置" : page.title)}</span>${icon("chevron")}</a>`;
        })
        .join("")}</div></section>`;
    })
    .join("");
  $("#secondary").innerHTML =
    `<header class="pagebar"><button class="back" data-action="back">${icon("back")}返回工作区</button><span class="bar-divider"></span><span class="crumb">Runweave</span><span class="spacer"></span><span class="scope">${icon("monitor")}${escape(state.connection)}</span></header><div class="page-scroll"><div class="page app-page"><div class="page-head"><div><p class="eyebrow">Runweave</p><h1 tabindex="-1">功能与设置</h1></div><span class="muted">${escape(data.workspace.project)} / ${escape(state.worktree)}</span></div><nav class="app-grid" aria-label="功能与设置">${groups}</nav></div></div>`;
  $("#secondary h1").focus({ preventScroll: true });
}
function header(page, title = page.title, actions = "") {
  return `<div class="page-head"><div><p class="eyebrow">${escape(page.group)}</p><h1 tabindex="-1">${escape(title)}</h1><p class="subtitle">${escape(page.description)}</p></div><div class="flex">${actions}</div></div>`;
}
function section(title, content, caption = "") {
  return `<section class="section"><div class="section-title"><h2>${escape(title)}</h2>${caption ? `<span class="spacer"></span><span class="muted">${escape(caption)}</span>` : ""}</div>${content}</section>`;
}
function settingRow(title, description, control) {
  return `<div class="setting-row"><div><strong>${escape(title)}</strong>${description ? `<p>${escape(description)}</p>` : ""}</div>${control}</div>`;
}
function select(name, options, value = values()[name], label = name) {
  return `<select data-field="${name}" aria-label="${escape(label)}">${options.map((o) => `<option ${o === value ? "selected" : ""}>${escape(o)}</option>`).join("")}</select>`;
}
function input(name, value = values()[name], label = name, type = "text") {
  return `<input data-field="${name}" type="${type}" value="${escape(value)}" aria-label="${escape(label)}">`;
}
function toggle(name, label, value = values()[name]) {
  return `<label class="switch"><input type="checkbox" data-field="${name}" aria-label="${escape(label)}" ${value ? "checked" : ""}><span></span></label>`;
}
function formField(name, label, value = "", type = "text", help = "") {
  return `<div class="field"><label for="field-${name}">${escape(label)}</label>${type === "textarea" ? `<textarea id="field-${name}" data-field="${name}">${escape(value)}</textarea>` : `<input id="field-${name}" data-field="${name}" type="${type}" value="${escape(value)}">`}${help ? `<p>${escape(help)}</p>` : ""}</div>`;
}
function savebar(label = "保存修改") {
  return `<div class="savebar"><small id="save-state">${state.dirty ? "有未保存的修改" : "所有修改已保存"}</small>${btn("取消", "cancel-edit", "ghost")}<button class="btn primary" id="save-button" data-action="save" ${!state.dirty ? "disabled" : ""}>${escape(label)}</button></div>`;
}
function tabs(page) {
  let siblings = data.pages.filter((p) => p.group === page.group);
  if (page.group === "自进化")
    siblings = data.pages.filter((p) => p.group === "自进化");
  if (siblings.length < 2) return "";
  return `<nav class="tabs" aria-label="${escape(page.group)}页面">${siblings.map((p) => link(p.id, p.title, p.id === page.id ? "active" : "")).join("")}</nav>`;
}
function renderPage() {
  const page = pageFor(state.route);
  const tail = tailFor(page);
  const prev = state.trail.at(-1);
  const backLabel =
    prev && prev.route !== "workspace"
      ? pageFor(prev.route)?.title || "上一页"
      : "工作区";
  $("#secondary").innerHTML =
    `<header class="pagebar"><button class="back" data-action="back">${icon("back")}返回${escape(backLabel)}</button><span class="bar-divider"></span><button class="icon-btn" data-menu="app" aria-label="应用菜单">${icon("menu")}</button><span class="crumb">${escape(page.group)}${page.group !== page.title ? " / " + escape(page.title) : ""}</span><span class="spacer"></span><span class="scope">${icon(page.scope === "local" ? "monitor" : page.scope === "suiji" ? "user" : "server")}${escape(scopeLabel(page))}</span></header><div class="page-scroll"></div>`;
  const scroll = $(".page-scroll");
  if (page.kind === "settings") {
    scroll.innerHTML = `<div class="settings-layout"><nav class="settings-nav" aria-label="设置分类"><h2>设置</h2>${data.pages
      .filter((p) => p.kind === "settings")
      .map(
        (p) =>
          `<a href="#/${p.id}" data-route="${p.id}" class="${page.id === p.id ? "active" : ""}">${icon(p.icon)}${escape(p.title)}</a>`,
      )
      .join(
        "",
      )}</nav><div class="settings-content">${header(page)}${settingsBody(page, tail)}</div></div>`;
  } else if (tail[0] === "new" || tail[0] === "edit") {
    scroll.innerHTML = `<div class="page" style="max-width:850px">${editor(page, tail)}</div>`;
  } else if (tail[0] === "detail") {
    scroll.innerHTML = `<div class="page">${detail(page, tail[1])}</div>`;
  } else {
    let actions = page.create
      ? `<a class="btn primary" data-route="${page.id}/new" href="#/${page.id}/new">${icon("plus")}${escape(page.create)}</a>`
      : "";
    if (page.id === "resources")
      actions = link("settings/notifications", "提醒设置", "btn");
    scroll.innerHTML = `<div class="page">${header(page, page.title, actions)}${tabs(page)}${pageBody(page)}</div>`;
  }
  if (isUnavailable(page)) {
    scroll
      .querySelector(".page-head")
      ?.insertAdjacentHTML(
        "afterend",
        `<div class="error-banner">${icon("network")}与 ${escape(state.connection)} 的连接已断开，当前显示上次读取的内容。<span class="spacer"></span>${btn("重新连接", "retry", "ghost")}</div>`,
      );
    scroll
      .querySelectorAll(
        '[data-action="save"], [data-action="terminate"], [data-action="run-command"], [data-action="run-now"]',
      )
      .forEach((b) => (b.disabled = true));
  }
  scroll.querySelector("h1")?.focus({ preventScroll: true });
}
function settingsBody(page, tail) {
  const v =
    page.id === "settings/browser"
      ? state.draft || {
          ...state.settings,
          ...state.profileSettings[state.profile],
        }
      : values();
  if (page.id === "settings/appearance")
    return `<section><h2>主题</h2><p class="subtitle">选择浅色、深色，或跟随系统。</p><div class="theme-grid">${[
      ["light", "浅色"],
      ["dark", "深色"],
      ["system", "跟随系统"],
    ]
      .map(
        ([id, label]) =>
          `<button class="theme-option ${state.settings.theme === id ? "active" : ""}" data-action="theme" data-value="${id}" aria-pressed="${state.settings.theme === id}"><div class="theme-preview ${id}"><span class="theme-lines"><i></i><i></i><i></i><i></i></span></div><span class="theme-label">${label}${state.settings.theme === id ? icon("check") : ""}</span></button>`,
      )
      .join(
        "",
      )}</div></section>${section("右侧工具标签", `<div class="card">${data.workspace.tools.map((t) => settingRow(t, "", `<div class="flex"><button class="icon-btn" data-action="move-tool" data-value="${escape(t)}" aria-label="前移 ${escape(t)}">${icon("back")}</button><label class="switch"><input type="checkbox" data-tool-visible="${escape(t)}" aria-label="显示 ${escape(t)}" ${data.workspace.visibleTools.includes(t) ? "checked" : ""}><span></span></label></div>`)).join("")}</div>`, "显示与排序")}`;
  if (page.id === "settings/account")
    return `${section("当前账户", `<div class="card">${settingRow("登录连接", state.connection, badge("已登录"))}${settingRow("账户", "workspace-user", btn("修改密码", "password", ""))}</div>`)}${state.passwordEditing ? `<div class="card form-grid" style="margin-top:16px">${formField("oldPassword", "当前密码", "", "password")}${formField("newPassword", "新密码", "", "password")}${formField("confirmPassword", "确认新密码", "", "password")}</div>${savebar("修改密码")}` : ""}${section("登录状态", `<div class="card">${settingRow("退出当前连接", "退出后需要重新登录这台电脑。", btn("退出登录", "logout", "danger"))}</div>`)}`;
  if (page.id === "settings/models") {
    const role = state.role;
    const roleValue = state.draft || state.roleSettings[role];
    return `<div class="role-selector" role="tablist" aria-label="Agent Team 角色">${data.roles.map((r) => `<button role="tab" aria-selected="${r === role}" class="${r === role ? "active" : ""}" data-action="role" data-value="${r}">${r}</button>`).join("")}</div><div class="section-title"><h2>${role}</h2><span class="spacer"></span>${badge("当前连接")}</div><div class="card">${settingRow("CLI", "模型目录来自当前电脑已安装的 CLI。", select("cli", ["Codex", "Pi", "Traex"], roleValue.cli, "CLI"))}${settingRow("模型", "", select("model", ["gpt-6-sol", "gpt-6.1-sol", "gpt-6-astra"], roleValue.model, "模型"))}${settingRow("推理强度", "", select("effort", ["low", "medium", "high", "xhigh"], roleValue.effort, "推理强度"))}</div>${section("高级参数", `<div class="card">${settingRow("角色能力参数", "仅作用于当前角色。", `<input data-field="advancedParams" aria-label="高级参数" placeholder="默认" value="${escape(roleValue.advancedParams || "")}">`)}</div>`)}${savebar(role === "主 Agent" ? "保存主 Agent 配置" : `保存${role}配置`)}`;
  }
  if (page.id === "settings/browser")
    return `<div class="tabs" role="tablist" aria-label="Browser Profile">${["Browser 1", "Browser 2", "Browser 3"].map((b) => `<button class="${state.profile === b ? "active" : ""}" data-action="profile" data-value="${b}">${b}</button>`).join("")}</div><div class="card">${settingRow("全局默认 Browser", "用于未设置首选项的 Worktree。", select("globalBrowser", ["Browser 1", "Browser 2", "Browser 3"], v.globalBrowser, "全局默认 Browser"))}${settingRow("当前 Worktree", `${data.workspace.project} / ${state.worktree}`, select("worktreeBrowser", ["跟随全局默认", "Browser 1", "Browser 2", "Browser 3"], v.worktreeBrowser, "当前 Worktree Browser"))}</div>${section(state.profile, `<div class="card">${settingRow("开发目标端口", "固定目标属于当前 Browser Profile。", input("browserPort", v.browserPort, "开发目标端口", "number"))}${settingRow("Whistle 代理", "按当前 Profile 的规则处理请求。", toggle("proxy", "Whistle 代理"))}${settingRow("代理规则", "", btn("打开 Whistle", "whistle", "ghost"))}</div>`)}${savebar()}`;
  if (page.id === "settings/notifications")
    return `${section("资源监控", `<div class="card">${settingRow("后台资源监控", "关闭页面后继续采样。", toggle("monitor", "后台资源监控"))}${settingRow("资源占用提醒", "持续高占用时提醒。", toggle("alerts", "资源占用提醒"))}${settingRow("Mac 系统通知", "作用于本台桌面。", toggle("macNotify", "Mac 系统通知"))}</div>`)}${section("远程操作", `<div class="card">${settingRow("允许远程结束进程", "仅本机可以修改授权；系统及 Runweave 控制进程仍受保护。", toggle("remoteTerminate", "允许远程结束进程"))}</div>`)}${savebar()}`;
  if (page.id === "settings/data")
    return `${section("活动数据", `<div class="card">${settingRow("保留天数", "当前连接的活动记录。", input("retention", v.retention, "保留天数", "number"))}${settingRow("操作范围", "导出和删除均限定到所选项目。", select("dataProject", ["browser-viewer", "全部项目"], v.dataProject || "browser-viewer", "数据项目"))}${settingRow("导出活动数据", "", btn("导出", "export-data"))}${settingRow("删除活动数据", "删除所选范围的记录后无法恢复。", btn("删除数据", "delete-data", "danger"))}</div>`)}${savebar()}`;
  if (page.id === "settings/shortcuts")
    return `<div class="card"><table class="data-table"><thead><tr><th>范围</th><th>操作</th><th>快捷键</th></tr></thead><tbody>${data.shortcuts.map((r) => `<tr>${r.map((c, i) => `<td class="${i === 2 ? "mono" : ""}">${escape(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  if (page.id === "settings/advanced") {
    if (tail[0] === "domain") {
      const domain =
        data.configDomains[Number(tail[1])] || data.configDomains[0];
      const domains = domain[1].split(" / ");
      const fields = data.configFields.filter((f) =>
        domains.includes(f.domain),
      );
      return `<div class="inline-note">${icon("server")}Stable · ${escape(state.connection)}<span class="spacer"></span>保存版本 12</div>${section(
        domain[0],
        `<div class="card">${fields
          .map((f) => {
            const key = "config:" + f.path;
            const fallback = f.default.value;
            const value = v[key] ?? fallback ?? "";
            const label = f.description;
            const description =
              f.default.rule ||
              "默认值：" +
                (fallback == null ? "未设置" : JSON.stringify(fallback)) +
                " · " +
                (f.apply === "restart" ? "保存后需重启服务" : "保存后重新加载");
            return settingRow(
              label,
              description,
              f.sensitive
                ? select(
                    key,
                    ["保留现有值", "删除"],
                    v[key] || "保留现有值",
                    label,
                  )
                : f.type === "boolean"
                  ? toggle(key, label, Boolean(value))
                  : input(
                      key,
                      Array.isArray(value) ? JSON.stringify(value) : value,
                      label,
                    ),
            );
          })
          .join("")}</div>`,
      )}<p class="subtitle">${state.configPending ? "配置已保存，等待所属服务重新加载或重启。" : "配置状态：已生效"}</p>${savebar("保存配置")}`;
    }
    return `<div class="inline-note">${icon("server")}Stable · 本机 Mac<span class="spacer"></span>保存版本 12</div>${section("配置分类", `<div class="domain-grid">${data.configDomains.map((d, i) => `<button data-route="settings/advanced/domain/${i}"><strong>${escape(d[0])}</strong><small class="mono">${escape(d[1])}</small></button>`).join("")}</div>`)}`;
  }
  return "";
}
function listRows(page) {
  let items = page.items.filter((i) => !i.deleted);
  const query = state.search[page.id] || "";
  const filter = state.filters[page.id] || "";
  if (query)
    items = items.filter((i) =>
      `${i.title} ${i.subtitle} ${i.body}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    );
  if (filter) items = items.filter((i) => i.status === filter);
  if (state.scenario === "empty") items = [];
  if (!items.length)
    return `<div class="empty">${icon("search")}<h2>${query ? "没有找到匹配项" : "暂无记录"}</h2><p>${query ? "试试其他关键词。" : "当前列表还没有内容。"}</p>${page.create ? link(page.id + "/new", page.create, "btn") : ""}</div>`;
  if (page.kind === "notes")
    return items
      .map(
        (i) =>
          `<a class="note" href="#/${page.id}/detail/${i.id}" data-route="${page.id}/detail/${i.id}"><span class="tag">${escape(i.tag || page.title)}</span><h2>${escape(i.title)}</h2><p>${escape(i.body.slice(0, 100))}</p><footer><span>${escape(i.meta)}</span><span>${escape(i.status)}</span></footer></a>`,
      )
      .join("");
  return items
    .map(
      (i) =>
        `<div class="list-row"><span class="row-icon">${icon(page.icon)}</span><div class="row-main">${link(page.id + "/detail/" + i.id, i.title, "row-title")}<p class="row-subtitle">${escape(i.subtitle)}</p></div>${badge(i.status)}<span class="row-meta">${escape(i.meta)}</span><a class="icon-btn" href="#/${page.id}/detail/${i.id}" data-route="${page.id}/detail/${i.id}" aria-label="查看 ${escape(i.title)}">${icon("chevron")}</a></div>`,
    )
    .join("");
}
function collection(page) {
  if (page.id === "events" && state.eventView && state.eventView !== "events")
    return eventViews(page);
  const statuses = [...new Set(page.items.map((i) => i.status))];
  return `${page.id === "events" ? eventTabs() : ""}${state.scenario === "error" ? `<div class="error-banner">读取失败，已保留上次结果。<span class="spacer"></span>${btn("重试", "retry", "ghost")}</div>` : ""}<div class="toolbar"><div class="search-field">${icon("search")}<input type="search" data-search="${page.id}" aria-label="搜索${page.title}" value="${escape(state.search[page.id] || "")}" placeholder="搜索${page.title}…"></div><select data-filter="${page.id}" aria-label="状态筛选"><option value="">全部状态</option>${statuses.map((s) => `<option ${state.filters[page.id] === s ? "selected" : ""}>${escape(s)}</option>`).join("")}</select><span class="count">${page.items.filter((i) => !i.deleted).length} 项</span></div><div id="collection" class="${page.kind === "notes" ? "note-grid" : "card"}">${listRows(page)}</div>`;
}
function eventTabs() {
  return `<nav class="tabs" aria-label="活动数据视图">${[
    ["events", "事件"],
    ["timeline", "时间线"],
    ["sources", "来源"],
  ]
    .map(
      ([id, label]) =>
        `<button class="${(state.eventView || "events") === id ? "active" : ""}" data-action="event-view" data-value="${id}">${label}</button>`,
    )
    .join("")}</nav>`;
}
function eventViews(page) {
  return (
    eventTabs() +
    (state.eventView === "timeline"
      ? `<div class="card detail-body"><h2>交互时间线</h2>${data.timeline.map(([time, title, text]) => `<div class="timeline-item"><small>${time}</small><h3>${title}</h3><p>${text}</p></div>`).join("")}</div>`
      : `<div class="card">${data.runtime
          .slice(0, 3)
          .map(([title, desc, status]) =>
            settingRow(title, desc, badge(status)),
          )
          .join("")}</div>`)
  );
}
function switchConnection(next) {
  if (next === state.connection) {
    closeMenu();
    return;
  }
  leaveGuard(() => {
    const localKeys = [
      "theme",
      "globalBrowser",
      "worktreeBrowser",
      "suijiEnvironment",
      "suijiEndpoint",
      "suijiUser",
      "macNotify",
    ];
    const local = Object.fromEntries(
      localKeys.map((k) => [k, state.settings[k]]),
    );
    state.perConnection[state.connection] = {
      settings: structuredClone(state.settings),
      roles: structuredClone(state.roleSettings),
      worktree: state.worktree,
      session: state.session,
      tool: state.tool,
      composer: state.composer,
      configPending: state.configPending,
    };
    const saved = state.perConnection[next];
    state.connection = next;
    state.settings = {
      ...(saved?.settings || structuredClone(data.settings)),
      ...local,
    };
    state.roleSettings =
      saved?.roles ||
      Object.fromEntries(
        data.roles.map((r) => [r, structuredClone(data.settings)]),
      );
    state.worktree = saved?.worktree || "main";
    state.session = saved?.session || data.workspace.session;
    state.tool = saved?.tool || "Preview";
    state.composer = saved?.composer || "";
    state.configPending = saved?.configPending || false;
    state.draft = null;
    state.dirty = false;
    closeMenu();
    renderWorkspace();
    render();
    notify("已切换到 " + state.connection);
  });
}
function stats(items) {
  return `<div class="stat-grid">${items.map(([name, value, note]) => `<div class="stat"><label>${name}</label><strong>${value}</strong><small>${note}</small></div>`).join("")}</div>`;
}
function pageBody(page) {
  if (["list", "notes"].includes(page.kind)) return collection(page);
  if (page.kind === "runtime")
    return `${stats([
      ["当前连接", "正常", state.connection],
      ["本台桌面", "正常", "本机 Mac"],
      ["待处理", "0", "最近检查：刚刚"],
    ])}<div class="card">${data.runtime.map(([name, desc, status]) => settingRow(name, desc, badge(status))).join("")}</div>${section(
      "配置与版本",
      `<div class="settings-links">${[
        ["settings/advanced", "当前连接的配置"],
        ["desktop-diagnostics", "本台桌面的配置状态与版本"],
      ]
        .map(
          ([id, title]) =>
            `<a href="#/${id}" data-route="${id}">${icon("sliders")}${title}${icon("chevron")}</a>`,
        )
        .join("")}</div>`,
    )}`;
  if (page.kind === "resources")
    return `${stats([
      ["CPU", "18.6%", "8 个核心"],
      ["内存", "12.4 GB", "共 32 GB"],
      ["电池", "86%", "正在使用电池"],
    ])}<div class="toolbar"><h2>应用与进程</h2><span class="spacer"></span>${btn(state.paused ? "继续采样" : "暂停采样", "pause-sampling", "ghost")}${btn("刷新", "refresh")}</div><div class="card"><table class="data-table"><thead><tr><th>应用</th><th>CPU</th><th>RSS</th><th>进程数</th><th></th></tr></thead><tbody>${data.processes.map((r, i) => `<tr><td>${r[0]}</td><td class="numeric">${r[1]}</td><td class="numeric">${r[2]}</td><td class="numeric">${r[3]}</td><td>${i && r[0] !== "WindowServer" ? `<button class="text-btn" data-action="terminate" data-value="${r[0]}">结束进程</button>` : "<small>受保护</small>"}</td></tr>`).join("")}</tbody></table></div>`;
  if (page.kind === "quota")
    return `<div style="max-width:740px"><div class="card">${settingRow("ChatGPT 订阅", `${state.connection} · App Server`, badge("可用"))}<div class="detail-body">${[
      ["5 小时窗口", 28, "今天 18:40 重置"],
      ["每周额度", 54, "10 月 15 日重置"],
    ]
      .map(
        ([label, note, desc]) =>
          `<div style="margin-bottom:28px"><div class="progress-label"><span>${label}</span><span>${100 - note}% 剩余</span></div><div class="meter"><i style="width:${100 - note}%"></i></div><p class="subtitle">${desc}</p></div>`,
      )
      .join("")}</div></div></div>`;
  if (page.kind === "logs")
    return `<div class="card">${settingRow("诊断日志", state.recording ? "正在记录当前页面与服务端事件。" : state.logEnded ? "本轮记录已结束。" : "开始记录后复现问题，完成后结束并上报。", btn(state.recording ? "结束并上报" : "开始记录", "record", "primary"))}${state.recording || state.logEnded ? `<div class="detail-body"><pre>${escape(state.logEnded ? "14:31:02 recording.started\n14:31:04 navigation.changed\n14:31:12 recording.completed" : "14:31:02 recording.started\n14:31:04 navigation.changed")}</pre>${state.logEnded ? `<div class="flex">${btn("下载日志", "download-log")}${btn("复制日志正文", "copy-log", "ghost")}</div>` : ""}</div>` : ""}</div>`;
  if (page.kind === "diagnostics")
    return `<div class="card">${settingRow("Runweave Desktop", "Stable · 本台桌面", badge("运行正常"))}${settingRow("Frontend / Backend / App Server", "构建版本 · 本地源码基线", badge("已连接"))}${settingRow("桌面配置状态", "浏览器、远程访问和伴随窗口。", badge("已生效"))}${settingRow("桌面诊断文件", "包含本机版本、进程与最近运行记录。", btn("导出桌面诊断", "export-diagnostics"))}</div>${section("运行时", `<div class="card">${settingRow("重新加载本机运行时", "将暂时中断本机桌面连接。", btn("重新加载", "reload-runtime", "danger"))}</div>`)}`;
  if (page.kind === "lookup")
    return `<div class="card form-grid"><div class="form-pair">${formField("lookupThread", "Thread ID", "thread-01")}${formField("lookupTerminal", "Terminal ID", "terminal-01")}</div><div>${btn("查询", "lookup", "primary")}</div></div>${state.lookupDone ? section("状态摘要", `<div class="card">${settingRow("Thread", "thread-01", badge("agent_idle"))}${settingRow("关联终端", "terminal-01 / pane-1", badge("可恢复"))}${settingRow("当前项目", "browser-viewer / wt-1", link("history", "查看终端历史", "text-btn"))}</div>`) : ""}`;
  if (page.kind === "mobile")
    return `<div class="card" style="max-width:680px"><div class="detail-body"><h2>${escape(state.connection)}</h2><p>选择手机可以访问的连接地址。</p>${select("mobileAddress", ["192.0.2.10:5001", "通过中转服务器"], "192.0.2.10:5001", "连接地址")}<div style="display:flex;gap:24px;align-items:center;margin:25px 0"><div style="width:165px;height:165px;border:1px dashed var(--line);border-radius:8px;display:grid;place-items:center">${icon("phone")}</div><div><h2>${state.mobileApproved ? "已允许登录" : "iPhone 请求登录"}</h2><p>来自当前连接的扫码请求</p>${state.mobileApproved ? badge("已确认") : `${btn("允许登录", "approve-mobile", "primary")} ${btn("拒绝", "reject-mobile")}`}</div></div>${btn("重新生成二维码", "regenerate-mobile", "ghost")}</div></div>`;
  if (page.id === "suiji-account")
    return `<div style="max-width:730px"><div class="card">${settingRow("账户环境", "不同环境分别保留账户和草稿。", select("suijiEnvironment", ["生产环境", "开发环境"], values().suijiEnvironment, "账户环境"))}${settingRow("服务地址", "", input("suijiEndpoint", values().suijiEndpoint, "随记服务地址"))}${settingRow("账户", "", input("suijiUser", values().suijiUser, "随记账户"))}</div>${savebar("保存账户配置")}${btn("退出随记账户", "logout-suiji", "danger")}</div>`;
  if (page.id === "evolution-policy")
    return `<div style="max-width:730px"><div class="card">${settingRow("真实注入", "只对 browser-viewer 生效。", toggle("canary", "真实注入"))}${settingRow("Canary 比例", "实验流量百分比。", input("ratio", values().ratio, "Canary 比例", "number"))}</div>${savebar("保存策略")}</div>`;
  return "";
}
function currentItem(page, id) {
  return page.items.find((i) => i.id === id);
}
function detail(page, id) {
  const item = currentItem(page, id);
  if (!item) return header(page, "记录已不存在") + btn("返回列表", "back");
  let actions = "";
  if (
    [
      "commands",
      "schedules",
      "connections",
      "tunnels",
      "evolution-schedules",
      "notes",
      "todos",
    ].includes(page.id)
  )
    actions = link(`${page.id}/edit/${id}`, "编辑", "btn");
  if (page.id === "commands")
    actions += btn("在后台运行", "run-command", "primary", `data-id="${id}"`);
  if (page.id === "schedules")
    actions += btn("立即执行", "run-now", "primary", `data-id="${id}"`);
  if (page.id === "connections")
    actions += btn(
      state.connection === item.title ? "当前连接" : "切换连接",
      "switch-connection",
      "primary",
      `data-value="${escape(item.title)}"`,
    );
  if (page.id === "tunnels")
    actions += btn(
      item.status === "已连接" ? "断开连接" : "连接主机",
      "tunnel-toggle",
      "",
      `data-id="${id}"`,
    );
  if (page.id === "prototypes")
    actions += btn("打开原型", "open-prototype", "primary", `data-id="${id}"`);
  let body = "";
  if (page.id === "tunnels") {
    body = `<div class="card">${settingRow("SSH 主机", item.ssh, badge(item.status))}${settingRow("启动时自动连接", "本台桌面", badge("已启用"))}</div>${section("通道", `<div class="card">${settingRow("开发服务端口", "Frontend · 5173 → 5173", badge("已连接"))}${settingRow("远程访问本机", "http://192.0.2.10:15001", btn("重新检测", "refresh", "ghost"))}${settingRow("远端使用本机 Browser", "Browser 1 · 已授权", link("settings/browser", "浏览器设置", "text-btn"))}${settingRow("Mac 远控中转", "RemoteDesk · 5901", btn("查看证书指纹", "certificate", "ghost"))}${settingRow("Backend 访问入口", "远端 5001", badge("可用"))}</div>`)}`;
  } else if (page.id === "runs") {
    body = `<div class="detail-layout"><div class="stack"><div class="card detail-body"><h2>执行进度</h2>${data.timeline.map(([time, title, text]) => `<div class="timeline-item"><small>${time}</small><h3>${title}</h3><p>${text}</p></div>`).join("")}${item.status === "待处理" ? `<label class="field"><span>回复 Agent</span><textarea id="agent-reply" placeholder="补充任务范围或处理意见…"></textarea></label><div style="margin-top:13px">${btn("发送并继续", "reply-run", "primary", `data-id="${id}"`)}</div>` : badge(item.status)}</div><div class="card detail-body"><h2>运行输出</h2><pre>${escape(item.output || item.body)}</pre><div class="flex">${btn("恢复对话", "restore-conversation")}${btn("移至历史", "archive-run", "ghost", `data-id="${id}"`)}</div></div></div>${facts(item, page)}</div>`;
  } else {
    let detailActions = "";
    if (page.id === "schedules")
      detailActions =
        btn(
          item.status === "已启用" ? "暂停任务" : "启用任务",
          "toggle-task",
          "",
          `data-id="${id}"`,
        ) + btn("删除任务", "delete-item", "danger", `data-id="${id}"`);
    if (page.id === "commands")
      detailActions =
        btn("插入当前终端", "insert-command", "", `data-id="${id}"`) +
        btn("复制指令", "copy-item", "ghost", `data-id="${id}"`) +
        btn("删除指令", "delete-item", "danger", `data-id="${id}"`);
    if (page.id === "knowledge")
      detailActions =
        btn(
          item.status === "已处理" ? "恢复待处理" : "标记已处理",
          "process-knowledge",
          "primary",
          `data-id="${id}"`,
        ) + btn("复制引用", "copy-item", "ghost", `data-id="${id}"`);
    if (page.id === "candidates")
      detailActions =
        btn("授权进入 Canary", "canary", "", `data-id="${id}"`) +
        btn("退休 / 回滚", "retire", "danger", `data-id="${id}"`);
    if (page.id === "trash")
      detailActions = btn(
        "恢复记录",
        "restore-note",
        "primary",
        `data-id="${id}"`,
      );
    if (page.id === "notes" || page.id === "todos")
      detailActions =
        btn("添加跟进", "followup", "", `data-id="${id}"`) +
        btn(
          item.status === "已完成" ? "恢复待办" : "标记完成",
          "complete-note",
          "ghost",
          `data-id="${id}"`,
        ) +
        btn("移至回收站", "trash-note", "danger", `data-id="${id}"`);
    if (page.id === "dev-resources")
      detailActions = btn(
        "释放资源",
        "release-resource",
        "danger",
        `data-id="${id}"`,
      );
    if (page.id === "connections")
      detailActions =
        btn("检测连接", "refresh") +
        (item.id === "local"
          ? ""
          : btn("删除连接", "delete-item", "danger", `data-id="${id}"`));
    if (["history", "team-history", "evolution"].includes(page.id))
      detailActions =
        btn("打开关联终端", "restore-conversation") +
        link("events", "查看活动证据", "btn ghost");
    body = `<div class="detail-layout"><div class="stack"><div class="card detail-body"><h2>${page.id === "commands" || page.id === "schedules" ? "提示词" : page.kind === "notes" ? "正文" : "详情"}</h2><p style="white-space:pre-wrap">${escape(item.body)}</p>${item.followups?.map((t) => `<div class="inline-note">${escape(t)}</div>`).join("") || ""}<div class="flex" style="flex-wrap:wrap;margin-top:25px">${detailActions}</div></div>${page.id === "schedules" ? `<div class="card detail-body"><h2>运行历史</h2>${link("runs/detail/summary-run", "昨天 18:00 · 已完成", "text-btn")}</div>` : ""}</div>${facts(item, page)}</div>`;
  }
  return header(page, item.title, actions) + body;
}
function facts(item, page) {
  return `<aside class="card facts"><div style="margin-bottom:8px">${badge(item.status)}</div><dl>${(item.facts || [["归属", scopeLabel(page)], ["项目", "browser-viewer"], ["最近更新", item.meta], ...(item.schedule ? [["执行计划", item.schedule]] : [])]).map(([k, v]) => `<div class="fact"><dt>${escape(k)}</dt><dd>${escape(v)}</dd></div>`).join("")}</dl></aside>`;
}
function editor(page, tail) {
  const editing = tail[0] === "edit";
  const item = editing ? currentItem(page, tail[1]) : null;
  const v = state.draft || item || {};
  let fields = formField("title", "名称", v.title || "");
  if (page.id === "connections")
    fields += formField("url", "Backend 地址", v.url || "http://", "url");
  else if (page.id === "tunnels")
    fields +=
      formField(
        "ssh",
        "SSH 主机或配置别名",
        v.ssh || "",
        "text",
        "沿用本机 SSH 配置与密钥。",
      ) +
      `<label class="flex"><input data-field="autoConnect" type="checkbox" ${v.autoConnect ? "checked" : ""}>启动桌面端时自动连接</label><div class="form-pair">${formField("port", "开发服务端口", v.port || "5173", "number")}${formField("remotePort", "Backend 访问端口", v.remotePort || "5001", "number")}</div><label class="flex"><input data-field="remoteAccess" type="checkbox" ${v.remoteAccess ? "checked" : ""}>启用远程访问本机</label><label class="flex"><input data-field="browserAccess" type="checkbox" ${v.browserAccess ? "checked" : ""}>允许远端 Agent 使用本机 Browser</label><label class="flex"><input data-field="remoteDesk" type="checkbox" ${v.remoteDesk ? "checked" : ""}>启用 RemoteDesk 中转</label>`;
  else {
    fields += formField(
      "body",
      page.kind === "notes" ? "内容" : "提示词",
      v.body || "",
      "textarea",
    );
    if (page.id === "schedules" || page.id === "evolution-schedules")
      fields += `<div class="form-pair"><div class="field"><label>项目</label>${select("project", ["browser-viewer", "runweave-site"], v.project || "browser-viewer", "项目")}</div><div class="field"><label>执行计划</label>${select("schedule", ["每天 18:00", "每小时", "每周一 09:00"], v.schedule || "每天 18:00", "执行计划")}</div></div><div class="form-pair"><div class="field"><label>模型</label>${select("model", ["gpt-6-sol", "gpt-6-astra"], v.model || "gpt-6-sol", "任务模型")}</div><div class="field"><label>推理强度</label>${select("effort", ["medium", "high", "xhigh"], v.effort || "high", "任务推理强度")}</div></div>`;
  }
  return (
    header(
      page,
      editing
        ? "编辑" +
            (page.id === "schedules"
              ? "任务"
              : page.id === "commands"
                ? "指令"
                : page.id === "tunnels"
                  ? "主机"
                  : page.title)
        : page.create || "新建",
    ) +
    `<div class="card form-grid">${fields}</div><p id="form-error" role="alert" style="color:var(--red);margin-top:14px" hidden></p>${savebar(editing ? "保存修改" : "创建")}`
  );
}
function beginDraft() {
  if (state.draft) return;
  const page = pageFor(state.route),
    tail = tailFor(page);
  state.draft = structuredClone(
    tail[0] === "edit"
      ? currentItem(page, tail[1]) || {}
      : tail[0] === "new"
        ? {}
        : page.id === "settings/models"
          ? state.roleSettings[state.role]
          : page.id === "settings/browser"
            ? { ...state.settings, ...state.profileSettings[state.profile] }
            : state.settings,
  );
}
function markDirty() {
  state.dirty = true;
  const note = $("#save-state");
  if (note) note.textContent = "有未保存的修改";
  const button = $("#save-button");
  if (button && !isUnavailable(pageFor(state.route))) button.disabled = false;
}
function save() {
  const page = pageFor(state.route),
    tail = tailFor(page);
  if (isUnavailable(page)) {
    notify("请先恢复连接");
    return;
  }
  let error = "";
  const v = state.draft || {};
  if (tail[0] === "new" || tail[0] === "edit") {
    if (!v.title?.trim()) error = "请填写名称。";
    if (page.id === "connections" && !/^https?:\/\/.+/.test(v.url || ""))
      error = "请填写完整的 http 或 https 地址。";
    if (page.id === "tunnels" && !v.ssh?.trim()) error = "请填写 SSH 主机。";
    if (error) {
      $("#form-error").textContent = error;
      $("#form-error").hidden = false;
      return;
    }
    const item =
      tail[0] === "edit"
        ? currentItem(page, tail[1])
        : {
            id: "item-" + Date.now(),
            status:
              page.id === "schedules"
                ? "已启用"
                : page.kind === "notes"
                  ? "记录"
                  : "可用",
            meta: "刚刚",
            subtitle:
              page.id === "schedules"
                ? `browser-viewer · ${v.schedule || "每天 18:00"}`
                : scopeLabel(page),
            body: "",
          };
    Object.assign(item, v);
    if (tail[0] === "new") page.items.unshift(item);
    else if (state.trail.at(-1)?.route === page.id + "/detail/" + item.id)
      state.trail.pop();
    state.dirty = false;
    state.draft = null;
    navigate(page.id + "/detail/" + item.id, { replace: true });
    notify("已保存");
    return;
  }
  if (state.passwordEditing && page.id === "settings/account") {
    if (
      !v.oldPassword ||
      !v.newPassword ||
      v.newPassword !== v.confirmPassword
    ) {
      notify("请填写当前密码，并确保两次新密码一致");
      return;
    }
    state.passwordEditing = false;
    delete v.oldPassword;
    delete v.newPassword;
    delete v.confirmPassword;
  }
  if (
    page.id === "settings/browser" &&
    (!/^\d+$/.test(v.browserPort) ||
      Number(v.browserPort) < 1 ||
      Number(v.browserPort) > 65535)
  ) {
    notify("端口需为 1–65535");
    return;
  }
  if (page.id === "settings/models") state.roleSettings[state.role] = { ...v };
  else if (page.id === "settings/browser") {
    state.profileSettings[state.profile] = {
      browserPort: v.browserPort,
      proxy: v.proxy,
    };
    state.settings.globalBrowser = v.globalBrowser;
    state.settings.worktreeBrowser = v.worktreeBrowser;
  } else Object.assign(state.settings, v);
  if (page.id === "settings/advanced") state.configPending = true;
  state.draft = null;
  state.dirty = false;
  render();
  notify(
    page.id === "settings/advanced" ? "配置已保存，等待所属服务重启" : "已保存",
  );
}
function download(name, text) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/plain;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}
async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    notify("已复制");
  } catch {
    confirmAction("复制内容", text, "关闭", () => {});
  }
}
function insertCommand(item) {
  state.composer = item.body;
  $("#composer").value = item.body;
  navigate("workspace");
  notify("已插入当前终端");
}
function applyTheme(theme) {
  document.documentElement.dataset.theme =
    theme === "system"
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;
}
function localAction(action, target) {
  const page = pageFor(state.route),
    id = target.dataset.id,
    item = page && id ? currentItem(page, id) : null;
  switch (action) {
    case "back":
      back();
      break;
    case "dialog-cancel":
      $("#confirmation").close();
      break;
    case "dialog-confirm": {
      const callback = state.confirm;
      state.confirm = null;
      $("#confirmation").close();
      callback?.();
      break;
    }
    case "save":
      save();
      break;
    case "cancel-edit":
      leaveGuard(() => {
        state.draft = null;
        state.dirty = false;
        render();
      });
      break;
    case "theme":
      state.settings.theme = target.dataset.value;
      applyTheme(state.settings.theme);
      render();
      notify("外观已更新");
      break;
    case "role":
      leaveGuard(() => {
        state.role = target.dataset.value;
        state.draft = null;
        render();
      });
      break;
    case "profile":
      leaveGuard(() => {
        state.profile = target.dataset.value;
        state.draft = null;
        render();
      });
      break;
    case "move-tool": {
      const tools = data.workspace.tools,
        index = tools.indexOf(target.dataset.value);
      if (index > 0)
        [tools[index - 1], tools[index]] = [tools[index], tools[index - 1]];
      data.workspace.visibleTools.sort(
        (a, b) => tools.indexOf(a) - tools.indexOf(b),
      );
      renderWorkspace();
      render();
      notify("标签顺序已更新");
      break;
    }
    case "worktree":
      state.composer = $("#composer").value;
      state.worktree = target.dataset.value;
      renderWorkspace();
      break;
    case "session":
      state.composer = $("#composer").value;
      state.session = target.dataset.value;
      renderWorkspace();
      break;
    case "new-session": {
      const name = "新终端 " + (data.workspace.sessions.length + 1);
      data.workspace.sessions.push(name);
      state.session = name;
      renderWorkspace();
      break;
    }
    case "project":
      openProjectEditor(false);
      break;
    case "project-new":
      openProjectEditor(true);
      break;
    case "save-project": {
      const name = $("#project-name").value.trim();
      if (!name) {
        notify("请填写项目名称");
        return;
      }
      data.workspace.project = name;
      $("#confirmation").close();
      renderWorkspace();
      notify("项目已保存");
      break;
    }
    case "tool":
      state.tool = target.dataset.value;
      closeMenu();
      renderSidecar();
      break;
    case "send": {
      const composer = $("#composer");
      if (!composer.value.trim()) return;
      const p = document.createElement("p");
      p.className = "user-line";
      p.textContent = "› " + composer.value;
      $("#transcript").append(p);
      state.composer = "";
      composer.value = "";
      $("#transcript").scrollTop = $("#transcript").scrollHeight;
      notify("消息已加入当前会话");
      break;
    }
    case "quick-insert":
      insertCommand(
        currentItem(
          data.pages.find((p) => p.id === "commands"),
          target.dataset.id,
        ),
      );
      closeMenu();
      break;
    case "insert-command":
      insertCommand(item);
      break;
    case "copy-item":
      copy(item.body);
      break;
    case "switch-connection":
      switchConnection(target.dataset.value);
      break;
    case "event-view":
      state.eventView = target.dataset.value;
      render();
      break;
    case "service-toggle":
      state.serviceRunning = !state.serviceRunning;
      closeMenu();
      notify(state.serviceRunning ? "服务已启动" : "服务已停止");
      break;
    case "refresh":
      notify("已更新");
      break;
    case "retry":
      state.scenario = "";
      render();
      notify("连接已恢复");
      break;
    case "pause-sampling":
      state.paused = !state.paused;
      render();
      break;
    case "run-command":
    case "run-now": {
      const runs = data.pages.find((p) => p.id === "runs");
      const run = {
        id: "run-" + Date.now(),
        title: item.title,
        subtitle: `${page.title} · browser-viewer / ${state.worktree}`,
        status: "执行中",
        meta: "刚刚",
        body: item.body,
        output: "已加入执行队列\n正在读取项目上下文…",
      };
      runs.items.unshift(run);
      navigate("runs/detail/" + run.id);
      notify("已开始执行");
      break;
    }
    case "reply-run": {
      const reply = $("#agent-reply").value.trim();
      if (!reply) {
        notify("请先填写回复");
        return;
      }
      item.status = "执行中";
      item.output += "\n回复：" + reply;
      render();
      notify("已回复并继续");
      break;
    }
    case "toggle-task":
      item.status = item.status === "已启用" ? "已暂停" : "已启用";
      render();
      notify(item.status);
      break;
    case "delete-item":
      confirmAction("删除这项记录？", item.title, "删除", () => {
        item.deleted = true;
        navigate(page.id, { replace: true });
        notify("已删除");
      });
      break;
    case "archive-run":
      if (["执行中", "待处理"].includes(item.status)) {
        notify("运行结束后才能移至历史");
        return;
      }
      item.status = "已归档";
      render();
      notify("已移至历史");
      break;
    case "restore-conversation":
      navigate("workspace");
      break;
    case "tunnel-toggle":
      item.status = item.status === "已连接" ? "未连接" : "已连接";
      render();
      notify(item.status);
      break;
    case "certificate":
      confirmAction(
        "证书指纹",
        "SHA256: 7A:13:CF:82:90:4B:2A:66:19:EF",
        "关闭",
        () => {},
      );
      break;
    case "terminate":
      confirmAction(
        "结束这个进程？",
        target.dataset.value + " 的未保存内容可能丢失。",
        "结束进程",
        () => {
          data.processes = data.processes.filter(
            (p) => p[0] !== target.dataset.value,
          );
          render();
          notify("进程已结束");
        },
      );
      break;
    case "release-resource":
      confirmAction(
        "释放这项资源？",
        item.title + "：继续操作会重新核对占用归属。",
        "释放",
        () => {
          item.status = "空闲";
          render();
          notify("资源已释放");
        },
      );
      break;
    case "process-knowledge":
      item.status = item.status === "已处理" ? "待处理" : "已处理";
      render();
      break;
    case "complete-note":
      item.status = item.status === "已完成" ? "待办" : "已完成";
      render();
      break;
    case "followup": {
      const dialog = $("#confirmation");
      dialog.innerHTML = `<h2 id="confirmation-title">添加跟进</h2><textarea id="followup-text" aria-label="跟进内容" style="width:100%;min-height:120px"></textarea><div class="actions">${btn("取消", "dialog-cancel")}${btn("保存跟进", "save-followup", "primary", `data-id="${id}"`)}</div>`;
      dialog.showModal();
      break;
    }
    case "save-followup": {
      const text = $("#followup-text").value.trim();
      if (!text) return;
      item.followups ||= [];
      item.followups.push(text);
      $("#confirmation").close();
      render();
      notify("跟进已保存");
      break;
    }
    case "trash-note":
      confirmAction("移至回收站？", item.title, "移至回收站", () => {
        item.deleted = true;
        data.pages
          .find((p) => p.id === "trash")
          .items.unshift({ ...item, deleted: false, status: "已删除" });
        navigate(page.id);
      });
      break;
    case "restore-note":
      item.deleted = true;
      data.pages
        .find((p) => p.id === "notes")
        .items.unshift({ ...item, deleted: false, status: "记录" });
      navigate("notes");
      notify("记录已恢复");
      break;
    case "canary":
      confirmAction(
        "授权进入 Canary？",
        "授权将应用于 browser-viewer 的当前候选资产。",
        "授权",
        () => {
          item.status = "已授权";
          render();
        },
      );
      break;
    case "retire":
      confirmAction("退休 / 回滚此资产？", item.title, "确认", () => {
        item.status = "已退休";
        render();
      });
      break;
    case "record":
      if (state.recording) {
        state.recording = false;
        state.logEnded = true;
      } else {
        state.recording = true;
        state.logEnded = false;
      }
      render();
      break;
    case "download-log":
      download(
        "runweave-diagnostic.log",
        "recording.started\nnavigation.changed\nrecording.completed",
      );
      break;
    case "copy-log":
      copy("recording.started\nnavigation.changed\nrecording.completed");
      break;
    case "export-diagnostics":
      download(
        "desktop-diagnostics.json",
        JSON.stringify({ desktop: "Runweave", status: "running" }, null, 2),
      );
      notify("诊断文件已导出");
      break;
    case "reload-runtime":
      confirmAction(
        "重新加载本机运行时？",
        "本机桌面连接会暂时中断，远端任务不受影响。",
        "重新加载",
        () => notify("运行时已重新加载"),
      );
      break;
    case "lookup":
      state.lookupDone = true;
      render();
      break;
    case "password":
      state.passwordEditing = true;
      render();
      break;
    case "logout":
    case "logout-suiji":
      confirmAction(
        "退出当前账户？",
        action === "logout-suiji"
          ? "随记草稿会保留。"
          : "再次访问此连接需要重新登录。",
        "退出登录",
        () => notify("已退出当前账户"),
      );
      break;
    case "export-data":
      download(
        "activity-export.json",
        JSON.stringify(
          data.pages.find((p) => p.id === "events").items,
          null,
          2,
        ),
      );
      break;
    case "delete-data":
      confirmAction(
        "删除活动数据？",
        "将删除所选项目的活动记录，此操作无法撤销。",
        "删除数据",
        () => {
          data.pages.find((p) => p.id === "events").items = [];
          notify("所选活动数据已删除");
        },
      );
      break;
    case "approve-mobile":
      state.mobileApproved = true;
      render();
      break;
    case "reject-mobile":
      state.mobileApproved = false;
      notify("已拒绝本次登录");
      break;
    case "regenerate-mobile":
      state.mobileApproved = false;
      render();
      notify("登录请求已刷新");
      break;
    case "whistle":
      confirmAction(
        "Whistle · " + state.profile,
        "代理规则属于本台桌面的当前 Browser Profile。",
        "关闭",
        () => {},
      );
      break;
    case "open-prototype":
      if (id === "secondary") navigate("workspace");
      else
        confirmAction(
          "Agent Team 角色模型",
          "打开原型库中的历史版本。",
          "查看模型配置",
          () => navigate("settings/models"),
        );
      break;
    case "output":
      copy($("#transcript").innerText);
      closeMenu();
      break;
    case "share":
      closeMenu();
      confirmAction(
        "终端快照",
        "https://share.example.com/snapshot/desktop-navigation",
        "复制链接",
        () => copy("https://share.example.com/snapshot/desktop-navigation"),
      );
      break;
    case "recover":
      confirmAction(
        "恢复当前 Agent？",
        "重新启动当前 pane 并续接已保存的会话。未提交的输入将被丢弃。",
        "恢复",
        () => notify("当前会话已恢复"),
      );
      break;
    case "fork":
      data.workspace.sessions.push("Fork · " + state.session);
      renderWorkspace();
      closeMenu();
      notify("已创建 Fork Thread");
      break;
  }
}
function openProjectEditor(create) {
  const dialog = $("#confirmation");
  dialog.innerHTML = `<h2 id="confirmation-title">${create ? "新建" : "编辑"}项目</h2><div class="stack"><label class="field">项目名称<input id="project-name" value="${create ? "" : escape(data.workspace.project)}"></label><label class="field">项目路径<input value="${create ? "" : "~/Code/browser-viewer"}"></label></div><div class="actions">${btn("取消", "dialog-cancel")}${btn("保存", "save-project", "primary")}</div>`;
  dialog.showModal();
}
function bind() {
  document.addEventListener("click", (event) => {
    const route = event.target.closest("[data-route]");
    if (route) {
      event.preventDefault();
      navigate(route.dataset.route);
      return;
    }
    const menu = event.target.closest("[data-menu]");
    if (menu) {
      openMenu(menu.dataset.menu, menu);
      return;
    }
    const action = event.target.closest("[data-action]");
    if (action && !action.disabled) {
      localAction(action.dataset.action, action);
      return;
    }
    if (!event.target.closest("#popover")) closeMenu();
  });
  document.addEventListener("input", (event) => {
    const target = event.target;
    if (target.id === "composer") {
      state.composer = target.value;
      return;
    }
    if (target.dataset.search) {
      const page = data.pages.find((p) => p.id === target.dataset.search);
      state.search[page.id] = target.value;
      $("#collection").innerHTML = listRows(page);
      return;
    }
    if (target.dataset.field && !target.closest("#workspace")) {
      const page = pageFor(state.route);
      if (["lookup", "mobile"].includes(page?.kind)) return;
      beginDraft();
      state.draft[target.dataset.field] =
        target.type === "checkbox" ? target.checked : target.value;
      markDirty();
    }
  });
  document.addEventListener("change", (event) => {
    const target = event.target;
    if (target.dataset.filter) {
      state.filters[target.dataset.filter] = target.value;
      $("#collection").innerHTML = listRows(pageFor(state.route));
    }
    if (target.dataset.toolVisible) {
      const tools = data.workspace.visibleTools,
        t = target.dataset.toolVisible;
      if (!target.checked && tools.length === 1) {
        target.checked = true;
        notify("至少保留一个可见标签");
        return;
      }
      if (target.checked && !tools.includes(t)) tools.push(t);
      if (!target.checked)
        data.workspace.visibleTools = tools.filter((x) => x !== t);
      renderWorkspace();
      notify("工具标签已更新");
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("#popover").hidden) {
      closeMenu();
      menuTrigger?.focus();
    }
    if (!$("#popover").hidden && ["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      const entries = [...$("#popover").querySelectorAll("a,button")];
      const i = entries.indexOf(document.activeElement),
        delta = event.key === "ArrowDown" ? 1 : -1;
      entries[(i + delta + entries.length) % entries.length]?.focus();
    }
  });
  addEventListener("popstate", () => {
    const next = decodeURIComponent(location.hash.slice(2)) || "workspace";
    if (state.dirty) {
      history.pushState({}, "", `#/${state.route}`);
      leaveGuard(() => navigate(next, { replace: true }));
    } else navigate(next, { replace: true, fromBrowser: true });
  });
}
fetch("./mock-state.json")
  .then((r) => {
    if (!r.ok) throw Error("无法加载页面数据");
    return r.json();
  })
  .then((result) => {
    data = result;
    state = {
      route: decodeURIComponent(location.hash.slice(2)) || "workspace",
      trail: [],
      connection: "本机 Mac",
      worktree: "wt-1",
      session: data.workspace.session,
      tool: "Preview",
      composer: "",
      settings: structuredClone(data.settings),
      roleSettings: Object.fromEntries(
        data.roles.map((r) => [r, structuredClone(data.settings)]),
      ),
      role: "主 Agent",
      profileSettings: {
        "Browser 1": { browserPort: "5173", proxy: true },
        "Browser 2": { browserPort: "3000", proxy: false },
        "Browser 3": { browserPort: "8080", proxy: false },
      },
      profile: "Browser 1",
      dirty: false,
      draft: null,
      search: {},
      filters: {},
      scenario: new URLSearchParams(location.search).get("state") || "",
      serviceRunning: true,
      perConnection: {},
    };
    if (!pageFor(state.route) && state.route !== "workspace")
      state.route = "workspace";
    renderWorkspace();
    bind();
    render();
  })
  .catch((error) => {
    const workspace = $("#workspace");
    workspace.style.padding = "32px";
    workspace.textContent = error.message;
  });
