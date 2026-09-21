import {
  escapeHtml as e,
  icon,
  button,
  nextRun,
  showDialog,
} from "./ui.js?v=3-source";
const options = (items, selected) =>
  items
    .map(
      ([value, label]) =>
        `<option value="${e(value)}" ${value === selected ? "selected" : ""}>${e(label)}</option>`,
    )
    .join("");
export function openEditor({ task, backend, agents, now, projectId, onSave }) {
  const s = task?.schedule || {
    frequency: "daily",
    time: "09:00",
    timezone: "Asia/Shanghai",
    days: [1],
    date: "2026-09-22",
  };
  const dialog = showDialog(
    "editor",
    `<form id="task-form">
   <header><div><h2 id="editor-title">${task ? "编辑任务" : "新建定时任务"}</h2><p>${e(backend.name)}</p></div><button type="button" class="icon-button" data-close="editor" aria-label="关闭">${icon("x")}</button></header>
   <div class="form-body">
     <label class="field"><span>任务名称</span><input name="name" autofocus required maxlength="80" placeholder="例如：每日文档整理" value="${e(task?.name)}" /></label>
     <div class="form-grid">
       <label class="field"><span>项目</span><select name="projectId">${options(
         backend.projects.map((p) => [p.id, p.name]),
         task?.projectId || projectId || backend.projects[0]?.id,
       )}</select><small id="project-path"></small></label>
       <label class="field"><span>Agent</span><select name="agent">${options(
         agents.map((a) => [a, a]),
         task?.agent || agents[0],
       )}</select><small>每次运行新建对话</small></label>
     </div>
     <label class="field"><span>任务提示词</span><textarea name="prompt" required maxlength="12000" placeholder="描述要完成的工作、执行要求和期望的产出；可以引用 Skill。">${e(task?.prompt)}</textarea><small>工作目录、worktree 和交付方式可在提示词或 Skill 中指定。</small></label>
     <section class="schedule-box"><h3>时间安排</h3>
       <div class="form-grid"><label class="field"><span>重复</span><select name="frequency">${options(
         [
           ["daily", "每天"],
           ["weekdays", "工作日（周一至周五）"],
           ["weekly", "每周"],
           ["once", "仅一次"],
         ],
         s.frequency,
       )}</select></label><label class="field"><span>时间</span><input name="time" type="time" required value="${e(s.time)}" /></label></div>
       <div id="weekday-field" class="field"><span>运行日期</span><div class="weekdays">${[1, 2, 3, 4, 5, 6, 0].map((d) => `<label class="day"><input type="checkbox" name="day" value="${d}" ${s.days.includes(d) ? "checked" : ""} /><span>周${["日", "一", "二", "三", "四", "五", "六"][d]}</span></label>`).join("")}</div></div>
       <label id="date-field" class="field"><span>日期</span><input name="date" type="date" value="${e(s.date)}" /></label>
       <label class="field"><span>时区</span><select name="timezone">${options(
         [
           ["Asia/Shanghai", "Asia/Shanghai · 北京时间"],
           ["UTC", "UTC · 协调世界时"],
           ["America/Los_Angeles", "America/Los_Angeles · 洛杉矶"],
         ],
         s.timezone,
       )}</select></label>
       <p class="next-run" id="next-preview" aria-live="polite"></p>
     </section>
     <details class="advanced"><summary>高级设置</summary><div class="form-grid"><label class="field"><span>模型</span><input name="model" placeholder="使用 Agent 默认配置" value="${e(task?.model === "默认" ? "" : task?.model)}" /></label><label class="field"><span>推理强度</span><select name="effort">${options(
       [
         ["默认", "使用 Agent 默认配置"],
         ["low", "Low"],
         ["medium", "Medium"],
         ["high", "High"],
       ],
       task?.effort || "默认",
     )}</select></label></div></details>
     <p class="error" id="form-error" role="alert" hidden></p>
   </div>
   <footer>${button("取消", "close-editor", "", "ghost")}<button class="button primary" type="submit">${task ? "保存修改" : "创建任务"}</button></footer>
 </form>`,
  );
  const form = dialog.querySelector("form");
  function readSchedule() {
    const data = new FormData(form);
    return {
      frequency: data.get("frequency"),
      time: data.get("time"),
      timezone: data.get("timezone"),
      date: data.get("date"),
      days: data.getAll("day").map(Number),
    };
  }
  function updatePreview() {
    const schedule = readSchedule();
    document.getElementById("weekday-field").style.display =
      schedule.frequency === "weekly" ? "grid" : "none";
    document.getElementById("date-field").style.display =
      schedule.frequency === "once" ? "grid" : "none";
    form.elements.date.required = schedule.frequency === "once";
    const next = schedule.time ? nextRun(schedule, now) : null;
    document.getElementById("next-preview").innerHTML =
      icon("clock") + (next ? `下次运行：${e(next)}` : "请选择未来的执行时间");
    document.getElementById("project-path").textContent =
      backend.projects.find((p) => p.id === form.elements.projectId.value)
        ?.path || "";
  }
  form.addEventListener("change", updatePreview);
  form.addEventListener("input", () => {
    document.getElementById("form-error").hidden = true;
  });
  updatePreview();
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form),
      schedule = readSchedule();
    const error = document.getElementById("form-error");
    let message = "";
    if (!String(data.get("name")).trim() || !String(data.get("prompt")).trim())
      message = "请填写任务名称和任务提示词。";
    else if (schedule.frequency === "weekly" && !schedule.days.length)
      message = "请至少选择一个运行日期。";
    else if (!nextRun(schedule, now)) message = "请选择未来的执行时间。";
    if (message) {
      error.textContent = message;
      error.hidden = false;
      error.scrollIntoView({ block: "nearest" });
      return;
    }
    const changed = {
      name: String(data.get("name")).trim(),
      prompt: String(data.get("prompt")).trim(),
      projectId: data.get("projectId"),
      agent: data.get("agent"),
      model: String(data.get("model")).trim() || "默认",
      effort: data.get("effort"),
      schedule,
    };
    onSave(changed);
    dialog.close();
  });
}
