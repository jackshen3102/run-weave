const $ = (selector) => document.querySelector(selector);
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const full = (value) =>
  value == null ? "未知" : Number(value).toLocaleString("en-US");
const labels = {
  pending: "待处理",
  processing: "处理中",
  resolved: "已处理",
  deferred: "暂不处理",
  dismissed: "已排除",
};
const categories = [
  "全部原因",
  "代码",
  "项目说明",
  "Skill",
  "流程",
  "工具",
  "环境",
  "Agent 行为",
];
const storageKey = "token-review-prototype-v3";
let report,
  issues = [],
  selected,
  status = "pending",
  dimension = "time",
  category = "全部原因",
  query = "",
  sort = "recent",
  action,
  actionIssue,
  toastTimer;
let state = { records: {} };
try {
  const saved = JSON.parse(localStorage.getItem(storageKey));
  if (saved?.records) state = { records: saved.records };
} catch {
  /* Local persistence is optional for the prototype. */
}
const recordState = (issue) =>
  state.records[issue.id] ?? { status: "pending", history: [] };
function notify(text) {
  clearTimeout(toastTimer);
  $("#toast").textContent = text;
  $("#toast").style.display = "block";
  toastTimer = setTimeout(() => ($("#toast").style.display = "none"), 2800);
}
function persist() {
  try {
    localStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    notify("当前浏览器无法保存，刷新后变更可能丢失");
  }
}
function load(value) {
  report = value;
  const grouped = new Map();
  for (const session of report.sessions)
    for (const turn of session.turns)
      for (const finding of turn.findings) {
        if (
          finding.assessment === "no_issue" ||
          !finding.evidence?.length ||
          !["time", "tokens"].includes(finding.dimension) ||
          !finding.measurement ||
          !finding.admission
        )
          continue;
        const id = `${finding.dimension}:${finding.issueId ?? finding.id}`;
        const issue = grouped.get(id) ?? {
          id,
          title: finding.title,
          dimension: finding.dimension,
          measurement: finding.measurement,
          admission: finding.admission,
          suggestion: finding.suggestion,
          reason: finding.reason,
          uncertainty: finding.uncertainty,
          categories: [],
          occurrences: [],
          evidence: [],
          lastSeen: "",
        };
        const sourceKey = `${session.id}/${turn.id}`;
        if (!issue.occurrences.some((o) => o.key === sourceKey))
          issue.occurrences.push({ key: sourceKey, session, turn });
        issue.categories = [
          ...new Set([...issue.categories, ...finding.categories]),
        ];
        for (const e of finding.evidence) {
          const source = e.source ?? session.file;
          if (
            !issue.evidence.some(
              (old) =>
                old.source === source &&
                old.line === e.line &&
                old.text === e.text,
            )
          )
            issue.evidence.push({ ...e, source });
        }
        const lastSeen =
          finding.lastSeen ?? turn.startedAt ?? report.generatedAt;
        if (lastSeen > issue.lastSeen) issue.lastSeen = lastSeen;
        grouped.set(id, issue);
      }
  issues = [...grouped.values()];
  $("#project-name").textContent = report.project.root
    .split("/")
    .filter(Boolean)
    .at(-1);
  $("#scope").textContent = "项目与关联 worktree · Codex";
  $("#category").innerHTML = categories
    .map((c) => `<option>${escape(c)}</option>`)
    .join("");
  render();
}
function visibleIssues() {
  return issues
    .filter(
      (i) =>
        i.dimension === dimension &&
        recordState(i).status === status &&
        (category === "全部原因" || i.categories.includes(category)) &&
        `${i.title} ${i.reason} ${i.occurrences.map((o) => o.turn.title).join(" ")}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .sort((a, b) =>
      sort === "impact"
        ? observedValue(b) - observedValue(a)
        : b.lastSeen.localeCompare(a.lastSeen),
    );
}
function tokenUsage(issue) {
  const totals = { input: 0, cachedInput: 0, output: 0 };
  for (const sample of issue.measurement.samples ?? []) {
    totals.input += sample.after.input_tokens - sample.before.input_tokens;
    totals.cachedInput +=
      sample.after.cached_input_tokens - sample.before.cached_input_tokens;
    totals.output += sample.after.output_tokens - sample.before.output_tokens;
  }
  return totals;
}
function observedValue(issue) {
  return issue.dimension === "time"
    ? issue.measurement.seconds
    : tokenUsage(issue).input;
}
function observedLabel(issue) {
  return issue.dimension === "time"
    ? `${issue.measurement.seconds.toFixed(2)} 秒`
    : `${(tokenUsage(issue).input / 1000).toFixed(1)}K 输入`;
}
function render() {
  const scoped = issues.filter((i) => i.dimension === dimension);
  const run = report.monitor.runs[0];
  $("#dimensions").innerHTML = Object.entries({
    time: "执行耗时",
    tokens: "Token 用量",
  })
    .map(
      ([key, label]) =>
        `<button data-dimension="${key}" aria-pressed="${dimension === key}" class="${dimension === key ? "active" : ""}">${label}<span>${issues.filter((i) => i.dimension === key && recordState(i).status === "pending").length}</span></button>`,
    )
    .join("");
  $("#monitor").innerHTML = run
    ? `<div><strong>最近分析 · ${escape(run.at)}</strong><p class="subtle">${run.status === "failed" ? "分析失败" : `覆盖 ${full(run.scanned)} 条执行`} · 来源：定时任务 / ${escape(report.monitor.taskName)}</p></div>`
    : '<div><strong>尚未关联分析任务</strong><p class="subtle">最近分析：暂无运行记录</p></div>';
  const metrics = [
    [
      "待处理",
      scoped.filter((i) => recordState(i).status === "pending").length,
      "当前方向",
    ],
    [
      "处理中",
      scoped.filter((i) => recordState(i).status === "processing").length,
      "当前方向",
    ],
    ["观测记录", scoped.length, "已附量化证据"],
    ["分析消耗", run ? full(run.analysisTokens) : "未记录", "分析任务单独记账"],
  ];
  $("#value-heading").textContent =
    dimension === "time" ? "观测耗时" : "观测输入";
  $("#metrics").innerHTML = metrics
    .map(
      ([label, value, note]) =>
        `<div class="metric"><p class="metric-label">${label}</p><p class="metric-value">${value}</p><p class="metric-note">${note}</p></div>`,
    )
    .join("");
  $("#statuses").innerHTML = Object.entries(labels)
    .map(
      ([key, label]) =>
        `<button data-status="${key}" aria-pressed="${key === status}" class="${key === status ? "active" : ""}">${label}<span>${scoped.filter((i) => recordState(i).status === key).length}</span></button>`,
    )
    .join("");
  const visible = visibleIssues();
  if (!visible.some((i) => i.id === selected)) selected = visible[0]?.id;
  $("#record-count").textContent = visible.length;
  const empty =
    query || category !== "全部原因"
      ? "没有匹配的疑点"
      : status !== "pending"
        ? `暂无${labels[status]}记录`
        : run?.status === "failed"
          ? "本次分析未完成，请查看分析运行"
          : run?.status === "running"
            ? "分析进行中，尚无待处理记录"
            : !scoped.length
              ? "当前方向暂无有量化证据的优化记录"
              : "暂无待处理疑点";
  $("#records").innerHTML = visible.length
    ? visible
        .map(
          (i) =>
            `<button class="record ${selected === i.id ? "selected" : ""}" data-record="${escape(i.id)}" aria-pressed="${selected === i.id}"><div><div class="record-title">${escape(i.title)}</div><div class="record-subtitle"><span class="tag">${escape(i.categories.join(" · "))}</span><span>${i.occurrences.length} 次关联执行</span>${recordState(i).analysisRequested ? '<span class="tag amber">待补充分析</span>' : ""}</div></div><div class="record-token">${escape(observedLabel(i))}<small>${escape(i.lastSeen.slice(5, 10))} · ${i.evidence.length} 条证据</small></div></button>`,
        )
        .join("")
    : `<div class="empty">${empty}</div>`;
  $("#coverage").textContent =
    dimension === "time"
      ? "只关注完成时间的实际开销。并行阶段不相加，工具等待不等于任务净延迟。"
      : "分别观察输入、缓存和输出。相关用量不等于可节省量；未知计费条件不估算金额。";
  renderDetail();
}
function measurementPanel(issue) {
  const m = issue.measurement;
  if (issue.dimension === "time")
    return `<div class="measurement"><p class="section-label">观测耗时</p><strong class="observed">${m.seconds.toFixed(3)} <small>秒</small></strong><p class="subtle">目标 ${m.targetSeconds} 秒 · ${m.sampleCount} 次完整构建样本</p><p class="body-text">${escape(m.boundary)}</p></div><details class="detail-section"><summary class="section-label">测量口径</summary><p class="body-text">${escape(m.comparison)}</p><p class="subtle">工具内部计时，来源 L${m.sourceLine}。尚未取得同条件优化后的样本，不计算节省量。</p></details>`;
  const u = tokenUsage(issue);
  return `<div class="measurement"><p class="section-label">调用区间用量 · ${m.samples.length} 段</p><div class="usage-grid">${[
    ["输入", u.input],
    ["其中缓存", u.cachedInput],
    ["未缓存输入", u.input - u.cachedInput],
    ["输出", u.output],
  ]
    .map(
      ([label, n]) =>
        `<div><span>${label}</span><strong>${full(n)}</strong></div>`,
    )
    .join(
      "",
    )}</div><p class="subtle">${escape(m.model)} · 金额暂不可估</p></div><details class="detail-section"><summary class="section-label">测量口径与原始差值</summary><p class="body-text">${escape(m.boundary)}</p><div class="sample-table"><table><thead><tr><th>采样行</th><th>输入</th><th>其中缓存</th><th>输出</th></tr></thead><tbody>${m.samples.map((s) => `<tr><td>L${s.beforeLine}→${s.afterLine}</td><td>${full(s.after.input_tokens - s.before.input_tokens)}</td><td>${full(s.after.cached_input_tokens - s.before.cached_input_tokens)}</td><td>${full(s.after.output_tokens - s.before.output_tokens)}</td></tr>`).join("")}</tbody></table></div><p class="subtle">计费方式和服务档位未确认，不能换算实际账单或净收益。</p></details>`;
}
function renderDetail() {
  const issue = issues.find((i) => i.id === selected);
  if (!issue) {
    $("#detail").innerHTML =
      '<div class="empty">选择一条疑点查看分析与处理记录</div>';
    return;
  }
  const current = recordState(issue);
  $("#detail").innerHTML =
    `<div class="detail-head"><div class="detail-meta"><span>疑点详情</span><span class="tag amber">${labels[current.status]}</span></div><h2>${escape(issue.title)}</h2><p class="detail-task">最近发现 ${escape(issue.lastSeen.slice(0, 10))} · ${issue.occurrences.length} 次关联执行</p></div><div class="detail-body">${measurementPanel(issue)}<div class="detail-section"><p class="section-label">为什么值得分析</p><p class="body-text">${escape(issue.admission)}</p></div><div class="detail-section"><p class="section-label">行为与开销</p><p class="body-text">${escape(issue.reason)}</p></div><div class="detail-section"><p class="section-label">验证方向</p><p class="body-text">${escape(issue.suggestion)}</p></div><div class="detail-section uncertainty">${escape(issue.uncertainty ?? "原因仍需验证，相关用量不代表浪费或可节省量。")}</div><details class="detail-section" open><summary class="section-label">执行证据 · ${issue.evidence.length}</summary>${issue.evidence.map((e, n) => `<div class="evidence"><p class="evidence-label">${escape(e.label ?? `观察 ${n + 1}`)}</p><pre>${escape(e.text)}</pre><span class="source-line">${escape(e.source)} · L${e.line}</span></div>`).join("")}</details><details class="detail-section"><summary class="section-label">关联执行</summary>${issue.occurrences.map(({ turn }) => `<p class="body-text">${escape(turn.title)}</p>`).join("")}</details><div class="detail-section"><p class="section-label">处理记录</p>${current.history.length ? current.history.map((h) => `<div class="history-entry"><p class="body-text">${escape(h.text)}</p><span class="source-line">${escape(h.at)}</span></div>`).join("") : '<p class="subtle">尚未处理</p>'}</div></div><div class="detail-actions">${current.status === "pending" ? '<button class="button dark" data-action="processing">开始处理</button>' : ""}${["pending", "processing"].includes(current.status) ? '<button class="button" data-action="analysis">补充分析</button><button class="button" data-action="resolved">确认已处理</button><button class="button" data-action="deferred">暂不处理</button><button class="button" data-action="dismissed">判定正常</button>' : '<button class="button" data-action="pending">重新打开</button>'}${current.status === "processing" ? '<button class="button" data-action="note">添加处理记录</button>' : ""}</div>`;
}
function openDialog(kind) {
  action = kind;
  actionIssue = selected;
  $("#confirm-action").hidden = false;
  $("#confirm-action").textContent = "确认";
  const titles = {
    processing: "开始处理",
    resolved: "确认已处理",
    deferred: "暂不处理",
    dismissed: "判定正常",
    pending: "重新打开",
    analysis: "补充分析",
    note: "添加处理记录",
    runs: "分析运行",
  };
  $("#dialog-title").textContent = titles[kind];
  if (kind === "runs") {
    $("#dialog-body").innerHTML = report.monitor.runs.length
      ? report.monitor.runs
          .map(
            (r) =>
              `<div class="history-entry"><h3>${escape(r.at)} · ${{ completed: "分析结束", failed: "分析失败", running: "分析中" }[r.status]}</h3><p class="body-text">覆盖 ${r.scanned} 条执行 · 新增 ${r.newFindings} 条疑点 · 更新 ${r.updated} 条</p><p class="subtle">分析用量 ${full(r.analysisTokens)}${r.error ? ` · ${escape(r.error)}` : ""}</p></div>`,
          )
          .join("")
      : '<p class="body-text">尚无定时分析运行记录。</p>';
    $("#confirm-action").hidden = true;
  } else {
    const prompt = {
      resolved: "处理措施、同条件验证结果及证据",
      dismissed: "判定正常的依据",
      analysis: "需要进一步核实的问题",
      note: "处理进展",
      deferred: "暂不处理的原因",
      processing: "准备如何处理",
      pending: "重新打开的原因",
    }[kind];
    $("#dialog-body").innerHTML =
      `<label class="form-label">${prompt}<textarea id="action-note" rows="4" ${kind === "processing" ? "" : "required"} maxlength="2000"></textarea></label>${kind === "resolved" ? '<label class="form-label checkbox"><input type="checkbox" id="verified" required>我已核对处理结果，确认关闭此记录</label>' : ""}`;
    $("#confirm-action").textContent =
      kind === "analysis" ? "提交分析问题" : "确认";
  }
  $("#action-dialog").showModal();
}
$("#dimensions").addEventListener("click", (e) => {
  const b = e.target.closest("[data-dimension]");
  if (!b) return;
  dimension = b.dataset.dimension;
  selected = undefined;
  status = "pending";
  category = "全部原因";
  query = "";
  $("#search").value = "";
  $("#category").value = category;
  render();
});
$("#statuses").addEventListener("click", (e) => {
  const b = e.target.closest("[data-status]");
  if (b) {
    status = b.dataset.status;
    render();
  }
});
$("#records").addEventListener("click", (e) => {
  const b = e.target.closest("[data-record]");
  if (b) {
    selected = b.dataset.record;
    render();
  }
});
$("#detail").addEventListener("click", (e) => {
  const b = e.target.closest("[data-action]");
  if (b) openDialog(b.dataset.action);
});
$("#search").addEventListener("input", (e) => {
  query = e.target.value;
  render();
});
$("#category").addEventListener("change", (e) => {
  category = e.target.value;
  render();
});
$("#sort").addEventListener("change", (e) => {
  sort = e.target.value;
  render();
});
$("#runs-button").addEventListener("click", () => openDialog("runs"));
$("#runs-inline").addEventListener("click", () => openDialog("runs"));
for (const id of ["#close-dialog", "#cancel-dialog"])
  $(id).addEventListener("click", () => $("#action-dialog").close());
$("#action-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const issue = issues.find((i) => i.id === actionIssue),
    current = recordState(issue),
    note = $("#action-note").value.trim();
  if (action !== "processing" && !note) {
    $("#action-note").setCustomValidity("请填写具体内容");
    $("#action-note").reportValidity();
    $("#action-note").oninput = () => $("#action-note").setCustomValidity("");
    return;
  }
  const next = {
    ...current,
    history: [
      ...current.history,
      {
        at: new Date().toLocaleString("zh-CN", { hour12: false }),
        text: `${$("#dialog-title").textContent}${note ? `：${note}` : ""}`,
      },
    ],
  };
  if (action === "analysis") {
    next.analysisRequested = true;
    next.status = "processing";
  } else if (action !== "note") {
    next.status = action;
    if (action === "resolved" || action === "dismissed")
      next.analysisRequested = false;
  }
  state.records[issue.id] = next;
  persist();
  $("#action-dialog").close();
  render();
});
fetch("./mock-state.json")
  .then((r) => {
    if (!r.ok) throw Error("记录加载失败");
    return r.json();
  })
  .then(load)
  .catch((error) => {
    $("#scope").textContent = error.message;
    $("#records").innerHTML = '<div class="empty">记录暂不可用</div>';
  });
