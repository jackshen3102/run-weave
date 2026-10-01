const root = document.querySelector("#app");
const data = await fetch("./mock-state.json").then((response) =>
  response.json(),
);
const params = new URLSearchParams(location.search);
const state = {
  ...data,
  page: "commands",
  overlay: null,
  ordering: false,
  toast: "",
  sent: [],
};
if (params.get("runs") === "5") state.runs.push(...data.extraRuns);
if (params.has("empty")) state.runs = [];
if (params.get("project") === "main")
  state.context = {
    ...state.context,
    projectId: "browser-viewer",
    worktreeName: null,
  };
if (params.get("terminal") === "other") state.context.terminalId = "terminal-b";
if (params.get("view") === "detail") {
  state.page = "detail";
  state.runId = state.runs[0]?.id;
}
const paths = {
  back: "m14 5-7 7 7 7",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  chevron: "m9 5 7 7-7 7",
  plus: "M12 5v14M5 12h14",
  send: "M12 19V5m-6 6 6-6 6 6",
  play: "m9 5 10 7-10 7Z",
  clock: "M12 8v4l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18",
  folder: "M3 7h7l2 2h9v11H3ZM3 7V4h7l2 3",
  edit: "m15 4 5 5M4 20l4-1L20 7l-3-3L5 16Z",
  insert: "M4 5h16M4 10h10M4 15h7M17 12v8m-3-3 3 3 3-3",
  trash: "M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7",
  sort: "M8 3v18m-4-4 4 4 4-4M16 21V3m-4 4 4-4 4 4",
  wifi: "M3 8q9-8 18 0M6 12q6-5 12 0M9 16q3-2 6 0M12 19h.01",
  signal: "M4 18v-3M9 18v-6M14 18V9M19 18V5",
  stop: "M6 6h12v12H6Z",
};
const icon = (name) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.more}"/></svg>`;
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const locationLabel = (item) =>
  `${item.projectName} / ${item.worktreeName || "主项目"}`;
const activeRuns = () =>
  state.runs
    .filter((run) => ["running", "queued", "stopping"].includes(run.status))
    .sort(
      (a, b) =>
        ["running", "stopping", "queued"].indexOf(a.status) -
        ["running", "stopping", "queued"].indexOf(b.status),
    );
const runForCommand = (id) =>
  activeRuns().find(
    (run) => run.commandId === id && run.projectId === state.context.projectId,
  );
const statusLabel = (run) =>
  ({
    running: "运行中",
    queued: "排队中",
    stopping: "停止中",
    cancelled: "已停止",
    completed: "已完成",
  })[run.status] || run.status;
const commandById = (id) => state.commands.find((item) => item.id === id);
const button = (action, label, cls = "", id = "") =>
  `<button class="${cls}" data-action="${action}" ${id ? `data-id="${escape(id)}"` : ""}>${label}</button>`;
function runRow(run) {
  return `<button class="run-row" data-action="open-run" data-id="${escape(run.id)}" aria-label="${escape(run.title + "，" + locationLabel(run) + "，" + statusLabel(run))}"><span class="run-symbol ${run.status}">${icon(run.status === "queued" ? "clock" : "play")}</span><span class="run-info"><span class="run-top"><strong>${escape(run.title)}</strong><span class="run-status">${statusLabel(run)}${run.status === "running" ? " · " + escape(run.elapsed) : ""}</span></span><span class="run-project">${escape(locationLabel(run))}</span></span>${icon("chevron").replace("<svg ", '<svg class="chevron" ')}</button>`;
}
function commandCard(item) {
  const run = runForCommand(item.id);
  const action = (name, label, symbol, style, target, accessibleLabel) =>
    `<button class="${style}" data-action="${name}" data-id="${escape(target)}" aria-label="${escape(accessibleLabel)}"><span>${icon(symbol)}${label}</span></button>`;
  return `<article class="command-card" data-command="${escape(item.id)}">
    <button class="command-main" data-action="preview" data-id="${escape(item.id)}"><strong>${escape(item.title)}</strong><span class="preview">${escape(item.data)}</span></button>
    <div class="command-actions">
      ${action("send", "发送", "send", "primary", item.id, "发送到终端 " + item.title)}
      ${action(run ? "open-run" : "background", run ? "查看" : "后台", run ? "clock" : "play", "secondary", run ? run.id : item.id, (run ? "查看运行 " : "后台运行 ") + item.title)}
    </div>
    <button class="icon-button command-menu" data-action="command-menu" data-id="${escape(item.id)}" aria-label="管理 ${escape(item.title)}">${icon("more")}</button>
    ${state.ordering ? `<div class="order-controls">${button("move-up", "↑ 上移", "", item.id)}${button("move-down", "↓ 下移", "", item.id)}</div>` : ""}
  </article>`;
}

function header() {
  return `<header class="header"><button class="circle" data-action="back" aria-label="返回">${icon("back")}</button><div class="heading"><strong>codex · browser-viewer${state.context.worktreeName ? " · " + escape(state.context.worktreeName) : ""}</strong><div class="connection"><i class="dot"></i>${escape(state.connection)} · 已连接</div></div><button class="circle" data-action="terminal-menu" aria-label="终端菜单">${icon("more")}</button></header><nav class="tabs" aria-label="终端页面">${[
    ["terminal", "终端"],
    ["changes", "变更"],
    ["files", "文件"],
    ["commands", "快捷指令"],
  ]
    .map(
      ([id, label]) =>
        `<button data-action="tab" data-id="${id}" class="${state.page === id ? "active" : ""}" aria-selected="${state.page === id}">${label}${id === "changes" ? '<span class="count">4</span>' : ""}</button>`,
    )
    .join("")}</nav>`;
}
function commandsPage() {
  const runs = activeRuns();
  return `<div class="content"><section class="section"><div class="section-title"><h2>后台任务 <span>· ${runs.length}</span></h2>${button("all-runs", (runs.length > 3 ? "查看全部 " + runs.length + " 个" : "全部") + icon("chevron"), "text-button")}</div>${runs.length ? `<div class="run-list" id="dashboard">${runs.slice(0, 3).map(runRow).join("")}</div>` : '<div class="empty">暂无后台任务</div>'}</section><div class="divider"></div><section class="section"><div class="section-title"><h2>快捷指令</h2><div class="actions"><button class="icon-button" data-action="add" aria-label="新增指令">${icon("plus")}</button><button class="icon-button" data-action="library-menu" aria-label="指令管理">${icon("more")}</button></div></div><p class="context">${icon("folder")}<span>当前执行位置：${escape(locationLabel(state.context))}</span></p><div id="command-list">${state.commands.map(commandCard).join("") || '<div class="empty">还没有快捷指令</div>'}</div></section></div>`;
}
const subnav = (title) =>
  `<div class="subnav">${button("back", icon("back") + "返回")}<strong>${title}</strong><span class="spacer"></span></div>`;
function allRunsPage() {
  const active = activeRuns(),
    finished = state.runs.filter(
      (run) => !["running", "queued", "stopping"].includes(run.status),
    );
  return (
    subnav("后台任务") +
    `<div class="detail-content"><p class="context">${escape(state.connection)} · 所有项目</p><div class="run-list">${active.map(runRow).join("")}</div>${!active.length ? '<div class="empty">暂无后台任务</div>' : ""}${finished.length ? '<div class="results-heading">最近结果</div><div class="run-list">' + finished.map(runRow).join("") + "</div>" : ""}</div>`
  );
}
function detailPage() {
  const run = state.runs.find((item) => item.id === state.runId);
  if (!run) return allRunsPage();
  return (
    subnav("运行详情") +
    `<div class="detail-content"><h1 class="detail-title">${escape(run.title)}</h1><div class="detail-context">${escape(locationLabel(run))}<br>${escape(state.connection)}</div><div class="detail-meta"><span>${statusLabel(run)}</span><small>${run.status === "running" ? "已运行 " + escape(run.elapsed) : run.status === "queued" ? "等待执行" : run.status === "stopping" ? "等待进程退出" : "运行已结束"}</small></div><div class="label">运行输出</div><div class="log">${escape(run.output)}</div><details><summary>本次执行配置</summary><p>${escape(data.backgroundDefaults.model)} · ${escape(data.backgroundDefaults.effort)} · ${escape(data.backgroundDefaults.executionPolicy)}</p><p>${escape(run.prompt)}</p></details>${["running", "queued", "stopping"].includes(run.status) ? button("stop", run.status === "stopping" ? "正在停止…" : "停止本次运行", "stop", run.id) : ""}</div>`
  );
}
function terminalPage() {
  return `<div class="terminal-content"><p>${escape(state.terminalHistory)}</p>${state.sent.map((text) => `<p class="prompt">› ${escape(text)}</p><p>• 已接收指令。</p>`).join("")}</div>${state.composer ? `<div class="composer"><textarea id="draft" aria-label="终端输入框">${escape(state.draft)}</textarea><div class="composer-footer"><span>GPT-6.1-Sol · 中</span><button data-action="submit-draft" aria-label="发送输入框内容">${icon("send")}</button></div></div>` : `<div class="terminal-footer">${button("composer", "打开输入框", "text-button")}</div>`}`;
}
function overlay() {
  if (!state.overlay) return "";
  const { type, id } = state.overlay,
    item = commandById(id);
  let content = "";
  if (type === "command-menu")
    content = `<div class="sheet-title">${escape(item.title)}</div>${button("insert", icon("insert") + "插入输入框", "menu-item", id)}${button("edit", icon("edit") + "编辑指令", "menu-item", id)}${button("delete", icon("trash") + "删除指令", "menu-item danger", id)}${button("close", "取消", "cancel")}`;
  if (type === "library-menu")
    content = `<div class="sheet-title">快捷指令</div>${button("ordering", icon("sort") + (state.ordering ? "完成排序" : "管理排序"), "menu-item")}${button("close", "取消", "cancel")}`;
  if (type === "preview")
    content = `<div class="sheet-title">${escape(item.title)}</div><div class="full-text">${escape(item.data)}</div><div class="command-actions">${button("send", icon("send") + "发送到终端", "primary", id)}${button(runForCommand(id) ? "open-run" : "background", icon("play") + (runForCommand(id) ? "查看运行" : "后台运行"), "secondary", runForCommand(id)?.id || id)}</div>${button("close", "关闭", "cancel")}`;
  if (type === "add" || type === "edit")
    content = `<div class="sheet-title">${type === "add" ? "新增指令" : "编辑指令"}</div><label class="field">标题<input id="editor-title" value="${escape(item?.title || "")}" maxlength="80"></label><label class="field">指令内容<textarea id="editor-body">${escape(item?.data || "")}</textarea></label><div class="sheet-footer">${button("close", "取消", "secondary")}${button("save-command", "保存", "primary", id || "")}</div>`;
  if (type === "delete")
    content = `<div class="sheet-title">删除“${escape(item.title)}”？</div><div class="full-text">已创建的后台任务及运行记录会保留。</div>${button("confirm-delete", "删除指令", "menu-item danger", id)}${button("close", "取消", "cancel")}`;
  if (type === "stop")
    content = `<div class="sheet-title">停止本次运行？</div><div class="full-text">已经发生的文件或外部操作不会回滚。</div>${button("confirm-stop", "停止运行", "menu-item danger", id)}${button("close", "取消", "cancel")}`;
  if (type === "terminal-menu")
    content = `<div class="sheet-title">${escape(locationLabel(state.context))}</div>${button("close", "关闭", "cancel")}`;
  return `<div class="overlay" data-action="dismiss-overlay"><section class="sheet" role="dialog" aria-modal="true"><div class="grabber"></div>${content}</section></div>`;
}
function render() {
  const secondaryPage = ["all-runs", "detail"].includes(state.page);
  root.innerHTML = `<div class="statusbar"><span>9:41</span><span class="signals">${icon("signal")}${icon("wifi")}<span class="battery"><i></i></span></span></div>${secondaryPage ? "" : header()}${state.page === "commands" ? commandsPage() : state.page === "all-runs" ? allRunsPage() : state.page === "detail" ? detailPage() : state.page === "terminal" ? terminalPage() : `<div class="detail-content"><div class="empty">${state.page === "files" ? "README.md\npackages/\nbackend/" : "4 个文件有变更"}</div></div>`}<div class="home-indicator"></div>${overlay()}${state.toast ? `<div class="toast" role="status">${escape(state.toast)}</div>` : ""}`;
}
let toastTimer;
function notify(message) {
  state.toast = message;
  render();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    state.toast = "";
    render();
  }, 2200);
}
root.addEventListener("input", (event) => {
  if (event.target.id === "draft") state.draft = event.target.value;
});
root.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action,
    id = target.dataset.id,
    item = commandById(id);
  if (action === "dismiss-overlay") {
    if (event.target === target) state.overlay = null;
    else return;
  } else if (action === "close") state.overlay = null;
  else if (action === "tab") {
    state.page = id;
    state.overlay = null;
  } else if (action === "back") {
    state.page =
      state.page === "detail" ? state.detailFrom || "commands" : "commands";
    state.overlay = null;
  } else if (
    [
      "command-menu",
      "library-menu",
      "preview",
      "add",
      "edit",
      "delete",
      "stop",
      "terminal-menu",
    ].includes(action)
  )
    state.overlay = { type: action, id };
  else if (action === "all-runs") state.page = "all-runs";
  else if (action === "open-run") {
    state.detailFrom = ["commands", "all-runs"].includes(state.page)
      ? state.page
      : "commands";
    state.page = "detail";
    state.runId = id;
    state.overlay = null;
  } else if (action === "send") {
    state.sent.push(item.data);
    state.page = "terminal";
    state.overlay = null;
    notify("已发送到当前终端");
    return;
  } else if (action === "background") {
    if (runForCommand(id)) return;
    state.runs.unshift({
      id: "run-" + Date.now(),
      commandId: id,
      title: item.title,
      projectId: state.context.projectId,
      projectName: state.context.projectName,
      worktreeName: state.context.worktreeName,
      status: "queued",
      elapsed: "等待执行",
      prompt: item.data,
      output: "暂无输出",
    });
    state.overlay = null;
    notify("已提交 · " + locationLabel(state.context));
    return;
  } else if (action === "insert") {
    state.draft += (state.draft ? "\n" : "") + item.data;
    state.page = "terminal";
    state.composer = true;
    state.overlay = null;
  } else if (action === "composer") state.composer = true;
  else if (action === "submit-draft") {
    if (!state.draft.trim()) return;
    state.sent.push(state.draft);
    state.draft = "";
    state.composer = false;
  } else if (action === "ordering") {
    state.ordering = !state.ordering;
    state.overlay = null;
  } else if (action === "move-up" || action === "move-down") {
    const from = state.commands.findIndex((item) => item.id === id),
      to = from + (action === "move-up" ? -1 : 1);
    if (to >= 0 && to < state.commands.length)
      [state.commands[from], state.commands[to]] = [
        state.commands[to],
        state.commands[from],
      ];
  } else if (action === "confirm-delete") {
    state.commands = state.commands.filter((item) => item.id !== id);
    state.overlay = null;
    notify("指令已删除");
    return;
  } else if (action === "save-command") {
    const title = root.querySelector("#editor-title").value.trim(),
      body = root.querySelector("#editor-body").value;
    if (!body.trim()) {
      root.querySelector("#editor-body").focus();
      return;
    }
    if (item) {
      item.title = title || body.slice(0, 40);
      item.data = body;
    } else
      state.commands.push({
        id: "command-" + Date.now(),
        title: title || body.slice(0, 40),
        data: body,
      });
    state.overlay = null;
  } else if (action === "confirm-stop") {
    const run = state.runs.find((item) => item.id === id);
    run.status = "stopping";
    state.overlay = null;
    render();
    setTimeout(() => {
      run.status = "cancelled";
      run.output += "\n\n运行已停止。";
      render();
    }, 900);
    return;
  }
  render();
});
render();
