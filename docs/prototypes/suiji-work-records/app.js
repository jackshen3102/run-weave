/* global document, window, localStorage, navigator, fetch, crypto */
const app = document.querySelector("#app");
const storageKey = "suiji-work-records-prototype-20261024-v2";
const statusNames = {
  reported: "进展记录",
  discussed: "讨论",
  documented: "文档更新",
  attempted: "已发起",
  "agent-reported": "Agent 反馈",
};
const paths = {
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  tasks: '<path d="m3 6 2 2 3-4M11 6h10M3 13l2 2 3-4M11 13h10M11 20h10"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
  sparkle: '<path d="m12 3 3 6 6 3-6 3-3 6-3-6-6-3 6-3Z"/>',
  book: '<path d="M5 4h13a2 2 0 0 1 2 2v15H6a3 3 0 0 1-3-3V6a2 2 0 0 1 2-2Z"/><path d="M7 4v13M3 18h17M10 8h6M10 12h4"/>',
  list: '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  left: '<path d="m15 6-6 6 6 6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  calendar:
    '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4M17 3v4M3 10h18"/>',
  pin: '<path d="m9 3 6 0-1 6 4 4v2h-5v6l-2-2v-4H6v-2l4-4Z"/>',
  edit: '<path d="m16 3 5 5-12 12-6 1 1-6Z"/><path d="m13 6 5 5"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
};
const icon = (name) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.list}</svg>`;
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const asDate = (value) => new Date(`${value}T12:00:00Z`);
const shortDate = (value) =>
  `${Number(value.slice(5, 7))}月${Number(value.slice(8))}日`;
let seed,
  state,
  editingId = null,
  detailId = null,
  reviewRecordId = null,
  reclassIds = [],
  reclassReturnId = null,
  toastTimer,
  undoAction = null;

function windowRange() {
  return [state.fromDate || "0000-01-01", state.toDate || "9999-12-31"];
}

function projects() {
  return [...new Set(state.facts.map((fact) => fact.project))];
}
function knownDates() {
  return [
    ...new Set([
      ...seed.importedDates,
      ...state.facts.map((fact) => fact.date),
    ]),
  ];
}
function sortFacts(facts) {
  return [...facts].sort(
    (a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id),
  );
}
function periodFacts() {
  const [from, to] = windowRange();
  return state.facts.filter((fact) => fact.date >= from && fact.date <= to);
}
function visibleFacts() {
  return sortFacts(periodFacts());
}

function selectedFacts() {
  return sortFacts(
    state.facts.filter((fact) => state.selectedIds.includes(fact.id)),
  );
}
function persist() {
  try {
    localStorage.setItem(storageKey, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}
function toast(message, undo) {
  window.clearTimeout(toastTimer);
  undoAction = undo || null;
  document.querySelector("#toast").innerHTML =
    `<div class="toast">${esc(message)}${undo ? "<button data-undo>撤销</button>" : ""}</div>`;
  toastTimer = window.setTimeout(
    () => {
      document.querySelector("#toast").innerHTML = "";
      undoAction = null;
    },
    undo ? 15000 : 3500,
  );
}
function toggleSelection(id) {
  state.selectedIds = state.selectedIds.includes(id)
    ? state.selectedIds.filter((value) => value !== id)
    : [...state.selectedIds, id];
  persist();
  render();
  if (detailId === id && document.querySelector("#detail-dialog").open)
    fillDetail(id);
}
function renderCard(fact) {
  const selected = state.selectedIds.includes(fact.id),
    pinned = state.pinnedIds.includes(fact.id),
    classSelected = state.classificationIds.includes(fact.id);
  return `<article class="fact-card ${(state.classificationMode ? classSelected : selected) ? "selected" : ""}" data-fact-id="${esc(fact.id)}">
    <div class="fact-top"><button class="fact-title" data-open="${esc(fact.id)}">${esc(fact.title)}</button><span class="status ${esc(fact.status)}">${statusNames[fact.status] || "进展记录"}</span></div>
    <p class="fact-body">${esc(fact.statement)}</p>
    <div class="fact-bottom"><span class="fact-project">${esc(fact.project)}</span><div class="fact-controls"><button class="icon-btn ${pinned ? "pinned" : ""}" data-pin="${esc(fact.id)}" aria-label="${pinned ? "取消置顶" : "置顶"}：${esc(fact.title)}">${icon("pin")}</button><label class="select-label">${state.classificationMode ? `<input type="checkbox" data-classify-select="${esc(fact.id)}" aria-label="选择归类：${esc(fact.title)}" ${classSelected ? "checked" : ""}>选择` : selected ? "已选入周报" : ""}</label></div></div>
  </article>`;
}
function relativeDay(date) {
  const days = Math.round((asDate(seed.asOfDate) - asDate(date)) / 86400000);
  return days === 0
    ? "今天"
    : days === 1
      ? "昨天"
      : days === 2
        ? "前天"
        : shortDate(date);
}
function renderRecords() {
  const facts = visibleFacts();
  const days = [...new Set(facts.map((fact) => fact.date))];
  const filtered = Boolean(state.fromDate || state.toDate);
  const range = filtered
    ? `${state.fromDate ? shortDate(state.fromDate) : "最早"} — ${state.toDate ? shortDate(state.toDate) : "最近"}`
    : "";
  const dateButton = `<button class="native-date-filter" data-action="filter-date" aria-label="筛选日期">${icon("calendar")}日期</button>`;
  return `${mobileHeader("工作", dateButton + workMenu())}<header class="page-heading work-heading"><h1>工作记录</h1><div class="actions"><button class="btn secondary" data-action="filter-date">筛选日期</button><button class="btn secondary" data-action="classify">重新归类</button><button class="btn secondary" data-view="drafts">周报草稿</button><button class="btn primary" data-action="add">${icon("plus")}补记事实</button></div></header>
    <section class="timeline" aria-label="每日工作记录">${filtered ? `<div class="active-date-filter"><button data-action="filter-date">${range}</button><span>${facts.length} 条</span><button data-action="clear-dates">清除</button></div>` : ""}
    ${state.classificationMode ? `<div class="classification-toolbar"><span>选择要归类的记录</span><button class="text-action" data-action="classify-visible">${facts.length && facts.every((fact) => state.classificationIds.includes(fact.id)) ? "取消当前选择" : "全选当前结果"}</button></div>` : ""}
    ${
      days
        .map(
          (date) =>
            `<section class="timeline-day" data-day="${date}"><header class="timeline-day-heading"><h2>${relativeDay(date)}</h2><span>${relativeDay(date) === shortDate(date) ? "周" + "日一二三四五六"[asDate(date).getUTCDay()] : shortDate(date)}</span><small>${facts.filter((fact) => fact.date === date).length} 条</small></header><div class="fact-list">${facts
              .filter((fact) => fact.date === date)
              .sort(
                (a, b) =>
                  Number(state.pinnedIds.includes(b.id)) -
                  Number(state.pinnedIds.includes(a.id)),
              )
              .map(renderCard)
              .join("")}</div></section>`,
        )
        .join("") ||
      `<div class="empty"><h3>这段时间尚未导入记录</h3><button class="btn secondary" data-action="filter-date">调整日期</button></div>`
    }
    </section>`;
}
function openDateFilter() {
  document.querySelector("#filter-from").value = state.fromDate || "";
  document.querySelector("#filter-to").value = state.toDate || "";
  document.querySelector("#date-filter-error").textContent = "";
  document.querySelector("#date-filter-dialog").showModal();
}
function applyDateFilter(event) {
  event.preventDefault();
  const from = document.querySelector("#filter-from").value;
  const to = document.querySelector("#filter-to").value;
  if (from && to && from > to) {
    document.querySelector("#date-filter-error").textContent =
      "开始日期不能晚于结束日期。";
    return;
  }
  state.fromDate = from;
  state.toDate = to;
  document.querySelector("#date-filter-dialog").close();
  render();
  window.scrollTo(0, 0);
}
function renderDrafts() {
  const facts = selectedFacts();
  return `${mobileHeader("周报草稿", "", true)}<header class="page-heading draft-heading"><div><h1>周报草稿</h1><p>从已经记录的事实中，挑选这次要讲的事。</p></div><div class="actions"><button class="btn secondary" data-view="records">返回记录</button></div></header><div class="draft-layout"><section class="material-box"><h2>选材夹 <span class="badge">${facts.length}</span></h2><p>${facts.length ? "可继续从工作记录中添加事项。" : "选中的事实会保留在这里。"}</p>${facts.length ? facts.map((fact) => `<div class="material-item"><span class="dot" style="margin-top:7px"></span><div><strong>${esc(fact.title)}</strong><small>${shortDate(fact.date)} · ${esc(fact.project)}</small></div><button class="icon-btn" data-remove="${esc(fact.id)}" aria-label="移出选材：${esc(fact.title)}">${icon("close")}</button></div>`).join("") : '<button class="btn subtle small" data-view="records">去选择事实</button>'}</section><section class="editor-card"><div class="editor-heading"><h2>汇报正文</h2><button class="btn subtle small" data-action="compose" ${!facts.length ? "disabled" : ""}>${icon("list")}${state.draftText ? "重新整理" : "按项目整理"}</button></div><label><span class="visually-hidden">周报正文</span><textarea id="draft-editor" class="draft-editor" placeholder="选好事实后，按项目整理成草稿。">${esc(state.draftText)}</textarea></label><div class="editor-footer"><small>${state.draftText ? `${state.draftSourceIds.length} 条记录 · 可编辑` : ""}</small><button class="btn secondary" data-action="copy" ${!state.draftText.trim() ? "disabled" : ""}>${icon("copy")}复制</button><button class="btn primary" data-action="save-draft" ${!state.draftText.trim() ? "disabled" : ""}>保存草稿</button></div></section></div>${state.drafts.length ? `<section class="saved-drafts"><h2>已保存 <span class="badge">${state.drafts.length}</span></h2>${state.drafts.map((draft) => `<article class="saved-draft"><span class="folder-icon">${icon("file")}</span><button data-load-draft="${esc(draft.id)}"><strong>${esc(draft.title)}</strong><small>${draft.sourceIds.length} 条事实 · ${esc(draft.savedDate)}</small></button><button class="icon-btn" data-delete-draft="${esc(draft.id)}" aria-label="删除草稿：${esc(draft.title)}">${icon("close")}</button></article>`).join("")}</section>` : ""}`;
}
function workMenu() {
  return `<details class="overflow-menu"><summary aria-label="工作更多操作">${icon("more")}</summary><div class="overflow-items"><button data-action="classify">${icon("edit")}重新归类</button><button data-view="drafts">${icon("file")}周报草稿</button><button data-action="review">${icon("sparkle")}AI 回顾</button></div></details>`;
}
function mobileHeader(title, actions = "", back = false) {
  return `<header class="native-header"><div>${back ? `<button class="native-back" data-view="records" aria-label="返回工作">${icon("left")}工作</button>` : `<button class="desktop-drawer-close icon-btn" data-action="close-drawer" aria-label="关闭随记">${icon("close")}</button>`}</div><h1>${title}</h1><div>${actions}</div></header>`;
}
function renderCapture() {
  const taskView = state.view === "tasks";
  const title = taskView ? "待办" : "随记";
  const items = seed.captureRecords.filter((record) =>
    taskView
      ? record.taskStatus === state.taskStatus
      : record.taskStatus !== "done" && record.taskStatus !== "archived",
  );
  return `${mobileHeader(title)}<header class="page-heading capture-heading"><h1>${title}</h1></header><div class="capture-feed"><div class="segmented capture-filters" role="group" aria-label="${taskView ? "待办状态" : "记录类型"}">${(taskView
    ? [
        ["open", "未完成"],
        ["done", "已完成"],
        ["archived", "不再做"],
      ]
    : [
        ["all", "全部"],
        ["note", "想法"],
        ["task", "待办"],
      ]
  )
    .map(
      ([value, label]) =>
        `<button ${taskView ? `data-task-status="${value}"` : `data-capture-filter="${value}"`} aria-pressed="${(taskView ? state.taskStatus : state.captureFilter) === value}">${label}</button>`,
    )
    .join(
      "",
    )}</div><div class="capture-tags"><span>全部标签</span><span class="active">工作</span></div>${
    items
      .filter(
        (record) =>
          taskView ||
          state.captureFilter === "all" ||
          record.kind === state.captureFilter,
      )
      .map(
        (record) =>
          `<button class="capture-card" data-capture-open="${record.id}"><span class="capture-card-meta">待办 · ${record.taskStatus === "done" ? "已完成" : record.taskStatus === "archived" ? "不再做" : "未完成"}</span><p>${esc(record.excerpt)}</p><span class="capture-card-foot">${shortDate(record.createdAt.slice(0, 10))}<span>工作</span></span></button>`,
      )
      .join("") || '<p class="capture-empty">没有匹配的记录</p>'
  }</div>`;
}
function openCapture(id) {
  const record = seed.captureRecords.find((record) => record.id === id);
  document.querySelector("#context-title").textContent = "记录详情";
  document.querySelector("#context-content").innerHTML =
    `<span class="detail-meta">待办 · ${record.taskStatus === "done" ? "已完成" : "未完成"}</span><p class="detail-statement">${esc(record.excerpt)}</p><small>${esc(record.createdAt.slice(0, 10))} · 工作</small><div class="context-actions"><button class="btn secondary" data-review-record="${record.id}">${icon("sparkle")}聊聊这条</button></div>`;
  document.querySelector("#context-dialog").showModal();
}
function openReview(id) {
  reviewRecordId = id || null;
  document.querySelector("#context-dialog").close();
  document
    .querySelectorAll(".overflow-menu[open]")
    .forEach((menu) => (menu.open = false));
  const scope = document.querySelector("#review-scope");
  scope.innerHTML =
    '<option value="all">全部历史</option><option value="open">当前待办</option>' +
    (id ? '<option value="record">这条记录</option>' : "");
  scope.value = id ? "record" : "all";
  document.querySelector("#review-feedback").textContent = "";
  document.querySelector("#review-dialog").showModal();
}
function render() {
  const views = [
    ["capture", "edit", "记录"],
    ["tasks", "tasks", "待办"],
    ["trash", "trash", "回收站"],
    ["records", "book", "工作"],
  ];
  const active = state.view === "drafts" ? "records" : state.view;
  const label =
    state.view === "drafts"
      ? "周报草稿"
      : views.find(([key]) => key === state.view)?.[2] || "工作";
  const page =
    state.view === "records"
      ? renderRecords()
      : state.view === "drafts"
        ? renderDrafts()
        : state.view === "trash"
          ? `${mobileHeader("回收站")}<h2 class="capture-heading">回收站</h2><div class="empty"><h3>尚未读取回收站</h3><button class="btn secondary" data-view="capture">返回记录</button></div>`
          : renderCapture();
  const navigation = views
    .map(
      ([view, symbol, title]) =>
        `<button data-view="${view}" class="${active === view ? "active" : ""}" ${active === view ? 'aria-current="page"' : ""}>${icon(symbol)}${title}</button>`,
    )
    .join("");
  app.innerHTML = `<div class="shell"><aside class="sidebar"><div class="brand"><span class="brand-mark">${icon("book")}</span><div>随记<small>留住发生的事</small></div></div><nav class="nav" aria-label="主导航">${navigation}</nav><div class="sidebar-foot"><strong>${state.facts.length} 条事实 · ${knownDates().length} 个日期</strong>工作记录</div></aside><main class="main"><div class="breadcrumb">随记<span>/</span>${label}</div>${page}</main>${state.view !== "drafts" ? `<nav class="mobile-nav" aria-label="底部导航">${navigation}</nav>` : ""}${state.view === "records" ? `<button class="capture-fab" data-action="add" aria-label="补记事实">${icon("plus")}</button>` : ""}${state.view === "records" && state.classificationMode ? `<div class="selection-bar classification-bar"><span>已选 ${state.classificationIds.length} 条记录</span><button class="clear-selection" data-action="classify-exit">退出</button><button class="btn" data-action="classify-selected" ${state.classificationIds.length ? "" : "disabled"}>归类</button></div>` : state.view === "records" && state.selectedIds.length ? `<div class="selection-bar"><span>${icon("check")} 已选 ${state.selectedIds.length} 条事实</span><button class="clear-selection" data-action="clear-selection">清空</button><button class="btn" data-view="drafts">查看选材 ${icon("chevron")}</button></div>` : ""}</div>`;
  persist();
}
function fillDetail(id) {
  const fact = state.facts.find((item) => item.id === id);
  if (!fact) return;
  document.querySelector("#detail-title").textContent = fact.title;
  document.querySelector("#detail-content").innerHTML =
    `<div class="detail-meta"><span>${fact.date}</span><span>·</span><span>${esc(fact.project)}</span><span class="status ${esc(fact.status)}">${statusNames[fact.status] || "进展记录"}</span></div><p class="detail-statement">${esc(fact.statement)}</p><div class="detail-footer"><button class="btn secondary" data-reclassify="${esc(id)}">重新归类</button><button class="btn secondary" data-edit="${esc(id)}">${icon("edit")}编辑记录</button><button class="btn ${state.selectedIds.includes(id) ? "subtle" : "primary"}" data-select-button="${esc(id)}">${state.selectedIds.includes(id) ? "移出周报候选" : "加入周报候选"}</button></div>`;
}
function openDetail(id) {
  detailId = id;
  fillDetail(id);
  document.querySelector("#detail-dialog").showModal();
}
function openEditor(id = null) {
  if (document.querySelector("#detail-dialog").open)
    document.querySelector("#detail-dialog").close();
  editingId = id;
  const fact = state.facts.find((item) => item.id === id);
  document.querySelector("#record-form").reset();
  document.querySelector("#record-error").textContent = "";
  document.querySelector("#edit-title").textContent = id
    ? "编辑事实"
    : "补记事实";
  document.querySelector("#fact-date").value = fact?.date || state.date;
  document.querySelector("#project-options").innerHTML = projects()
    .map((name) => `<option value="${esc(name)}">${esc(name)}</option>`)
    .join("");
  document.querySelector("#fact-project").value = fact?.project || "";
  document.querySelector("#fact-title").value = fact?.title || "";
  document.querySelector("#fact-statement").value = fact?.statement || "";
  document.querySelector("#fact-status").value = fact?.status || "reported";
  document.querySelector("#edit-dialog").showModal();
}
function saveRecord(event) {
  event.preventDefault();
  const values = new FormData(event.target);
  const fields = Object.fromEntries(values);
  fields.title = fields.title.trim();
  fields.statement = fields.statement.trim();
  fields.project = fields.project.trim() || "未归类";
  if (!fields.title || !fields.statement || !fields.project || !fields.date) {
    document.querySelector("#record-error").textContent =
      "请填写日期、标题和事实记录。";
    return;
  }
  if (
    state.facts.some(
      (fact) =>
        fact.id !== editingId &&
        fact.date === fields.date &&
        fact.project === fields.project &&
        fact.statement.trim() === fields.statement,
    )
  ) {
    document.querySelector("#record-error").textContent =
      "同一天已记录这条事实。";
    return;
  }
  const before = state.facts.find((fact) => fact.id === editingId);
  const id = editingId || "manual-" + crypto.randomUUID();
  if (before) Object.assign(before, fields);
  else state.facts.push({ id, eventKey: id, ...fields });
  if (!persist()) {
    toast("记录尚未保存，请保留页面");
    return;
  }
  document.querySelector("#edit-dialog").close();
  state.fromDate = "";
  state.toDate = "";
  state.date = fields.date;
  state.view = "records";
  state.query = "";
  state.status = "";
  state.project = "all";
  render();
  toast(
    editingId ? "记录已更新" : "记录已保存",
    !editingId
      ? () => {
          state.facts = state.facts.filter((fact) => fact.id !== id);
          state.selectedIds = state.selectedIds.filter((value) => value !== id);
          state.pinnedIds = state.pinnedIds.filter((value) => value !== id);
          persist();
          render();
          toast("已撤销新增");
        }
      : null,
  );
}
function openReclassify(ids, returnId = null) {
  reclassIds = ids.filter((id) => state.facts.some((fact) => fact.id === id));
  if (!reclassIds.length) return;
  reclassReturnId = returnId;
  document.querySelector("#detail-dialog").close();
  document.querySelector("#reclassify-title").textContent =
    `重新归类 · ${reclassIds.length} 条`;
  const facts = state.facts.filter((fact) => reclassIds.includes(fact.id));
  document.querySelector("#reclassify-records").innerHTML = facts
    .map(
      (fact) =>
        `<li><strong>${esc(fact.title)}</strong><small>${shortDate(fact.date)} · ${esc(fact.project)}</small></li>`,
    )
    .join("");
  document.querySelector("#reclassify-options").innerHTML = [
    "未归类",
    ...projects().filter((name) => name !== "未归类"),
  ]
    .map((name) => `<option value="${esc(name)}"></option>`)
    .join("");
  document.querySelector("#reclassify-project").value = facts.every(
    (fact) => fact.project === facts[0].project,
  )
    ? facts[0].project
    : "";
  document.querySelector("#reclassify-error").textContent = "";
  document.querySelector("#reclassify-dialog").showModal();
}
function saveReclassification(event) {
  event.preventDefault();
  const name =
    document.querySelector("#reclassify-project").value.trim() || "未归类";
  const before = state.facts;
  const previous = new Map(
    before
      .filter((fact) => reclassIds.includes(fact.id))
      .map((fact) => [fact.id, fact.project]),
  );
  const changed = [...previous].filter(([, project]) => project !== name);
  state.facts = before.map((fact) =>
    previous.has(fact.id) ? { ...fact, project: name } : fact,
  );
  if (!persist()) {
    state.facts = before;
    document.querySelector("#reclassify-error").textContent =
      "归类尚未保存，请保留页面。";
    return;
  }
  state.classificationMode = false;
  state.classificationIds = [];
  state.project = "all";
  document.querySelector("#reclassify-dialog").close();
  render();
  toast(
    changed.length ? `已调整 ${changed.length} 条记录的归类` : "归类未改变",
    changed.length
      ? () => {
          const current = state.facts;
          state.facts = current.map((fact) =>
            previous.has(fact.id)
              ? { ...fact, project: previous.get(fact.id) }
              : fact,
          );
          if (!persist()) {
            state.facts = current;
            toast("撤销尚未保存，请保留页面");
            return;
          }
          render();
          if (document.querySelector("#detail-dialog").open)
            fillDetail(detailId);
          toast("已撤销归类");
        }
      : null,
  );
}
function composeDraft() {
  const facts = selectedFacts();
  if (!facts.length) return;
  if (
    state.draftDirty &&
    state.draftText &&
    !window.confirm("重新整理会替换当前草稿正文，是否继续？")
  )
    return;
  const dates = facts.map((fact) => fact.date).sort(),
    groups = new Map();
  for (const fact of [...facts].sort((a, b) => a.date.localeCompare(b.date))) {
    if (!groups.has(fact.project)) groups.set(fact.project, new Map());
    const topics = groups.get(fact.project);
    if (!topics.has(fact.eventKey)) topics.set(fact.eventKey, []);
    topics.get(fact.eventKey).push(fact);
  }
  const lines = [`# 工作汇报｜${dates[0]} — ${dates.at(-1)}`, ""];
  for (const [project, topics] of groups) {
    lines.push(`## ${project}`, "");
    for (const items of topics.values()) {
      if (items.length > 1) lines.push(`### ${items[0].title}`, "");
      for (const fact of items)
        lines.push(`- ${shortDate(fact.date)}：${fact.statement}`, "");
    }
  }
  state.draftText = lines.join("\n");
  state.draftSourceIds = facts.map((fact) => fact.id);
  state.draftDirty = false;
  state.activeDraftId = null;
  persist();
  render();
  toast("已按项目整理");
}
function saveDraft() {
  if (!state.draftText.trim()) return;
  const existing = state.drafts.find(
      (draft) => draft.id === state.activeDraftId,
    ),
    now = new Date();
  const draft = {
    id: state.activeDraftId || crypto.randomUUID(),
    title:
      state.draftText
        .split("\n")
        .find((line) => line.trim())
        ?.replace(/^#+\s*/, "") || "工作汇报",
    body: state.draftText,
    sourceIds: [...state.draftSourceIds],
    savedDate: now.toLocaleDateString("zh-CN"),
    factsSnapshot: state.facts
      .filter((fact) => state.draftSourceIds.includes(fact.id))
      .map((fact) => ({ ...fact })),
  };
  if (existing) Object.assign(existing, draft);
  else state.drafts.unshift(draft);
  state.activeDraftId = draft.id;
  state.draftDirty = false;
  if (persist()) {
    render();
    toast("草稿已保存");
  } else toast("草稿尚未保存，请保留页面");
}
async function copyDraft() {
  try {
    await navigator.clipboard.writeText(state.draftText);
    toast("正文已复制");
  } catch {
    const editor = document.querySelector("#draft-editor");
    editor?.focus();
    editor?.select();
    toast("已选中正文，可复制");
  }
}

document.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const data = button.dataset;
  if (data.action === "close-drawer") {
    window.parent.postMessage({ type: "suiji-prototype-close" }, "*");
    return;
  }
  if (data.action === "filter-date") {
    openDateFilter();
    return;
  }
  if (data.action === "clear-dates") {
    state.fromDate = "";
    state.toDate = "";
    render();
    return;
  }
  if (data.action === "date-filter-reset") {
    document.querySelector("#filter-from").value = "";
    document.querySelector("#filter-to").value = "";
    document.querySelector("#date-filter-error").textContent = "";
    return;
  }
  if (data.reclassify) {
    openReclassify([data.reclassify], data.reclassify);
    return;
  }
  if (data.action === "classify") {
    state.classificationMode = true;
    state.view = "records";
    render();
    return;
  }
  if (data.action === "classify-exit") {
    state.classificationMode = false;
    state.classificationIds = [];
    render();
    return;
  }
  if (data.action === "classify-visible") {
    const ids = visibleFacts().map((fact) => fact.id);
    state.classificationIds = ids.every((id) =>
      state.classificationIds.includes(id),
    )
      ? state.classificationIds.filter((id) => !ids.includes(id))
      : [...new Set([...state.classificationIds, ...ids])];
    render();
    return;
  }
  if (data.action === "classify-selected") {
    openReclassify(state.classificationIds);
    return;
  }
  if (data.captureOpen) {
    openCapture(data.captureOpen);
    return;
  }
  if (data.captureFilter) {
    state.captureFilter = data.captureFilter;
    render();
    return;
  }
  if (data.taskStatus) {
    state.taskStatus = data.taskStatus;
    render();
    return;
  }
  if (data.reviewRecord) {
    openReview(data.reviewRecord);
    return;
  }
  if (data.action === "review") {
    openReview();
    return;
  }
  if (data.action === "review-send") {
    document.querySelector("#review-feedback").textContent =
      "当前未连接回顾服务，问题已保留。";
    return;
  }
  if ("undo" in data) {
    const action = undoAction;
    undoAction = null;
    action?.();
    return;
  }
  if (data.close) {
    document.querySelector("#" + data.close).close();
    if (data.close === "review-dialog" && reviewRecordId) {
      openCapture(reviewRecordId);
      reviewRecordId = null;
    }
    return;
  }
  if (data.open) {
    openDetail(data.open);
    return;
  }
  if (data.edit) {
    openEditor(data.edit);
    return;
  }
  if (data.selectButton) {
    toggleSelection(data.selectButton);
    return;
  }
  if (data.pin) {
    state.pinnedIds = state.pinnedIds.includes(data.pin)
      ? state.pinnedIds.filter((id) => id !== data.pin)
      : [...state.pinnedIds, data.pin];
    persist();
    render();
    return;
  }
  if (data.remove) {
    toggleSelection(data.remove);
    return;
  }
  if (data.view) {
    state.view = data.view;
    render();
    window.scrollTo(0, 0);
    return;
  }
  if (data.loadDraft) {
    const draft = state.drafts.find((item) => item.id === data.loadDraft);
    state.draftText = draft.body;
    state.draftSourceIds = [...draft.sourceIds];
    state.activeDraftId = draft.id;
    state.draftDirty = false;
    render();
    return;
  }
  if (data.deleteDraft && window.confirm("删除这份草稿？")) {
    state.drafts = state.drafts.filter((item) => item.id !== data.deleteDraft);
    if (state.activeDraftId === data.deleteDraft) {
      state.activeDraftId = null;
      state.draftText = "";
      state.draftSourceIds = [];
    }
    persist();
    render();
    toast("草稿已删除");
    return;
  }
  if (data.action === "add") openEditor();

  if (data.action === "clear-selection") {
    state.selectedIds = [];
    persist();
    render();
  }
  if (data.action === "compose") composeDraft();
  if (data.action === "copy") void copyDraft();
  if (data.action === "save-draft") saveDraft();
});
document.addEventListener("change", (event) => {
  const input = event.target;
  if (input.dataset.classifySelect) {
    const id = input.dataset.classifySelect;
    state.classificationIds = state.classificationIds.includes(id)
      ? state.classificationIds.filter((value) => value !== id)
      : [...state.classificationIds, id];
    render();
    return;
  }
  if (input.dataset.select) {
    toggleSelection(input.dataset.select);
    return;
  }
});
document.addEventListener("input", (event) => {
  if (event.target.id === "review-question") {
    document.querySelector("#review-send").disabled =
      !event.target.value.trim();
  }
  if (event.target.id === "draft-editor") {
    state.draftText = event.target.value;
    state.draftDirty = true;
    persist();
    const hasText = Boolean(state.draftText.trim());
    document.querySelector('[data-action="save-draft"]').disabled = !hasText;
    document.querySelector('[data-action="copy"]').disabled = !hasText;
  }
});
document.querySelector("#record-form").addEventListener("submit", saveRecord);
document
  .querySelector("#date-filter-form")
  .addEventListener("submit", applyDateFilter);
document
  .querySelector("#reclassify-form")
  .addEventListener("submit", saveReclassification);
document.querySelector("#reclassify-dialog").addEventListener("close", () => {
  if (reclassReturnId) {
    const id = reclassReturnId;
    reclassReturnId = null;
    openDetail(id);
  }
});
for (const dialog of document.querySelectorAll("dialog"))
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      const r = dialog.getBoundingClientRect();
      if (
        event.clientX < r.left ||
        event.clientX > r.right ||
        event.clientY < r.top ||
        event.clientY > r.bottom
      )
        dialog.close();
    }
  });

(async () => {
  try {
    seed =
      window.__SUIJI_PROTOTYPE_DATA__ ||
      (await (await fetch("mock-state.json")).json());
    let saved;
    try {
      saved = JSON.parse(localStorage.getItem(storageKey) || "null");
    } catch {
      saved = null;
    }
    state = {
      facts: seed.facts.map((fact) => ({ ...fact })),
      date: seed.initialDate,
      fromDate: "",
      toDate: "",
      readingVersion: 3,
      group: "project",
      project: "all",
      query: "",
      status: "",
      view: "capture",
      captureFilter: "all",
      taskStatus: "open",
      classificationMode: false,
      classificationIds: [],
      selectedIds: [],
      pinnedIds: [],
      drafts: [],
      expanded: [],
      draftText: "",
      draftSourceIds: [],
      draftDirty: false,
      activeDraftId: null,
      ...(saved || {}),
    };
    if (saved?.readingVersion !== 3) {
      state.fromDate = "";
      state.toDate = "";
      state.readingVersion = 3;
    }
    const params = new URLSearchParams(
      window.__SUIJI_PROTOTYPE_QUERY__ ?? window.location.search,
    );
    if (params.has("date")) state.fromDate = state.toDate = params.get("date");
    if (params.get("view") === "work") state.view = "records";
    render();
  } catch {
    app.innerHTML =
      '<main class="empty"><h1>记录暂时无法读取</h1><p>请刷新页面重试。</p><button class="btn secondary" onclick="window.location.reload()">重新读取</button></main>';
  }
})();

window.addEventListener("message", (event) => {
  if (
    event.source === window.parent &&
    event.data?.type === "suiji-prototype-host"
  )
    document.body.classList.toggle(
      "in-desktop-drawer",
      Boolean(event.data.desktop),
    );
});
window.addEventListener("keydown", (event) => {
  if (
    event.key === "Escape" &&
    document.body.classList.contains("in-desktop-drawer") &&
    !document.querySelector("dialog[open]")
  )
    window.parent.postMessage({ type: "suiji-prototype-close" }, "*");
});
