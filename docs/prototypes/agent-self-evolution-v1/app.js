/* global FormData, URL, URLSearchParams, document, fetch, history, structuredClone, window */

const app = document.querySelector("#app");
const modalRoot = document.querySelector("#modal-root");
const toastRoot = document.querySelector("#toast-root");

const icons = {
  overview: `<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></svg>`,
  runs: `<svg viewBox="0 0 24 24"><path d="M5 3v4M3 5h4M18 17v4M16 19h4"/><path d="M7.5 19h-1A3.5 3.5 0 0 1 3 15.5V12M16.5 5h1A3.5 3.5 0 0 1 21 8.5V12"/><path d="m9 8 6 4-6 4Z"/></svg>`,
  insights: `<svg viewBox="0 0 24 24"><path d="M9 18h6M10 22h4"/><path d="M8.5 14.5A7 7 0 1 1 15.6 14c-.9.8-1.4 1.8-1.6 3h-4c-.1-1-.6-1.8-1.5-2.5Z"/></svg>`,
  candidates: `<svg viewBox="0 0 24 24"><path d="m12 3 2.1 4.3L19 8l-3.5 3.4.8 4.8L12 14l-4.3 2.2.8-4.8L5 8l4.9-.7Z"/><path d="M5 19h14"/></svg>`,
  schedules: `<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 17h.01M12 17h.01"/></svg>`,
  plus: `<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>`,
  close: `<svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>`,
  chevron: `<svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>`,
  spark: `<svg viewBox="0 0 24 24"><path d="m12 3 1.4 4.6L18 9l-4.6 1.4L12 15l-1.4-4.6L6 9l4.6-1.4Z"/><path d="m18.5 15 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8Z"/></svg>`,
  external: `<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5"/></svg>`,
  alert: `<svg viewBox="0 0 24 24"><path d="M10.3 4.4 2.7 18a2 2 0 0 0 1.8 3h15a2 2 0 0 0 1.8-3L13.7 4.4a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>`,
  check: `<svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg>`,
  filter: `<svg viewBox="0 0 24 24"><path d="M4 6h16M7 12h10M10 18h4"/></svg>`,
  dots: `<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>`,
  shield: `<svg viewBox="0 0 24 24"><path d="M12 3 5 6v5c0 4.8 2.9 8.1 7 10 4.1-1.9 7-5.2 7-10V6Z"/><path d="m9 12 2 2 4-4"/></svg>`,
  activity: `<svg viewBox="0 0 24 24"><path d="M3 12h4l2-7 4 14 2-7h6"/></svg>`,
};

const navigation = [
  { id: "overview", label: "概览", icon: "overview" },
  { id: "runs", label: "运行记录", icon: "runs" },
  { id: "insights", label: "洞察", icon: "insights" },
  { id: "candidates", label: "资产候选", icon: "candidates" },
  { id: "schedules", label: "运行计划", icon: "schedules" },
];

const pageCopy = {
  overview: {
    title: "进化概览",
    subtitle: "新增认知、未解决分歧与运行时激活",
  },
  runs: {
    title: "运行记录",
    subtitle: "查看证据冻结、多 Agent 分析与知识提交",
  },
  insights: {
    title: "洞察",
    subtitle: "长期维护的结论、证据账本与 revision",
  },
  candidates: {
    title: "资产候选",
    subtitle: "Shadow、Canary、晋级与回滚治理",
  },
  schedules: {
    title: "运行计划",
    subtitle: "按需配置定时增量反思",
  },
};

function icon(name, className = "icon") {
  return `<span class="${className}" aria-hidden="true">${icons[name] ?? ""}</span>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function statusPill(status, label) {
  return `<span class="status-pill ${escapeHtml(status)}">${escapeHtml(label)}</span>`;
}

function tag(label) {
  return `<span class="tag">${escapeHtml(label)}</span>`;
}

function setQueryView(view) {
  const url = new URL(window.location.href);
  if (view === "overview") {
    url.searchParams.delete("view");
  } else {
    url.searchParams.set("view", view);
  }
  history.replaceState({}, "", url);
}

function showToast(message, tone = "default") {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.innerHTML = `${icon(tone === "success" ? "check" : "spark")}<span>${escapeHtml(message)}</span>`;
  toastRoot.append(toast);
  window.setTimeout(() => toast.remove(), 3200);
}

function getScenario() {
  return new URLSearchParams(window.location.search).get("state") ?? "default";
}

function createRunningRun(data, title = "项目增量反思") {
  return {
    id: `evo_mock_${Date.now()}`,
    title,
    trigger: "手动",
    profile: "Standard",
    providerPolicy: "Auto · Codex + Trae",
    status: "running",
    statusLabel: "运行中",
    createdAt: "刚刚",
    completedAt: "—",
    duration: "00:08",
    range: "最近 7 天 · 增量",
    factsReviewed: 286,
    episodes: 8,
    claims: 0,
    novelClaims: 0,
    dataQuality: "冻结视图已建立",
    budget: {
      turns: "4 / 18",
      tools: "11 / 60",
      context: "124 KB / 1 MB",
    },
    stages: [
      { id: "snapshot", label: "冻结证据", status: "done" },
      { id: "segments", label: "构建 Episode", status: "done" },
      { id: "analysis", label: "独立分析", status: "active" },
      { id: "cross", label: "交叉质疑", status: "waiting" },
      { id: "novelty", label: "新颖性校验", status: "waiting" },
      { id: "commit", label: "提交知识", status: "waiting" },
    ],
    analysts: [
      {
        id: "a",
        name: "Analyst A",
        provider: "Codex",
        status: "running",
        summary: "正在独立检索失败轨迹与用户纠偏证据…",
        evidenceCount: 7,
      },
      {
        id: "b",
        name: "Analyst B",
        provider: "Trae",
        status: "running",
        summary: "正在独立检查成功样本、反例与适用范围…",
        evidenceCount: 5,
      },
    ],
    crossQuestion: "两份首轮报告完成前相互不可见。",
    claimIds: [],
  };
}

function applyScenario(data, scenario) {
  const cloned = structuredClone(data);
  if (scenario === "running") {
    cloned.runs.unshift(createRunningRun(cloned, "跨 workspace 增量反思"));
  }
  if (scenario === "degraded") {
    const provider = cloned.providers.find((item) => item.id === "trae");
    if (provider) provider.status = "unavailable";
  }
  return cloned;
}

function createState(data) {
  const params = new URLSearchParams(window.location.search);
  const requestedView = params.get("view");
  const activeView = navigation.some((item) => item.id === requestedView)
    ? requestedView
    : "overview";
  const scenario = getScenario();
  const scenarioRun =
    scenario === "no-novelty"
      ? data.runs.find((run) => run.status === "no_novelty")
      : data.runs[0];

  return {
    data,
    scenario,
    activeView,
    selectedRunId: scenarioRun?.id ?? data.runs[0]?.id,
    selectedInsightId: data.insights[0]?.id,
    selectedCandidateId: data.candidates[0]?.id,
    modal: null,
    runForm: {
      profile: "standard",
      provider: "auto",
    },
  };
}

function navCount(state, id) {
  if (id === "runs") return state.data.runs.length;
  if (id === "insights") return state.data.insights.length;
  if (id === "candidates") {
    return state.data.candidates.filter((item) => item.status === "canary").length;
  }
  if (id === "schedules") {
    return state.data.schedules.filter((item) => item.enabled).length;
  }
  return null;
}

function renderShell(state) {
  const page = pageCopy[state.activeView];
  const degraded = state.data.providers.some(
    (provider) => provider.status !== "available",
  );

  app.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-mark">RW</div>
          <div class="brand-copy">
            <p class="brand-name">Runweave</p>
            <p class="brand-section">Evolution</p>
          </div>
        </div>
        <section class="scope-card" aria-label="当前学习范围">
          <div class="scope-top">
            <span class="scope-name">${escapeHtml(state.data.product.scope.name)}</span>
            <span class="scope-badge">${state.data.product.scope.workspaceCount} WS</span>
          </div>
          <p class="scope-subtitle">${escapeHtml(state.data.product.scope.subtitle)}</p>
        </section>
        <nav class="nav" aria-label="Evolution 导航">
          <div class="nav-label">自进化</div>
          ${navigation
            .map((item) => {
              const count = navCount(state, item.id);
              return `
                <button class="nav-item ${state.activeView === item.id ? "active" : ""}" type="button" data-view="${item.id}">
                  ${icon(item.icon)}
                  <span class="nav-text">${item.label}</span>
                  ${count === null ? "" : `<span class="nav-count">${count}</span>`}
                </button>
              `;
            })
            .join("")}
        </nav>
        <div class="sidebar-footer">
          ${state.data.providers
            .map(
              (provider) => `
                <div class="provider-row">
                  <span class="status-dot ${provider.status === "available" ? "" : "unavailable"}"></span>
                  <span>${escapeHtml(provider.name)} · ${provider.status === "available" ? "可用" : "不可用"}</span>
                </div>
              `,
            )
            .join("")}
          <div class="provider-row">
            ${icon("shield")}
            <span>${degraded ? "跨 Provider 分析已降级" : "跨 Provider 分析可用"}</span>
          </div>
        </div>
      </aside>
      <section class="main-shell">
        <header class="topbar">
          <div class="page-title">
            <h1>${page.title}</h1>
            <p>${page.subtitle}</p>
          </div>
          <div class="top-actions">
            ${
              state.activeView === "schedules"
                ? `<button class="button" type="button" data-open-schedule>${icon("plus")}新建计划</button>`
                : `<button class="button" type="button" data-view="schedules">${icon("schedules")}运行计划</button>`
            }
            <button class="button primary" type="button" data-open-run>${icon("spark")}发起反思</button>
          </div>
        </header>
        <div class="page-scroll">
          <div class="page-content">${renderActiveView(state)}</div>
        </div>
      </section>
    </div>
  `;

  renderModal(state);
}

function renderActiveView(state) {
  if (state.activeView === "runs") return renderRuns(state);
  if (state.activeView === "insights") return renderInsights(state);
  if (state.activeView === "candidates") return renderCandidates(state);
  if (state.activeView === "schedules") return renderSchedules(state);
  return renderOverview(state);
}

function renderNotice(state) {
  if (state.scenario === "degraded") {
    return `
      <div class="notice warning">
        <div class="notice-copy">${icon("alert")}<span>Trae 当前不可用，Auto 将使用 Codex 单 Provider；不会标记为跨 Provider 验证。</span></div>
        <button class="button ghost small" type="button" data-view="runs">查看影响</button>
      </div>
    `;
  }
  if (state.scenario === "running" || state.data.runs[0]?.status === "running") {
    return `
      <div class="notice warning">
        <div class="notice-copy"><span class="running-pulse"></span><span>Evolution Run 正在执行，Analyst 首轮报告保持相互隔离。</span></div>
        <button class="button ghost small" type="button" data-view="runs">查看运行</button>
      </div>
    `;
  }
  if (state.scenario === "no-novelty") {
    return `
      <div class="notice success">
        <div class="notice-copy">${icon("check")}<span>最近一次反思没有发现实质新知识，未生成 Insight 或 Candidate。</span></div>
        <button class="button ghost small" type="button" data-view="runs">查看覆盖范围</button>
      </div>
    `;
  }
  return "";
}

function renderOverview(state) {
  if (state.scenario === "empty") {
    return `
      <div class="hero-row">
        <div class="hero-copy">
          <h2>${escapeHtml(state.data.product.scope.name)} 的长期学习</h2>
          <p>${state.data.product.scope.workspaceCount} 个 workspace 共享同一主项目知识范围。</p>
        </div>
      </div>
      <section class="panel empty-state">
        <div class="empty-state-inner">
          <div class="empty-icon">${icon("spark")}</div>
          <h2>尚未运行项目反思</h2>
          <p>首次运行会冻结所选窗口的证据，由 Agent 独立分析并只保存通过新颖性校验的长期洞察。</p>
          <button class="button primary" type="button" data-open-run>${icon("spark")}发起第一次反思</button>
        </div>
      </section>
    `;
  }

  const run =
    state.scenario === "no-novelty"
      ? state.data.runs.find((item) => item.status === "no_novelty")
      : state.data.runs[0];
  const contested = state.data.claims.filter(
    (claim) => claim.state === "contested",
  );
  const activeMemory = state.data.candidates.find(
    (candidate) => candidate.status === "canary",
  );

  return `
    ${renderNotice(state)}
    <div class="hero-row">
      <div class="hero-copy">
        <h2>${escapeHtml(state.data.product.scope.name)} 的长期学习</h2>
        <p>${state.data.product.scope.workspaceCount} 个 workspace 共享知识范围；每条证据仍保留原 workspace 和 source revision。</p>
      </div>
      <div class="as-of">最近更新 · ${escapeHtml(state.data.overview.lastRunAt)}</div>
    </div>
    <section class="metric-grid" aria-label="Evolution 指标">
      ${renderMetric("本次检查事实", state.data.overview.factsReviewed.toLocaleString(), "27 个语义 Episode", "")}
      ${renderMetric("新增洞察", state.data.overview.newInsights, "2 条新增 · 1 条证据增强", "accent-value")}
      ${renderMetric("待补证据", state.data.overview.contestedClaims, "Agent 归因仍有分歧", "warning-value")}
      ${renderMetric("运行时 Memory", state.data.overview.activeMemories, "1 条 Canary · 默认不全量注入", "success-value")}
    </section>
    <div class="dashboard-grid">
      <div class="stack">
        <section class="panel">
          <div class="panel-header">
            <div class="panel-header-copy">
              <h3>最近一次反思</h3>
              <p>${escapeHtml(run.range)} · ${escapeHtml(run.providerPolicy)}</p>
            </div>
            <button class="button ghost small" type="button" data-run-id="${run.id}" data-view-run>查看详情 ${icon("chevron")}</button>
          </div>
          <div class="panel-body">${renderRunCore(run)}</div>
        </section>
        <section class="panel">
          <div class="panel-header">
            <div class="panel-header-copy">
              <h3>高价值洞察</h3>
              <p>只展示新增、冲突、漂移和实质证据增强</p>
            </div>
            <button class="button ghost small" type="button" data-view="insights">全部洞察 ${icon("chevron")}</button>
          </div>
          <div class="section-list">
            ${state.data.insights
              .slice(0, 3)
              .map((insight) => renderInsightRow(insight))
              .join("")}
          </div>
        </section>
      </div>
      <div class="stack">
        <section class="panel">
          <div class="panel-header">
            <div class="panel-header-copy">
              <h3>尚未统一的判断</h3>
              <p>证据不足时保留竞争性结论</p>
            </div>
            ${statusPill("contested", `${contested.length} 条`)}
          </div>
          <div>
            ${contested.length ? contested.map(renderClaimMini).join("") : renderNoContested()}
          </div>
        </section>
        <section class="panel">
          <div class="panel-header">
            <div class="panel-header-copy">
              <h3>Memory Canary</h3>
              <p>只影响当前主项目的 code worker</p>
            </div>
            ${activeMemory ? statusPill("canary", "Canary") : statusPill("shadow", "未启用")}
          </div>
          ${activeMemory ? renderActiveMemory(activeMemory) : `<div class="panel-body"><p class="list-row-description">当前没有运行中的 Canary。</p></div>`}
        </section>
        <section class="panel">
          <div class="panel-header">
            <div class="panel-header-copy">
              <h3>下一次运行</h3>
              <p>计划错过多个时间槽时合并为一次增量 catch-up</p>
            </div>
          </div>
          <div class="panel-body">
            <div class="run-summary">
              <div>
                <p class="run-title">${escapeHtml(state.data.schedules[0].name)}</p>
                <div class="run-meta">
                  <span>${escapeHtml(state.data.schedules[0].expression)}</span>
                  <span>${escapeHtml(state.data.schedules[0].profile)}</span>
                  <span>${escapeHtml(state.data.schedules[0].providerPolicy)}</span>
                </div>
              </div>
              ${statusPill("active", "已启用")}
            </div>
          </div>
        </section>
      </div>
    </div>
  `;
}

function renderMetric(label, value, foot, valueClass) {
  return `
    <article class="metric-card">
      <div class="metric-head"><span>${escapeHtml(label)}</span>${icon("activity")}</div>
      <div class="metric-value ${valueClass}">${escapeHtml(value)}</div>
      <div class="metric-foot">${escapeHtml(foot)}</div>
    </article>
  `;
}

function renderRunCore(run) {
  return `
    <div class="run-summary">
      <div>
        <p class="run-title">${escapeHtml(run.title)}</p>
        <div class="run-meta">
          <span>${escapeHtml(run.trigger)}</span>
          <span>${escapeHtml(run.profile)}</span>
          <span>${escapeHtml(run.createdAt)}</span>
          <span>${escapeHtml(run.duration)}</span>
        </div>
      </div>
      ${statusPill(run.status, run.statusLabel)}
    </div>
    <div class="stage-track" aria-label="运行阶段">
      ${run.stages
        .map(
          (stage) => `<div class="stage-step ${stage.status}">${escapeHtml(stage.label)}</div>`,
        )
        .join("")}
    </div>
    <div class="analyst-grid">
      ${run.analysts.map(renderAnalyst).join("")}
    </div>
    <div class="cross-note"><strong>交叉质疑：</strong>${escapeHtml(run.crossQuestion)}</div>
  `;
}

function renderAnalyst(analyst) {
  return `
    <article class="analyst-card">
      <div class="analyst-head">
        <div class="analyst-name">
          <span class="analyst-mark">${escapeHtml(analyst.id.toUpperCase())}</span>
          <span>${escapeHtml(analyst.name)}</span>
        </div>
        <span class="analyst-provider">${escapeHtml(analyst.provider)} · ${analyst.status === "running" ? "分析中" : `${analyst.evidenceCount} evidence`}</span>
      </div>
      <p class="analyst-summary">${escapeHtml(analyst.summary)}</p>
    </article>
  `;
}

function renderInsightRow(insight, selected = false) {
  return `
    <article class="list-row ${selected ? "selected" : ""}" tabindex="0" data-insight-id="${insight.id}">
      <div class="list-row-main">
        <div class="list-row-title">
          <strong>${escapeHtml(insight.title)}</strong>
          ${statusPill(insight.status, insight.statusLabel)}
        </div>
        <p class="list-row-description">${escapeHtml(insight.summary)}</p>
        <div class="list-row-meta">${escapeHtml(insight.category)} · revision ${insight.revision} · ${escapeHtml(insight.updatedAt)}</div>
      </div>
      <div class="list-row-side">
        ${tag(insight.noveltyLabel)}
        <span class="evidence-summary">${insight.supportingEvidence} 来源 · ${insight.counterEvidence} 反例</span>
      </div>
    </article>
  `;
}

function renderClaimMini(claim) {
  return `
    <article class="claim-mini">
      <div class="claim-mini-head">
        <h4>${escapeHtml(claim.title)}</h4>
        ${statusPill(claim.state, claim.stateLabel)}
      </div>
      <p>${escapeHtml(claim.statement)}</p>
      <div class="claim-balance">
        <span class="support">${claim.support} 个相关来源</span>
        <span class="counter">${claim.counter} 个反例记录</span>
      </div>
    </article>
  `;
}

function renderNoContested() {
  return `<div class="panel-body"><p class="list-row-description">当前没有需要补证据的竞争性判断。</p></div>`;
}

function renderActiveMemory(candidate) {
  return `
    <div class="panel-body">
      <p class="run-title">${escapeHtml(candidate.title)}</p>
      <p class="list-row-description">${escapeHtml(candidate.summary)}</p>
      <div class="detail-grid" style="margin-top: 12px">
        <div class="data-card"><div class="data-label">Control</div><div class="data-value">${escapeHtml(candidate.control)}</div></div>
        <div class="data-card"><div class="data-label">Canary</div><div class="data-value">${escapeHtml(candidate.canary)}</div></div>
        <div class="data-card" style="grid-column: 1 / -1"><div class="data-label">样本判断</div><div class="data-value">${escapeHtml(candidate.outcome)}</div></div>
      </div>
      <div class="inline-actions" style="justify-content: flex-end; margin-top: 11px">
        <button class="button ghost small" type="button" data-candidate-id="${candidate.id}">查看 RuntimeTrace ${icon("chevron")}</button>
      </div>
    </div>
  `;
}

function renderRuns(state) {
  const selected =
    state.data.runs.find((run) => run.id === state.selectedRunId) ??
    state.data.runs[0];
  return `
    ${renderNotice(state)}
    <section class="split-view">
      <div class="split-list">
        <div class="split-list-head">
          <strong>${state.data.runs.length} 次运行</strong>
          <button class="icon-button" type="button" aria-label="筛选运行">${icon("filter")}</button>
        </div>
        <div class="section-list">
          ${state.data.runs
            .map(
              (run) => `
                <article class="list-row ${run.id === selected.id ? "selected" : ""}" tabindex="0" data-run-id="${run.id}">
                  <div class="list-row-main">
                    <div class="list-row-title"><strong>${escapeHtml(run.title)}</strong></div>
                    <p class="list-row-description">${escapeHtml(run.range)} · ${escapeHtml(run.providerPolicy)}</p>
                    <div class="list-row-meta">${escapeHtml(run.createdAt)} · ${run.factsReviewed.toLocaleString()} facts · ${run.episodes} episodes</div>
                  </div>
                  <div class="list-row-side">${statusPill(run.status, run.statusLabel)}</div>
                </article>
              `,
            )
            .join("")}
        </div>
      </div>
      <div class="split-detail">
        <div class="detail-head">
          <strong>Run 详情</strong>
          <div class="inline-actions">
            ${selected.status === "running" ? `<button class="button danger small" type="button" data-cancel-run="${selected.id}">取消运行</button>` : ""}
            <button class="icon-button" type="button" aria-label="更多操作">${icon("dots")}</button>
          </div>
        </div>
        <div class="detail-scroll">${renderRunDetail(selected, state)}</div>
      </div>
    </section>
  `;
}

function renderRunDetail(run, state) {
  const claims = state.data.claims.filter((claim) =>
    run.claimIds.includes(claim.id),
  );
  return `
    <div class="detail-title-row">
      <div>
        <h2>${escapeHtml(run.title)}</h2>
        <p>${escapeHtml(run.trigger)} · ${escapeHtml(run.profile)} · ${escapeHtml(run.providerPolicy)} · ${escapeHtml(run.range)}</p>
      </div>
      ${statusPill(run.status, run.statusLabel)}
    </div>
    <div class="detail-section">
      ${renderRunCore(run)}
    </div>
    <section class="detail-section">
      <h3>运行数据</h3>
      <div class="detail-grid">
        ${renderDataCard("冻结事实", run.factsReviewed.toLocaleString())}
        ${renderDataCard("语义 Episode", run.episodes)}
        ${renderDataCard("Claims", run.claims)}
        ${renderDataCard("实质新增", run.novelClaims)}
        ${renderDataCard("数据质量", run.dataQuality)}
        ${renderDataCard("耗时", run.duration)}
      </div>
    </section>
    <section class="detail-section">
      <h3>预算</h3>
      <div class="detail-grid">
        ${renderDataCard("Model turns", run.budget.turns)}
        ${renderDataCard("Tool calls", run.budget.tools)}
        ${renderDataCard("Context", run.budget.context)}
      </div>
    </section>
    <section class="detail-section">
      <h3>Claim ledger</h3>
      ${
        claims.length
          ? `<div class="panel">${claims.map(renderClaimMini).join("")}</div>`
          : `<div class="data-card"><div class="data-value">${run.status === "no_novelty" ? "Novelty Gate 判定为已知或仅证据增强，未建立新的 Claim。" : "本次运行没有可提交的 Claim。"}</div></div>`
      }
    </section>
  `;
}

function renderDataCard(label, value) {
  return `<div class="data-card"><div class="data-label">${escapeHtml(label)}</div><div class="data-value">${escapeHtml(value)}</div></div>`;
}

function renderInsights(state) {
  const selected =
    state.data.insights.find(
      (insight) => insight.id === state.selectedInsightId,
    ) ?? state.data.insights[0];
  return `
    <section class="split-view">
      <div class="split-list">
        <div class="split-list-head">
          <strong>${state.data.insights.length} 条长期洞察</strong>
          <button class="icon-button" type="button" aria-label="筛选洞察">${icon("filter")}</button>
        </div>
        <div class="section-list">
          ${state.data.insights
            .map((insight) => renderInsightRow(insight, insight.id === selected.id))
            .join("")}
        </div>
      </div>
      <div class="split-detail">
        <div class="detail-head">
          <strong>Insight revision</strong>
          <button class="button ghost small" type="button" data-open-evidence="${selected.id}">${icon("external")}查看来源</button>
        </div>
        <div class="detail-scroll">${renderInsightDetail(selected, state)}</div>
      </div>
    </section>
  `;
}

function renderInsightDetail(insight, state) {
  const candidates = state.data.candidates.filter((candidate) =>
    insight.candidateIds.includes(candidate.id),
  );
  return `
    <div class="detail-title-row">
      <div>
        <h2>${escapeHtml(insight.title)}</h2>
        <p>${escapeHtml(insight.summary)}</p>
      </div>
      ${statusPill(insight.status, insight.statusLabel)}
    </div>
    <section class="detail-section">
      <div class="detail-grid">
        ${renderDataCard("新颖性", insight.noveltyLabel)}
        ${renderDataCard("结论状态", insight.statusLabel)}
        ${renderDataCard("相关来源", insight.supportingEvidence)}
        ${renderDataCard("反例记录", insight.counterEvidence)}
      </div>
    </section>
    <section class="detail-section">
      <h3>适用边界</h3>
      <div class="detail-grid">
        ${renderDataCard("适用范围", insight.scope)}
        ${renderDataCard("排除条件", insight.exclusions)}
      </div>
    </section>
    <section class="detail-section">
      <h3>Revision history</h3>
      <div class="revision-list">
        ${insight.revisions
          .map(
            (revision) => `
              <article class="revision-row">
                <span class="revision-number">r${revision.revision}</span>
                <div class="revision-copy">
                  <strong>${escapeHtml(revision.date)}</strong>
                  <p>${escapeHtml(revision.change)}</p>
                </div>
              </article>
            `,
          )
          .join("")}
      </div>
    </section>
    <section class="detail-section">
      <h3>派生资产</h3>
      ${
        candidates.length
          ? `<div class="revision-list">${candidates
              .map(
                (candidate) => `
                  <article class="evidence-row" data-candidate-id="${candidate.id}" tabindex="0">
                    <span class="type-mark">${escapeHtml(candidate.type.slice(0, 3).toUpperCase())}</span>
                    <div class="evidence-copy">
                      <strong>${escapeHtml(candidate.title)}</strong>
                      <p>${escapeHtml(candidate.statusLabel)} · ${escapeHtml(candidate.evidenceGrade)} · ${escapeHtml(candidate.scope)}</p>
                    </div>
                    ${statusPill(candidate.status, candidate.statusLabel)}
                  </article>
                `,
              )
              .join("")}</div>`
          : `<div class="data-card"><div class="data-value">存在未解决分歧，暂不生成可激活资产。</div></div>`
      }
    </section>
  `;
}

function renderCandidates(state) {
  const selected =
    state.data.candidates.find(
      (candidate) => candidate.id === state.selectedCandidateId,
    ) ?? state.data.candidates[0];
  return `
    <section class="policy-bar">
      <div class="policy-copy">
        <strong>运行时注入策略</strong>
        <span>当前 scope 仅允许 Memory Canary；最多 3 条、6 KB。Prompt / Skill / Routing / Product / Code 不会自动应用。</span>
      </div>
      ${statusPill("canary", "Canary 10%")}
    </section>
    <section class="split-view">
      <div class="split-list">
        <div class="split-list-head">
          <strong>${state.data.candidates.length} 个候选</strong>
          <button class="icon-button" type="button" aria-label="筛选候选">${icon("filter")}</button>
        </div>
        <div class="section-list">
          ${state.data.candidates
            .map(
              (candidate) => `
                <article class="list-row ${candidate.id === selected.id ? "selected" : ""}" tabindex="0" data-candidate-id="${candidate.id}">
                  <div class="list-row-main">
                    <div class="list-row-title">
                      <span class="type-mark" style="width:28px;height:28px">${escapeHtml(candidate.type.slice(0, 3).toUpperCase())}</span>
                      <strong>${escapeHtml(candidate.title)}</strong>
                    </div>
                    <p class="list-row-description">${escapeHtml(candidate.scope)} · ${escapeHtml(candidate.risk)}</p>
                    <div class="list-row-meta">${escapeHtml(candidate.evidenceGrade)} · ${escapeHtml(candidate.lastUpdated)}</div>
                  </div>
                  <div class="list-row-side">${statusPill(candidate.status, candidate.statusLabel)}</div>
                </article>
              `,
            )
            .join("")}
        </div>
      </div>
      <div class="split-detail">
        <div class="detail-head">
          <strong>Candidate 详情</strong>
          ${renderCandidateAction(selected)}
        </div>
        <div class="detail-scroll">${renderCandidateDetail(selected)}</div>
      </div>
    </section>
  `;
}

function renderCandidateAction(candidate) {
  if (candidate.type !== "Memory") return statusPill("proposal", "仅提案");
  if (candidate.status === "canary") {
    return `<button class="button danger small" type="button" data-stop-canary="${candidate.id}">停止注入</button>`;
  }
  if (candidate.status === "shadow") {
    return `<button class="button primary small" type="button" data-start-canary="${candidate.id}">开始 Canary</button>`;
  }
  return "";
}

function renderCandidateDetail(candidate) {
  return `
    <div class="detail-title-row">
      <div>
        <h2>${escapeHtml(candidate.title)}</h2>
        <p>${escapeHtml(candidate.summary)}</p>
      </div>
      ${statusPill(candidate.status, candidate.statusLabel)}
    </div>
    <section class="detail-section">
      <div class="detail-grid">
        ${renderDataCard("资产类型", candidate.type)}
        ${renderDataCard("风险", candidate.risk)}
        ${renderDataCard("证据等级", candidate.evidenceGrade)}
        ${renderDataCard("适用范围", candidate.scope)}
      </div>
    </section>
    <section class="detail-section">
      <h3>运行时状态</h3>
      <div class="detail-grid">
        ${renderDataCard("已暴露", candidate.exposure)}
        ${renderDataCard("Control", candidate.control)}
        ${renderDataCard("Canary", candidate.canary)}
        ${renderDataCard("样本判断", candidate.outcome)}
      </div>
    </section>
    <section class="detail-section">
      <h3>治理边界</h3>
      <div class="data-card">
        <div class="data-value">${
          candidate.type === "Memory"
            ? "只会作为带 assetId、状态和证据等级的 advisory context 注入 code worker；不会重写用户任务、系统 Prompt 或 AGENTS.md。"
            : `${escapeHtml(candidate.type)} 在 V1 中只能形成结构化提案，不能自动修改运行时、仓库或外部系统。`
        }</div>
      </div>
    </section>
    ${
      candidate.status === "canary"
        ? `
          <section class="detail-section">
            <h3>最近 RuntimeTrace</h3>
            <div class="revision-list">
              ${renderTrace("agt_2031", "Canary", "已注入 · 后续 behavior_verify 通过")}
              ${renderTrace("agt_2028", "Control", "未注入 · 后续出现 1 次重复澄清")}
              ${renderTrace("agt_2022", "Canary", "已检索但 Selector 未选择")}
            </div>
          </section>
        `
        : ""
    }
  `;
}

function renderTrace(id, bucket, result) {
  return `
    <article class="revision-row">
      <span class="revision-number">${bucket === "Canary" ? "C" : "0"}</span>
      <div class="revision-copy">
        <strong>${escapeHtml(id)} · ${escapeHtml(bucket)}</strong>
        <p>${escapeHtml(result)}</p>
      </div>
    </article>
  `;
}

function renderSchedules(state) {
  return `
    <div class="hero-row">
      <div class="hero-copy">
        <h2>运行计划</h2>
        <p>配置执行频率、分析强度、Provider、数据窗口和 timezone。</p>
      </div>
      <div class="as-of">${state.data.schedules.filter((item) => item.enabled).length} 个计划已启用</div>
    </div>
    <section class="schedule-grid">
      ${state.data.schedules.map(renderScheduleCard).join("")}
    </section>
  `;
}

function renderScheduleCard(schedule) {
  return `
    <article class="schedule-card">
      <div class="schedule-head">
        <div>
          <h3>${escapeHtml(schedule.name)}</h3>
          <p>${escapeHtml(schedule.expression)} · ${escapeHtml(schedule.timezone)}</p>
        </div>
        <button class="switch ${schedule.enabled ? "enabled" : ""}" type="button" role="switch" aria-checked="${schedule.enabled}" aria-label="${schedule.enabled ? "暂停" : "启用"}${escapeHtml(schedule.name)}" data-toggle-schedule="${schedule.id}"></button>
      </div>
      <div class="schedule-meta">
        ${renderDataCard("Profile", schedule.profile)}
        ${renderDataCard("Provider", schedule.providerPolicy)}
        ${renderDataCard("数据范围", schedule.range)}
        ${renderDataCard("下次运行", schedule.nextRunAt)}
      </div>
      <div class="schedule-actions">
        <button class="button ghost small" type="button" data-edit-schedule="${schedule.id}">编辑</button>
        <button class="button small" type="button" data-run-schedule="${schedule.id}">立即运行</button>
      </div>
    </article>
  `;
}

function renderModal(state) {
  if (!state.modal) {
    modalRoot.innerHTML = "";
    return;
  }

  if (state.modal.type === "run") {
    modalRoot.innerHTML = renderRunModal(state);
    return;
  }
  if (state.modal.type === "schedule") {
    modalRoot.innerHTML = renderScheduleModal(state);
    return;
  }
  if (state.modal.type === "confirm-canary") {
    const candidate = state.data.candidates.find(
      (item) => item.id === state.modal.candidateId,
    );
    modalRoot.innerHTML = renderCanaryConfirm(candidate);
  }
}

function renderRunModal(state) {
  return `
    <div class="modal-backdrop" data-modal-backdrop>
      <form class="modal" data-run-form>
        <header class="modal-header">
          <h2>发起项目反思</h2>
          <button class="icon-button" type="button" aria-label="关闭" data-close-modal>${icon("close")}</button>
        </header>
        <div class="modal-body">
          <div class="form-grid">
            <div class="field full">
              <label>分析强度</label>
              <div class="choice-grid">
                ${renderProfileChoice("quick", "Quick", "单 Analyst · 快速扫描", state.runForm.profile)}
                ${renderProfileChoice("standard", "Standard", "双 Analyst · 交叉质疑", state.runForm.profile)}
                ${renderProfileChoice("deep", "Deep", "双 Analyst · 条件 Judge", state.runForm.profile)}
              </div>
            </div>
            <div class="field">
              <label for="run-provider">Provider 策略</label>
              <select id="run-provider" class="select" name="provider">
                <option value="auto">Auto · 优先跨 Provider</option>
                <option value="mixed">Mixed · 必须 Codex + Trae</option>
                <option value="codex">仅 Codex</option>
                <option value="trae">仅 Trae</option>
              </select>
            </div>
            <div class="field">
              <label for="run-range">数据范围</label>
              <select id="run-range" class="select" name="range">
                <option value="incremental">自上次成功 watermark</option>
                <option value="7d">最近 7 天</option>
                <option value="30d">最近 30 天</option>
              </select>
            </div>
            <div class="field full">
              <label for="run-focus">本次关注（可选）</label>
              <input id="run-focus" class="input" name="focus" placeholder="例如：跨 workspace 的上下文恢复失败" />
              <span class="field-help">关注点只缩小调查优先级，不限制 Agent 查询相关反例。</span>
            </div>
            <div class="field">
              <label for="run-time">最长运行时间</label>
              <select id="run-time" class="select" name="wallTime">
                <option>20 分钟</option>
                <option>40 分钟</option>
                <option>60 分钟</option>
              </select>
            </div>
            <div class="field">
              <label for="run-tools">最大工具调用</label>
              <select id="run-tools" class="select" name="tools">
                <option>60 次</option>
                <option>100 次</option>
                <option>150 次</option>
              </select>
            </div>
          </div>
          <div class="form-note">将为 ${escapeHtml(state.data.product.scope.name)} 及其 ${state.data.product.scope.workspaceCount} 个 workspace 冻结同一证据视图。运行只读，不会修改 workspace、Prompt、Skill 或代码。</div>
        </div>
        <footer class="modal-footer">
          <button class="button" type="button" data-close-modal>取消</button>
          <button class="button primary" type="submit">开始运行</button>
        </footer>
      </form>
    </div>
  `;
}

function renderProfileChoice(value, title, subtitle, selected) {
  return `
    <button class="choice ${value === selected ? "selected" : ""}" type="button" data-profile="${value}">
      <strong>${title}</strong>
      <span>${subtitle}</span>
    </button>
  `;
}

function renderScheduleModal(state) {
  const editing = state.modal.scheduleId
    ? state.data.schedules.find((item) => item.id === state.modal.scheduleId)
    : null;
  return `
    <div class="modal-backdrop" data-modal-backdrop>
      <form class="modal" data-schedule-form>
        <header class="modal-header">
          <h2>${editing ? "编辑运行计划" : "新建运行计划"}</h2>
          <button class="icon-button" type="button" aria-label="关闭" data-close-modal>${icon("close")}</button>
        </header>
        <div class="modal-body">
          <div class="form-grid">
            <div class="field full">
              <label for="schedule-name">计划名称</label>
              <input id="schedule-name" class="input" name="name" value="${escapeHtml(editing?.name ?? "每周项目反思")}" required />
            </div>
            <div class="field">
              <label for="schedule-cadence">执行频率</label>
              <select id="schedule-cadence" class="select" name="cadence">
                <option>${escapeHtml(editing?.expression ?? "每周一 10:00")}</option>
                <option>每周五 18:00</option>
                <option>每月 1 日 09:30</option>
                <option>自定义 Cron</option>
              </select>
            </div>
            <div class="field">
              <label for="schedule-timezone">时区</label>
              <select id="schedule-timezone" class="select" name="timezone">
                <option>Asia/Shanghai</option>
                <option>UTC</option>
                <option>America/Los_Angeles</option>
              </select>
            </div>
            <div class="field">
              <label for="schedule-profile">分析强度</label>
              <select id="schedule-profile" class="select" name="profile">
                <option>Standard</option>
                <option>Quick</option>
                <option>Deep</option>
              </select>
            </div>
            <div class="field">
              <label for="schedule-provider">Provider 策略</label>
              <select id="schedule-provider" class="select" name="provider">
                <option>Auto</option>
                <option>Mixed</option>
                <option>Codex</option>
                <option>Trae</option>
              </select>
            </div>
            <div class="field full">
              <label for="schedule-range">增量范围</label>
              <select id="schedule-range" class="select" name="range">
                <option>自上次成功 watermark</option>
                <option>最近 7 天</option>
                <option>最近 30 天</option>
              </select>
              <span class="field-help">Backend 离线期间错过多个时间槽时，只合并为一次 catch-up。</span>
            </div>
          </div>
        </div>
        <footer class="modal-footer">
          <button class="button" type="button" data-close-modal>取消</button>
          <button class="button primary" type="submit">${editing ? "保存修改" : "创建计划"}</button>
        </footer>
      </form>
    </div>
  `;
}

function renderCanaryConfirm(candidate) {
  if (!candidate) return "";
  return `
    <div class="modal-backdrop" data-modal-backdrop>
      <section class="modal small-modal" role="dialog" aria-modal="true" aria-labelledby="canary-title">
        <header class="modal-header">
          <h2 id="canary-title">开始 Memory Canary</h2>
          <button class="icon-button" type="button" aria-label="关闭" data-close-modal>${icon("close")}</button>
        </header>
        <div class="modal-body">
          <p class="run-title">${escapeHtml(candidate.title)}</p>
          <p class="list-row-description" style="font-size:10px;margin-top:8px">只在 browser-viewer 主项目的 eligible code worker 中按 10% 分配。Control 不注入，Canary 会显示带 assetId 和证据等级的 advisory context。</p>
          <div class="form-note">Review、behavior verifier、其他主项目、Prompt、Skill 和代码不会被修改。你可以随时停止新的注入。</div>
        </div>
        <footer class="modal-footer">
          <button class="button" type="button" data-close-modal>取消</button>
          <button class="button primary" type="button" data-confirm-canary="${candidate.id}">开始 Canary</button>
        </footer>
      </section>
    </div>
  `;
}

function bindInteractions(state) {
  app.addEventListener("click", (event) => {
    const viewButton = event.target.closest("[data-view]");
    if (viewButton) {
      state.activeView = viewButton.dataset.view;
      setQueryView(state.activeView);
      renderShell(state);
      return;
    }

    const viewRun = event.target.closest("[data-view-run]");
    if (viewRun) {
      state.selectedRunId = viewRun.dataset.runId;
      state.activeView = "runs";
      setQueryView("runs");
      renderShell(state);
      return;
    }

    const runRow = event.target.closest("[data-run-id]");
    if (runRow && !event.target.closest("[data-cancel-run]")) {
      state.selectedRunId = runRow.dataset.runId;
      renderShell(state);
      return;
    }

    const insightRow = event.target.closest("[data-insight-id]");
    if (insightRow) {
      state.selectedInsightId = insightRow.dataset.insightId;
      if (state.activeView !== "insights") {
        state.activeView = "insights";
        setQueryView("insights");
      }
      renderShell(state);
      return;
    }

    const candidateRow = event.target.closest("[data-candidate-id]");
    if (candidateRow) {
      state.selectedCandidateId = candidateRow.dataset.candidateId;
      if (state.activeView !== "candidates") {
        state.activeView = "candidates";
        setQueryView("candidates");
      }
      renderShell(state);
      return;
    }

    if (event.target.closest("[data-open-run]")) {
      state.modal = { type: "run" };
      renderShell(state);
      return;
    }

    if (event.target.closest("[data-open-schedule]")) {
      state.modal = { type: "schedule" };
      renderShell(state);
      return;
    }

    const editSchedule = event.target.closest("[data-edit-schedule]");
    if (editSchedule) {
      state.modal = {
        type: "schedule",
        scheduleId: editSchedule.dataset.editSchedule,
      };
      renderShell(state);
      return;
    }

    const toggleSchedule = event.target.closest("[data-toggle-schedule]");
    if (toggleSchedule) {
      const schedule = state.data.schedules.find(
        (item) => item.id === toggleSchedule.dataset.toggleSchedule,
      );
      if (schedule) {
        schedule.enabled = !schedule.enabled;
        schedule.nextRunAt = schedule.enabled ? schedule.expression : "已暂停";
        showToast(`${schedule.name}已${schedule.enabled ? "启用" : "暂停"}`, "success");
        renderShell(state);
      }
      return;
    }

    const runSchedule = event.target.closest("[data-run-schedule]");
    if (runSchedule) {
      const schedule = state.data.schedules.find(
        (item) => item.id === runSchedule.dataset.runSchedule,
      );
      if (schedule) {
        const newRun = createRunningRun(state.data, schedule.name);
        newRun.trigger = "计划 · 手动执行";
        state.data.runs.unshift(newRun);
        state.selectedRunId = newRun.id;
        state.activeView = "runs";
        setQueryView("runs");
        showToast("已创建 Evolution Run", "success");
        renderShell(state);
      }
      return;
    }

    const cancelRun = event.target.closest("[data-cancel-run]");
    if (cancelRun) {
      const run = state.data.runs.find(
        (item) => item.id === cancelRun.dataset.cancelRun,
      );
      if (run) {
        run.status = "partial";
        run.statusLabel = "已取消";
        run.crossQuestion = "用户取消运行；半成品不会提交长期知识。";
        showToast("运行已取消，分析产物保持隔离");
        renderShell(state);
      }
      return;
    }

    const startCanary = event.target.closest("[data-start-canary]");
    if (startCanary) {
      state.modal = {
        type: "confirm-canary",
        candidateId: startCanary.dataset.startCanary,
      };
      renderShell(state);
      return;
    }

    const stopCanary = event.target.closest("[data-stop-canary]");
    if (stopCanary) {
      const candidate = state.data.candidates.find(
        (item) => item.id === stopCanary.dataset.stopCanary,
      );
      if (candidate) {
        candidate.status = "shadow";
        candidate.statusLabel = "Shadow";
        candidate.exposure = "已停止新注入";
        showToast("已停止新的 Canary 注入", "success");
        renderShell(state);
      }
      return;
    }

    if (event.target.closest("[data-open-evidence]")) {
      showToast("正在打开关联的 Activity / Work History 证据");
    }
  });

  modalRoot.addEventListener("click", (event) => {
    if (event.target.matches("[data-modal-backdrop]")) {
      state.modal = null;
      renderShell(state);
      return;
    }

    if (event.target.closest("[data-close-modal]")) {
      state.modal = null;
      renderShell(state);
      return;
    }

    const profile = event.target.closest("[data-profile]");
    if (profile) {
      state.runForm.profile = profile.dataset.profile;
      renderShell(state);
      return;
    }

    const confirmCanary = event.target.closest("[data-confirm-canary]");
    if (confirmCanary) {
      const candidate = state.data.candidates.find(
        (item) => item.id === confirmCanary.dataset.confirmCanary,
      );
      if (candidate) {
        candidate.status = "canary";
        candidate.statusLabel = "Canary";
        candidate.exposure = "0 / 20 eligible tasks";
        candidate.control = "0 tasks · 等待样本";
        candidate.canary = "0 tasks · 等待样本";
        candidate.outcome = "尚无样本 · 暂不判断";
        state.modal = null;
        showToast("Memory Canary 已开启", "success");
        renderShell(state);
      }
    }
  });

  modalRoot.addEventListener("submit", (event) => {
    event.preventDefault();
    const runForm = event.target.closest("[data-run-form]");
    if (runForm) {
      const formData = new FormData(runForm);
      const focus = String(formData.get("focus") ?? "").trim();
      const run = createRunningRun(
        state.data,
        focus ? `${focus}专项反思` : "项目增量反思",
      );
      run.profile =
        state.runForm.profile.charAt(0).toUpperCase() +
        state.runForm.profile.slice(1);
      run.providerPolicy = String(formData.get("provider") ?? "auto").toUpperCase();
      state.data.runs.unshift(run);
      state.selectedRunId = run.id;
      state.activeView = "runs";
      state.modal = null;
      setQueryView("runs");
      showToast("Evolution Run 已创建", "success");
      window.setTimeout(() => renderShell(state), 0);
      return;
    }

    const scheduleForm = event.target.closest("[data-schedule-form]");
    if (scheduleForm) {
      const formData = new FormData(scheduleForm);
      const existing = state.modal.scheduleId
        ? state.data.schedules.find(
            (item) => item.id === state.modal.scheduleId,
          )
        : null;
      const schedule = existing ?? {
        id: `sch_mock_${Date.now()}`,
        enabled: true,
        lastOutcome: "尚未运行",
      };
      schedule.name = String(formData.get("name") ?? "运行计划");
      schedule.expression = String(formData.get("cadence") ?? "每周一 10:00");
      schedule.timezone = String(formData.get("timezone") ?? "Asia/Shanghai");
      schedule.profile = String(formData.get("profile") ?? "Standard");
      schedule.providerPolicy = String(formData.get("provider") ?? "Auto");
      schedule.range = String(
        formData.get("range") ?? "自上次成功 watermark",
      );
      schedule.nextRunAt = schedule.enabled ? schedule.expression : "已暂停";
      if (!existing) state.data.schedules.unshift(schedule);
      state.modal = null;
      showToast(existing ? "运行计划已更新" : "运行计划已创建", "success");
      window.setTimeout(() => renderShell(state), 0);
    }
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.modal) {
      state.modal = null;
      renderShell(state);
    }
  });
}

function renderLoadError(error) {
  app.innerHTML = "";
  const panel = document.createElement("pre");
  panel.className = "load-error";
  panel.textContent = [
    "无法加载 Evolution 原型数据。",
    "",
    String(error),
    "",
    "请运行：",
    "python3 -m http.server 6188 --directory docs/prototypes/agent-self-evolution-v1",
  ].join("\n");
  app.append(panel);
}

fetch("./mock-state.json")
  .then((response) => {
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return response.json();
  })
  .then((rawData) => {
    const data = applyScenario(rawData, getScenario());
    const state = createState(data);
    renderShell(state);
    bindInteractions(state);
  })
  .catch(renderLoadError);
