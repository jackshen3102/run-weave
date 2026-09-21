import {
  escapeHtml as e,
  icon,
  button,
  showDialog,
  toast,
} from "./ui.js?v=3-source";
import { openEditor } from "./editor.js?v=3-source";
import {
  renderTasks,
  renderDetail,
  renderProjects,
  renderTerminal,
} from "./views.js?v=3-source";
const app = document.getElementById("app");
const storageKey = "runweave.prototype.agent-scheduled-tasks.v3-source";
const params = new URLSearchParams(location.search);
let state,
  fixtures,
  backendId = "local",
  scope = "all",
  query = "",
  expanded = false,
  sourceRunId = null;
let route = { view: "tasks" },
  terminalReturn = "#tasks";
const timers = new Map(),
  turnTimers = new Map();
const busyStatuses = new Set(["queued", "running", "waiting"]);
const backend = () => state.backends.find((b) => b.id === backendId);
const taskById = (id) => state.tasks.find((t) => t.id === id);
const runById = (id) => state.runs.find((r) => r.id === id);
const tasks = () =>
  state.tasks.filter((t) => t.backendId === backendId && !t.deleted);
const runs = () =>
  state.runs
    .filter((r) => r.snapshot.backendId === backendId)
    .sort((a, b) => b.at.localeCompare(a.at));
const projectName = (t) =>
  state.backends
    .find((b) => b.id === t.backendId)
    ?.projects.find((p) => p.id === t.projectId)?.name || t.projectId;
const isBusy = (id) =>
  state.runs.some((r) => r.taskId === id && busyStatuses.has(r.status));
function save() {
  try {
    localStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    /* Memory-only use still works. */
  }
}
function readRoute() {
  const [view, id] = location.hash.slice(1).split("/");
  route = {
    view: ["tasks", "task", "terminal", "projects"].includes(view)
      ? view
      : "tasks",
    id,
  };
}
function navigate(hash) {
  if (hash.startsWith("#terminal/")) terminalReturn = location.hash || "#tasks";
  expanded = false;
  if (location.hash === hash) {
    readRoute();
    render();
  } else {
    location.hash = hash;
    readRoute();
    render();
  }
}
function context() {
  return {
    backend: backend(),
    tasks: tasks(),
    runs: runs(),
    scope,
    query,
    expanded,
    sourceRunId,
    now: state.now,
    projectName,
    isBusy,
    latest: (id) => runs().find((r) => r.taskId === id),
  };
}
function render() {
  const b = backend(),
    c = context();
  const focused = document.activeElement?.id;
  const inputStart = document.activeElement?.selectionStart;
  const scroll = app.querySelector(".page-scroll")?.scrollTop || 0;
  let content = "";
  const terminal = route.view === "terminal" ? runById(route.id) : null;
  if (terminal && b.online && terminal.snapshot.backendId === backendId)
    ensureTerminal(terminal);
  if (!b.online)
    content =
      '<div class="empty"><h1>后端未连接</h1><p>连接恢复后可继续管理任务和打开终端。</p></div>';
  else if (terminal && terminal.snapshot.backendId === backendId)
    content = renderTerminal(c, terminal);
  else if (route.view === "projects") content = renderProjects(c);
  else if (
    route.view === "task" &&
    taskById(route.id) &&
    !taskById(route.id).deleted &&
    taskById(route.id).backendId === backendId
  )
    content = renderDetail(c, taskById(route.id));
  else content = renderTasks(c);
  app.innerHTML = `<div class="app-shell ${terminal && b.online ? "is-terminal" : ""}"><header class="app-header"><button class="wordmark" data-action="projects" aria-label="Runweave 项目">RUNWEAVE</button><div class="row"><label class="connection"><span class="dot ${b.online ? "" : "offline"}"></span><select id="backend-select" aria-label="当前连接">${state.backends.map((item) => `<option value="${item.id}" ${item.id === backendId ? "selected" : ""}>${e(item.name)}</option>`).join("")}</select></label><button class="icon-button" data-action="theme" aria-label="切换主题">${icon(document.documentElement.classList.contains("dark") ? "sun" : "moon")}</button></div></header><main class="${terminal && b.online ? "terminal-page" : "page-scroll"}"><div class="${terminal && b.online ? "terminal-frame" : "page-content"}">${content}</div></main></div>`;
  if (!terminal) app.querySelector(".page-scroll").scrollTop = scroll;
  if (
    focused &&
    document.getElementById(focused) &&
    !document.getElementById(focused).disabled
  ) {
    const input = document.getElementById(focused);
    input.focus();
    if (typeof inputStart === "number")
      input.setSelectionRange(inputStart, inputStart);
  }
}
function setupThread(r) {
  r.thread ??= {
    id: `thread-${r.id}`,
    provider: r.snapshot.agent,
    messages: [],
    draft: "",
    followupBusy: false,
  };
}
function ensureTerminal(r) {
  setupThread(r);
  const project = state.backends
    .find((b) => b.id === r.snapshot.backendId)
    ?.projects.find((p) => p.id === r.snapshot.projectId);
  r.workspace ??= {
    projectId: project.id,
    name: project.name,
    cwd: project.path,
  };
  r.terminal ??= { id: crypto.randomUUID(), threadId: r.thread.id };
  Object.assign(r.terminal, {
    projectId: r.workspace.projectId,
    cwd: r.workspace.cwd,
    source: { type: "scheduled-task", taskId: r.taskId, runId: r.id },
  });
  r.unread = false;
  save();
}
function editTask(id) {
  const task = id ? taskById(id) : null;
  openEditor({
    task,
    backend: backend(),
    agents: state.agents,
    now: state.now,
    projectId: scope === "all" ? null : scope,
    onSave: (change) => {
      let target = task;
      if (task) Object.assign(task, change);
      else {
        target = {
          ...change,
          id: crypto.randomUUID(),
          backendId,
          enabled: true,
          icon: "clock",
          description: change.prompt.split("\n")[0],
        };
        state.tasks.push(target);
      }
      save();
      navigate("#task/" + target.id);
      render();
      toast(task ? "已保存，后续运行使用新配置" : "任务已创建");
    },
  });
}
function completeRun(id) {
  const r = runById(id);
  if (!r || !["running", "queued"].includes(r.status)) return;
  r.status = "completed";
  r.summary = state.simulation.completionSummary;
  r.progress = null;
  r.duration = "1 分钟";
  r.unread = !(route.view === "terminal" && route.id === id);
  timers.delete(id);
  save();
  render();
  toast("本次定时运行已完成");
}
function startRun(id) {
  const t = taskById(id);
  if (!t || t.deleted || !backend().online) return;
  if (isBusy(id)) {
    toast("该任务已有运行尚未结束");
    return;
  }
  const at = new Date(state.now).valueOf() + state.runs.length * 1000;
  const r = {
    id: crypto.randomUUID(),
    taskId: id,
    at: new Date(at).toISOString(),
    status: "queued",
    trigger: "手动运行",
    duration: "刚刚",
    unread: false,
    summary: state.simulation.queuedSummary,
    artifact: null,
    snapshot: { ...structuredClone(t), projectName: projectName(t) },
  };
  setupThread(r);
  state.runs.unshift(r);
  save();
  navigate("#task/" + id);
  render();
  toast("已加入运行队列");
  timers.set(
    r.id,
    setTimeout(() => {
      if (r.status !== "queued") return;
      r.status = "running";
      r.summary = state.simulation.runningSummary;
      save();
      render();
      timers.set(
        r.id,
        setTimeout(() => completeRun(r.id), state.simulation.runMs),
      );
    }, state.simulation.queueMs),
  );
}
function confirmAction(title, message, label, callback) {
  const dialog = showDialog(
    "confirmation",
    `<header><h2 id="confirmation-title">${e(title)}</h2><button class="icon-button" data-close="confirmation" aria-label="关闭">${icon("x")}</button></header><div class="confirm-body">${e(message)}</div><footer>${button("取消", "close-confirm", "", "ghost")}<button class="button danger" id="confirm-action">${e(label)}</button></footer>`,
  );
  dialog.querySelector("#confirm-action").onclick = () => {
    callback();
    dialog.close();
  };
}
function openArtifact(id) {
  const r = runById(id);
  if (!r.artifact) return;
  showDialog(
    "preview",
    `<header><div><h2 id="preview-title">${e(r.artifact.title)}</h2><p>${e(r.artifact.subtitle)}</p></div><button class="icon-button" data-close="preview" aria-label="关闭">${icon("x")}</button></header><article class="preview-body">${e(r.artifact.body)}</article>`,
  );
}
function openTerminal(id) {
  const r = runById(id);
  if (!r) return;
  ensureTerminal(r);
  navigate("#terminal/" + id);
}
function stopRun(id) {
  const r = runById(id);
  confirmAction(
    "停止当前执行？",
    "已产生的文件和外部操作不会被撤销，后续定时安排不受影响。",
    "停止执行",
    () => {
      if (r.thread.followupBusy) {
        clearTimeout(turnTimers.get(id));
        r.thread.followupBusy = false;
        if (r.status === "running") r.status = "waiting";
        r.thread.messages.push({ role: "agent", text: "已停止本轮回复。" });
      } else {
        clearTimeout(timers.get(id));
        r.status = "cancelled";
        r.summary = "本次定时执行已手动停止。";
        r.progress = null;
      }
      save();
      render();
    },
  );
}
function sendFollowup() {
  const r = runById(route.id);
  if (
    !r ||
    !r.terminal ||
    r.thread.followupBusy ||
    ["queued", "running"].includes(r.status)
  )
    return;
  const text = r.thread.draft.trim();
  if (!text) return;
  const continuing = r.status === "waiting";
  r.thread.messages.push({ role: "user", text });
  r.thread.draft = "";
  r.thread.followupBusy = true;
  if (continuing) {
    r.status = "running";
    r.progress = null;
  }
  save();
  render();
  scrollTerminal();
  turnTimers.set(
    r.id,
    setTimeout(() => {
      r.thread.followupBusy = false;
      r.thread.messages.push({
        role: "agent",
        text:
          state.simulation.followupReplies[r.taskId] ||
          state.simulation.followupReplies.default,
      });
      if (continuing) {
        r.status = "completed";
        r.summary = state.simulation.researchCompletion;
        r.artifact = structuredClone(
          fixtures.runs.find((item) => item.id === "research-0914").artifact,
        );
      }
      save();
      render();
      scrollTerminal();
    }, state.simulation.followupMs),
  );
}
function scrollTerminal() {
  const el = document.getElementById("terminal-output");
  if (el) el.scrollTop = el.scrollHeight;
}
document.addEventListener("click", (event) => {
  const close = event.target.closest("[data-close]");
  if (close) {
    document.getElementById(close.dataset.close).close();
    return;
  }
  const target = event.target.closest("[data-action]");
  if (!target || target.disabled) return;
  const { action, id } = target.dataset;
  for (const menu of document.querySelectorAll(".action-menu[open]"))
    menu.removeAttribute("open");
  if (action === "create") {
    editTask();
    return;
  }
  if (action === "edit") {
    editTask(id);
    return;
  }
  if (action === "close-editor") {
    document.getElementById("editor").close();
    return;
  }
  if (action === "close-confirm") {
    document.getElementById("confirmation").close();
    return;
  }
  if (action === "tasks") {
    navigate("#tasks");
    return;
  }
  if (action === "projects") {
    navigate("#projects");
    return;
  }
  if (action === "detail") {
    const t = taskById(id);
    if (!t || t.deleted) {
      toast("任务已删除，对话仍可继续");
      return;
    }
    navigate("#task/" + id);
    return;
  }
  if (action === "source") {
    const source = runById(id)?.terminal?.source;
    if (!source) return;
    if (taskById(source.taskId)?.deleted) {
      toast("来源任务已删除，对话仍保留");
      return;
    }
    sourceRunId = source.runId;
    navigate("#task/" + source.taskId);
    app
      .querySelector(`[data-action="terminal"][data-id="${source.runId}"]`)
      ?.scrollIntoView({ block: "nearest" });
    return;
  }
  if (action === "terminal") {
    openTerminal(id);
    return;
  }
  if (action === "terminal-back") {
    navigate(
      terminalReturn.startsWith("#terminal/")
        ? "#task/" + runById(route.id).taskId
        : terminalReturn,
    );
    return;
  }
  if (action === "run") {
    startRun(id);
    return;
  }
  if (action === "expand") expanded = !expanded;
  if (action === "toggle") {
    const t = taskById(id);
    t.enabled = !t.enabled;
    save();
    toast(t.enabled ? "任务已启用" : "已暂停后续触发，当前运行不受影响");
  }
  if (action === "theme") document.documentElement.classList.toggle("dark");
  if (action === "artifact") {
    openArtifact(id);
    return;
  }
  if (action === "stop") {
    stopRun(id);
    return;
  }
  if (action === "delete") {
    const t = taskById(id);
    confirmAction(
      "删除任务？",
      `将删除“${t.name}”的后续安排。已打开的终端会保留，运行记录不会被清除。`,
      "删除任务",
      () => {
        t.deleted = true;
        t.enabled = false;
        save();
        navigate("#tasks");
        render();
        toast("任务已删除，终端与历史已保留");
      },
    );
    return;
  }
  render();
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".action-menu"))
    for (const menu of document.querySelectorAll(".action-menu[open]"))
      menu.open = false;
});
document.addEventListener("change", (event) => {
  if (event.target.id === "backend-select") {
    backendId = event.target.value;
    scope = "all";
    query = "";
    navigate("#tasks");
    render();
  }
  if (event.target.id === "project-filter") {
    scope = event.target.value;
    render();
  }
});
document.addEventListener("input", (event) => {
  if (event.target.id === "task-search") {
    query = event.target.value;
    render();
  }
  if (event.target.id === "terminal-input") {
    runById(route.id).thread.draft = event.target.value;
    save();
  }
});
document.addEventListener("submit", (event) => {
  if (event.target.id === "terminal-form") {
    event.preventDefault();
    sendFollowup();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape")
    for (const menu of document.querySelectorAll(".action-menu[open]"))
      menu.open = false;
  if (
    event.target.id === "terminal-input" &&
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.isComposing
  ) {
    event.preventDefault();
    sendFollowup();
  }
});
window.addEventListener("hashchange", () => {
  readRoute();
  render();
  const page = app.querySelector(".page-scroll");
  if (page) page.scrollTop = 0;
});
for (const dialog of document.querySelectorAll("dialog"))
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      const box = dialog.getBoundingClientRect();
      if (
        event.clientX < box.left ||
        event.clientX > box.right ||
        event.clientY < box.top ||
        event.clientY > box.bottom
      )
        dialog.close();
    }
  });
async function init() {
  const response = await fetch("./mock-state.json?v=3-source");
  if (!response.ok) throw new Error("无法加载任务数据");
  fixtures = await response.json();
  state = structuredClone(fixtures);
  try {
    if (params.has("reset")) localStorage.removeItem(storageKey);
    const stored = JSON.parse(localStorage.getItem(storageKey) || "null");
    if (stored?.tasks && stored?.runs) state = stored;
  } catch {
    /* Fall back to the local fixture. */
  }
  for (const r of state.runs) {
    if (!r.snapshot) {
      const t = taskById(r.taskId);
      r.snapshot = { ...structuredClone(t), projectName: projectName(t) };
    }
    setupThread(r);
    if (r.thread.followupBusy) {
      r.thread.followupBusy = false;
      if (r.status === "running") r.status = "waiting";
      r.thread.messages.push({
        role: "agent",
        text: "连接已恢复，可以继续输入。",
      });
    }
  }
  if (params.get("theme") === "light")
    document.documentElement.classList.remove("dark");
  if (
    params.get("backend") &&
    state.backends.some((b) => b.id === params.get("backend"))
  )
    backendId = params.get("backend");
  readRoute();
  if (route.view === "terminal" && runById(route.id)) {
    backendId = runById(route.id).snapshot.backendId;
    terminalReturn = "#task/" + runById(route.id).taskId;
  }
  if (params.get("empty") === "1") {
    state.tasks = [];
    state.runs = [];
  }
  render();
  for (const r of state.runs)
    if (r.trigger === "手动运行" && ["running", "queued"].includes(r.status)) {
      r.status = "running";
      timers.set(
        r.id,
        setTimeout(() => completeRun(r.id), state.simulation.runMs),
      );
    }
}
init().catch((error) => {
  app.innerHTML = `<main class="empty"><h1>页面加载失败</h1><p>${e(error.message)}</p></main>`;
});
