import {
  escapeHtml as e,
  icon,
  pill,
  button,
  formatTime,
  scheduleLabel,
  nextRun,
} from "./ui.js?v=3-source";
const time = (r) => formatTime(r.at, r.snapshot.schedule.timezone);
function switchControl(t) {
  return `<button class="switch" role="switch" aria-checked="${t.enabled}" data-action="toggle" data-id="${t.id}" aria-label="启用 ${e(t.name)}"><span></span></button>`;
}
function taskMenu(t, busy) {
  return `<details class="action-menu"><summary aria-label="更多操作 ${e(t.name)}">${icon("more")}</summary><div class="menu-popover">${button("立即运行", "run", t.id, "ghost", "play").replace("<button ", `<button ${busy ? "disabled " : ""}`)}${button("编辑", "edit", t.id, "ghost", "edit")}${button("删除", "delete", t.id, "ghost danger", "x")}</div></details>`;
}
function empty(title, description, create = false) {
  return `<section class="empty">${icon("calendar")}<h2>${title}</h2><p>${description}</p>${create ? button("新建任务", "create", "", "primary", "plus") : ""}</section>`;
}
export function renderTasks(c) {
  const tasks = c.tasks.filter(
    (t) =>
      (c.scope === "all" || t.projectId === c.scope) &&
      `${t.name} ${t.prompt}`.toLowerCase().includes(c.query.toLowerCase()),
  );
  return `<div class="page-title"><div class="row"><button class="icon-button" data-action="projects" aria-label="返回项目">${icon("arrow")}</button><h1>定时任务</h1></div>${button("新建任务", "create", "", "primary", "plus")}</div><div class="list-tools"><select id="project-filter" aria-label="筛选项目"><option value="all">所有项目</option>${c.backend.projects.map((p) => `<option value="${p.id}" ${c.scope === p.id ? "selected" : ""}>${e(p.name)}</option>`).join("")}</select><label class="search">${icon("search")}<input id="task-search" placeholder="搜索任务" aria-label="搜索任务" value="${e(c.query)}" /></label></div>
 <div class="task-cards">${tasks
   .map((t) => {
     const run = c.latest(t.id);
     return `<article class="task-card"><div class="card-heading"><button class="task-title" data-action="detail" data-id="${t.id}">${e(t.name)}${run?.unread ? '<span class="unread" aria-label="有新结果"></span>' : ""}</button>${switchControl(t)}</div><div class="card-context"><span class="project-tag">${e(c.projectName(t))}</span><span>${e(t.agent)}</span>${!t.enabled ? "<span>已暂停</span>" : run && ["running", "queued", "waiting"].includes(run.status) ? pill(run.status) : ""}</div><button class="prompt-link" data-action="detail" data-id="${t.id}"><span class="prompt-excerpt">${e(t.prompt)}</span></button><footer class="card-footer"><span class="row">${icon("clock")}${e(scheduleLabel(t.schedule))}</span>${taskMenu(t, c.isBusy(t.id))}</footer></article>`;
   })
   .join(
     "",
   )}</div>${!tasks.length ? empty(c.query ? "没有找到任务" : "还没有定时任务", c.query ? "试试其他任务名称。" : "选择项目，安排 Agent 定期完成工作。", !c.query) : ""}`;
}
export function renderDetail(c, t) {
  const runs = c.runs.filter((r) => r.taskId === t.id);
  return `<div class="page-title"><button class="back" data-action="tasks">${icon("arrow")}定时任务</button><div class="row">${button("编辑", "edit", t.id, "ghost", "edit")}${taskMenu(t, c.isBusy(t.id))}</div></div><article class="task-card detail-card"><div class="card-heading"><h1>${e(t.name)}</h1>${switchControl(t)}</div><div class="card-context"><span class="project-tag">${e(c.projectName(t))}</span><span>${e(t.agent)}</span>${!t.enabled ? "<span>已暂停</span>" : ""}</div><div class="task-prompt"><p class="prompt-excerpt ${c.expanded ? "expanded" : ""}">${e(t.prompt)}</p><button class="text-button" data-action="expand">${c.expanded ? "收起" : "展开提示词"}</button></div><footer class="card-footer"><span class="row">${icon("clock")}${e(scheduleLabel(t.schedule))}</span><span>${e(t.model === "默认" ? t.agent + " 默认配置" : t.model)}</span></footer></article><p class="schedule-note">${t.enabled ? "下次运行 " + e(nextRun(t.schedule, c.now) || "—") : "已暂停后续运行"} · ${e(t.schedule.timezone)}</p><div class="section-heading"><h2>运行历史</h2><span>${runs.length} 次</span></div><section class="history-list">${runs.length ? runs.map((r) => `<button class="history-row ${c.sourceRunId === r.id ? "source-run" : ""}" data-action="terminal" data-id="${r.id}"><div class="grow"><div class="row history-title"><strong>${time(r)}</strong>${r.unread ? '<span class="unread" aria-label="有新结果"></span>' : ""}</div><p>${e(r.summary)}</p><small>${e(r.trigger)} · ${e(r.duration)}</small></div><div class="history-state">${pill(r.status)}${icon("chevron")}</div></button>`).join("") : '<div class="empty compact"><p>还没有运行记录</p>' + button("立即运行", "run", t.id, "", "play") + "</div>"}</section>`;
}
function terminalRow(r) {
  return `<button class="project-terminal" data-action="terminal" data-id="${r.id}"><span class="terminal-row-icon">${icon("terminal")}</span><span class="grow"><strong>${e(r.snapshot.name)} · ${time(r).split(" ")[0]}</strong><span class="terminal-row-meta">${e(r.snapshot.agent)}${r.workspace.parentProjectId ? " · " + e(r.workspace.name) : ""} · 定时任务${r.thread.followupBusy ? " · 正在回复" : ""}</span></span>${r.unread ? '<span class="unread" aria-label="有新结果"></span>' : ""}${pill(r.status)}${icon("chevron")}</button>`;
}
export function renderProjects(c) {
  const opened = c.runs.filter((r) => r.terminal);
  const active = opened.filter(
    (r) =>
      r.unread ||
      ["queued", "running", "waiting"].includes(r.status) ||
      r.thread.followupBusy,
  );
  return `<div class="page-title"><h1>项目</h1>${button("定时任务", "tasks", "", "", "calendar")}</div>${active.length ? `<div class="section-heading"><h2>关注</h2><span>${active.length}</span></div><section class="history-list attention-list">${active.map(terminalRow).join("")}</section>` : ""}${c.backend.projects
    .map((p) => {
      const terminals = opened.filter(
        (r) => (r.workspace.parentProjectId || r.terminal.projectId) === p.id,
      );
      return `<section class="project-section"><div class="section-heading"><div class="row">${icon("folder")}<h2>${e(p.name)}</h2></div><span>${terminals.length} 个终端</span></div><section class="history-list">${terminals.length ? terminals.map(terminalRow).join("") : '<p class="empty-note">暂无终端</p>'}</section></section>`;
    })
    .join("")}`;
}
export function renderTerminal(c, r) {
  const t = r.snapshot,
    term = r.thread;
  const active = ["queued", "running"].includes(r.status) || term.followupBusy;
  return `<section class="terminal-workspace" data-terminal-id="${e(r.terminal.id)}"><header class="terminal-heading"><button class="icon-button" data-action="projects" aria-label="返回项目">${icon("arrow")}</button><div class="grow"><h1>${e(t.name)} · ${time(r)}</h1><p>${e(t.projectName)}${r.workspace.parentProjectId ? " / " + e(r.workspace.name) : ""} · ${e(t.agent)}</p></div></header><button class="terminal-source" data-action="source" data-id="${r.id}" aria-label="返回来源：${e(t.name)}">${icon("calendar")}<span>来源：${e(t.name)}</span>${icon("chevron")}</button><div class="terminal-output" id="terminal-output" tabindex="0" aria-label="终端内容"><div class="terminal-welcome"><strong>${e(t.agent)}</strong><span>${e(r.workspace.cwd)}</span></div><div class="terminal-turn user-turn"><span class="turn-marker">›</span><div>${e(t.prompt)}</div></div><div class="terminal-turn agent-turn"><span class="turn-marker">•</span><div><p>${e(r.summary)}</p>${r.progress ? `<p class="terminal-progress">${e(r.progress)}</p>` : ""}${r.artifact ? `<button class="terminal-artifact" data-action="artifact" data-id="${r.id}">${icon(r.artifact.type === "pr" ? "git" : "file")}<span>${e(r.artifact.title)}</span>${icon("external")}</button>` : ""}</div></div>${term.messages.map((m) => `<div class="terminal-turn ${m.role === "user" ? "user-turn" : "agent-turn"}"><span class="turn-marker">${m.role === "user" ? "›" : "•"}</span><div>${e(m.text)}</div></div>`).join("")}${term.followupBusy ? '<p class="terminal-thinking">正在回复…</p>' : ""}</div><div class="terminal-bottom"><form id="terminal-form" class="terminal-composer"><textarea id="terminal-input" aria-label="终端输入" rows="2" placeholder="${r.status === "waiting" ? "输入补充信息，继续处理…" : "继续追问或输入新的要求…"}" ${active ? "disabled" : ""}>${e(term.draft || "")}</textarea><div class="composer-footer"><span class="row"><span class="dot ${active ? "working" : ""}"></span>${active ? "Agent 正在运行" : "等待输入"}</span>${active ? button("停止", "stop", r.id, "ghost", "stop") : '<button class="button primary" type="submit" aria-label="发送">' + icon("send") + "发送</button>"}</div></form></div></section>`;
}
