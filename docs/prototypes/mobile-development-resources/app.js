/* global document, fetch, window, URLSearchParams, setTimeout */
const app = document.querySelector("#app");
const params = new URLSearchParams(window.location.search);
const icons = ["▱", "▦", "◴", "◷", "＋", "↻", "ⓘ", "⇥"];
const labels = {
  busy: "占用中",
  free: "空闲",
  blocked: "待释放",
  unknown: "归属未知",
  running: "释放中",
};
let data;
let view = params.get("view") === "resources" ? "resources" : "home";
let group = params.get("group") === "simulators" ? "simulators" : "desktop";
let menuOpen = params.get("view") === "entry";
let filter = "all";
const expanded = new Set();
let pending = null;
let message = null;
let refreshes = 0;
let releases = 0;
let refreshing = false;
let observedAt = "";
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const findResource = (id) =>
  [...data.desktop, ...data.simulators].find((item) => item.id === id);
const actionLabel = (item) =>
  item.action === "release" ? "释放占用" : "停止并释放";
function counts(items) {
  return {
    total: items.length,
    busy: items.filter((item) => ["busy", "running"].includes(item.state))
      .length,
    free: items.filter((item) => item.state === "free").length,
    attention: items.filter((item) =>
      ["unknown", "blocked"].includes(item.state),
    ).length,
  };
}
function navigation() {
  return view === "home"
    ? `<header class="navigation"><div class="nav-button connection"><i class="online"></i>${escape(data.host)}</div><strong>Runweave</strong><button class="nav-button icon" aria-label="首页菜单" data-action="menu"><span class="ellipsis">···</span></button></header>`
    : `<header class="navigation"><button class="nav-button" data-action="back"><span class="back">‹</span>Runweave</button><strong>开发资源</strong><button class="nav-button icon" aria-label="刷新" data-action="refresh" ${refreshing ? "disabled" : ""}>${refreshing ? "⋯" : "↻"}</button></header>`;
}
function home() {
  return `<div class="scroll"><div class="search">⌕　Search projects and terminals</div><div class="section-title">关注</div><section class="home-card"><h2>${escape(data.project.terminal)}</h2><p>${escape(data.project.name)} · ${escape(data.project.branch)}</p><p>${escape(data.project.preview)}</p></section><div class="section-title">知识收件箱</div><section class="home-card"><p>暂无待处理内容</p></section><div class="home-title"><span>⌄　${escape(data.project.name)} · ${escape(data.project.branch)}</span><span>＋</span></div><div class="terminal-row">${escape(data.project.terminal)}<span class="status">已结束</span><p>${escape(data.project.preview)}</p></div></div>${menuOpen ? `<div class="menu-shade" data-action="dismiss-menu"></div><div class="menu" role="menu">${data.menu.map((label, i) => `<button role="menuitem" data-action="${label === "开发资源" ? "open-resources" : "existing-menu"}">${escape(label)}<span aria-hidden="true">${icons[i]}</span></button>`).join("")}</div>` : ""}`;
}
function summary(key, title, icon) {
  const value = counts(data[key]);
  return `<button class="summary-card" data-group="${key}" aria-label="${title}，占用 ${value.busy}，总计 ${value.total}"><div class="summary-heading"><span>${icon}</span>${title}</div><div class="summary-value"><b>${value.busy}</b><span>/ ${value.total} 占用</span></div><div class="summary-foot">${value.free} 空闲${value.attention ? ` · <span class="attention">${value.attention} 待检查</span>` : ""}</div></button>`;
}
function details(item) {
  return `<div class="detail"><p>归属进程</p><p>${item.processes.length ? item.processes.map(escape).join("<br>") : "无运行中的归属进程"}</p>${item.ports ? `<p>端口　${escape(item.ports)}</p>` : ""}${item.deviceState ? `<p>设备　${escape(item.deviceState)}</p>` : ""}${item.udid ? `<p class="path">UDID ${escape(item.udid)}</p>` : ""}${item.path ? `<p class="path">${escape(item.path)}</p>` : ""}</div>`;
}
function resourceCard(item) {
  if (item.state === "free")
    return `<div class="free-row"><span>${escape(item.label)}${item.deviceState ? `<span class="muted"> · ${escape(item.deviceState)}</span>` : ""}</span><span class="state free">空闲</span></div>`;
  return `<article class="resource" data-resource="${item.id}"><div class="resource-heading"><h2>${escape(item.label)}</h2><span class="state ${item.state}">${labels[item.state]}</span></div><div class="task">${escape(item.task ?? "占用者未确认")}</div>${item.worktree ? `<div class="facts"><span class="worktree">${escape(item.worktree)}</span><span>占用 ${escape(item.elapsed)}</span>${item.deviceState ? `<span>· ${escape(item.deviceState)}</span>` : ""}</div><p class="activity">最后活动 ${escape(item.activity)}</p>` : ""}${item.reason ? `<p class="reason">${escape(item.reason)}</p>` : ""}${item.state === "running" ? '<p class="reason">正在清理资源，完成后将更新占用状态。</p>' : ""}<div class="card-actions"><button class="details-button" data-details="${item.id}" aria-expanded="${expanded.has(item.id)}">${expanded.has(item.id) ? "收起详情 ⌃" : "查看详情 ⌄"}</button>${item.action && item.state !== "running" ? `<button class="release-button" data-release="${item.id}">${actionLabel(item)}</button>` : `<span class="protected">${item.state === "running" ? "处理中" : item.id === "desk-02" ? "当前环境 · 无法释放" : "无法释放"}</span>`}</div>${expanded.has(item.id) ? details(item) : ""}</article>`;
}
function resourcePage() {
  const items = data[group].filter(
    (item) =>
      filter === "all" ||
      (filter === "busy"
        ? ["busy", "running"].includes(item.state)
        : ["unknown", "blocked"].includes(item.state)),
  );
  return `<div class="scroll"><div class="hostline"><span><i class="online"></i> ${escape(data.host)} · 当前连接</span><span>更新于 ${observedAt}</span></div>${message ? `<div class="toast ${message.warning ? "warning" : ""}" role="status">${escape(message.text)}</div>` : ""}<div class="summary">${summary("desktop", "桌面测试", "▱")}${summary("simulators", "模拟器测试", "▯")}</div><div class="segmented" role="tablist">${[
    ["desktop", "桌面"],
    ["simulators", "模拟器"],
  ]
    .map(
      ([key, label]) =>
        `<button role="tab" aria-selected="${group === key}" class="${group === key ? "selected" : ""}" data-group="${key}">${label} ${data[key].length}</button>`,
    )
    .join("")}</div><div class="filters" aria-label="资源状态">${[
    ["all", "全部"],
    ["busy", "占用中"],
    ["attention", "待检查"],
  ]
    .map(
      ([key, label]) =>
        `<button class="filter ${filter === key ? "selected" : ""}" data-filter="${key}" aria-pressed="${filter === key}">${label}</button>`,
    )
    .join(
      "",
    )}</div>${items.length ? items.map(resourceCard).join("") : '<div class="empty">没有符合条件的资源</div>'}</div>`;
}
function confirmation() {
  const item = findResource(pending);
  const simulator = item.id.startsWith("sim");
  return `<div class="sheet-shade"><section class="sheet" role="dialog" aria-modal="true" aria-labelledby="confirm-title"><div class="grabber"></div><h2 id="confirm-title">${actionLabel(item)}？</h2><p class="sheet-subtitle">${escape(data.host)} · ${simulator ? "模拟器测试" : "桌面测试"}</p><div class="confirmation-resource"><strong>${escape(item.label)}</strong><p>${escape(item.task)}</p><p>工作树　${escape(item.worktree)}</p></div><p class="warning">${item.action === "stop" ? "<b>将中断这个资源上的测试任务。</b><br>" : ""}${simulator ? "将清理本任务的自动化进程，关闭模拟器并释放占用。" : "将停止本会话的服务、清理测试环境并释放槽位。"}其他任务不受影响。</p><div class="sheet-actions"><button class="destructive" data-action="confirm">${actionLabel(item)}</button><button data-action="cancel" id="cancel-release">取消</button></div></section></div>`;
}
function render() {
  const scroll = document.querySelector(".scroll")?.scrollTop ?? 0;
  app.innerHTML = `<div class="statusbar"><span>9:41</span><span>▮▮▮ ◜  ▰</span></div><div class="island"></div>${navigation()}${view === "home" ? home() : resourcePage()}${pending ? confirmation() : ""}<div class="home-indicator"></div>`;
  if (view === "resources")
    document.querySelector(".scroll").scrollTop = scroll;
  document.querySelector(".scroll").inert = Boolean(pending);
  document.querySelector(".navigation").inert = Boolean(pending);
  if (pending)
    document.querySelector("#cancel-release").focus({ preventScroll: true });
}
function readSnapshot() {
  refreshes++;
  observedAt = new Date().toLocaleTimeString("zh-CN", { hour12: false });
}
function openResources() {
  view = "resources";
  menuOpen = false;
  message = null;
  readSnapshot();
  render();
  document.querySelector(".scroll").scrollTop = 0;
}
function beginRelease() {
  const item = findResource(pending);
  pending = null;
  if (params.get("outcome") === "owner-changed") {
    item.task = "新的验收任务";
    item.worktree = "wt-3";
    message = {
      warning: true,
      text: "占用者已变化，未释放资源。请刷新后查看新的任务。",
    };
    render();
    return;
  }
  releases++;
  item.state = "running";
  render();
  setTimeout(() => {
    if (params.get("outcome") === "blocked") {
      item.state = "blocked";
      item.reason = "自动化进程尚未退出，占用仍保留。";
      item.action = null;
      message = { warning: true, text: "释放未完成，请查看资源详情。" };
    } else {
      item.state = "free";
      item.task = null;
      item.action = null;
      item.processes = [];
      item.reason = null;
      if (item.deviceState) item.deviceState = "Shutdown";
      message = { text: `${item.label} 已释放` };
    }
    readSnapshot();
    render();
  }, 1700);
}
app.addEventListener("click", (event) => {
  const button = event.target.closest("button, [data-action]");
  if (!button || button.disabled) return;
  if (button.dataset.group) {
    group = button.dataset.group;
    render();
    document.querySelector(".scroll").scrollTop = 0;
    return;
  }
  if (button.dataset.filter) {
    filter = button.dataset.filter;
    render();
    return;
  }
  if (button.dataset.details) {
    const id = button.dataset.details;
    expanded.has(id) ? expanded.delete(id) : expanded.add(id);
    render();
    return;
  }
  if (button.dataset.release) {
    pending = button.dataset.release;
    render();
    return;
  }
  switch (button.dataset.action) {
    case "menu":
      menuOpen = !menuOpen;
      render();
      break;
    case "dismiss-menu":
      menuOpen = false;
      render();
      break;
    case "open-resources":
      openResources();
      break;
    case "back":
      view = "home";
      pending = null;
      render();
      break;
    case "cancel":
      pending = null;
      render();
      break;
    case "confirm":
      beginRelease();
      break;
    case "refresh":
      refreshing = true;
      render();
      setTimeout(() => {
        refreshing = false;
        readSnapshot();
        render();
      }, 500);
      break;
    case "existing-menu":
      menuOpen = false;
      render();
      break;
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    pending = null;
    menuOpen = false;
    render();
  }
});
// Browser verification only. No mock controls appear in the product interface.
window.prototypeMetrics = () => ({
  refreshes,
  releases,
  view,
  group,
  filter,
  pending,
  states: Object.fromEntries(
    [...data.desktop, ...data.simulators].map((item) => [item.id, item.state]),
  ),
});
fetch("./mock-state.json")
  .then((response) => {
    if (!response.ok) throw new Error("原型数据读取失败");
    return response.json();
  })
  .then((state) => {
    data = state;
    if (view === "resources") {
      readSnapshot();
      const target = findResource(params.get("confirm"));
      if (target?.action) pending = target.id;
    }
    render();
  })
  .catch(() => {
    app.textContent = "页面加载失败，请重试。";
  });
