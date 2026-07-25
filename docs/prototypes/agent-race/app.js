// Agent Race — 基于 Runweave 现有终端工作区 UI 结构的原型。
// 真实骨架（照现有代码复刻，非臆造）：
//   header(h-8) + [ worktree rail(236px) | 中间(session tab strip + xterm 终端) | 右侧 aside 工具面板 ]
// 现有右侧工具 tab：Preview | Browser | Agent Team。本能力 = 并列新增第 4 个工具 tab「Race」。
// 关键沿用现有模型：worker 的实时终端不在右侧面板里，而是各占一个 worktree（rail 里的一行），
//   在中间终端区显示当前选中 worktree 的终端；右侧 Race 面板只做“观测 + 下发 + 路由注意力”的卡片流，
//   与 Agent Team 面板同构。裁决暂不做。
// 数据来自 mock-state.json，不连真实后端。

const appEl = document.getElementById("app");
const helperEl = document.getElementById("proto-helper");

const state = { project: null, worktrees: [], activeWorktreeId: null, sidecarTool: "race", race: null, diffOpen: false, agentCatalog: {}, draftWorkers: null };

async function boot() {
  const d = await (await fetch("./mock-state.json")).json();
  state.project = d.project; state.worktrees = d.worktrees;
  state.activeWorktreeId = d.activeWorktreeId; state.sidecarTool = d.sidecarTool ?? "race"; state.race = d.race;
  state.agentCatalog = d.agentCatalog ?? {};
  render(); renderHelper();
}

const wt = (id) => state.worktrees.find((w) => w.id === id);
const activeWt = () => wt(state.activeWorktreeId);

// 状态点颜色 —— 严格对齐真实 TerminalTabStateDot：系统只有 starting/idle/running。
// 没有 "waiting/待回答" 这种态：codex 停下提问和干完活，后端都只报 agent_idle，无法区分。
const dotClass = (s) => ({
  running: "bg-cyan-400 rw-pulse",
  starting: "bg-amber-400 rw-pulse",
  idle: "bg-sky-500",
}[s] ?? "bg-slate-600");
const statusText = (s) => ({ running: "进行中", idle: "空闲·待查看", starting: "启动中" }[s] ?? s);

// ============ root: 上(header) + 下(rail | 中间 | 面板) ============
function render() {
  appEl.innerHTML = `
    <section class="flex h-full min-h-0 flex-col overflow-hidden bg-slate-950 text-slate-100">
      ${renderHeader()}
      <div class="flex min-h-0 flex-1">
        ${renderRail()}
        <div class="flex min-w-0 flex-1 flex-col">
          ${renderTabStrip()}
          ${renderStage()}
        </div>
      </div>
    </section>`;
  bindEvents();
}

function renderHeader() {
  return `
    <div class="flex h-8 items-center gap-1.5 border-b border-slate-800 px-2">
      <span class="grid h-5 w-5 place-items-center rounded bg-gradient-to-br from-sky-600 to-sky-800 text-[11px] font-bold text-white">R</span>
      <span class="text-xs font-semibold text-slate-200">Runweave</span>
      <span class="font-mono text-[11px] text-slate-500">${state.project?.name ?? ""}</span>
      <div class="ml-auto flex items-center gap-1 text-slate-400">
        <button class="grid h-6 w-6 place-items-center rounded-md hover:bg-slate-800 hover:text-slate-100" title="Preview">${icon("eye")}</button>
        <button class="grid h-6 w-6 place-items-center rounded-md hover:bg-slate-800 hover:text-slate-100" title="History">${icon("history")}</button>
        <button class="grid h-6 w-6 place-items-center rounded-md hover:bg-slate-800 hover:text-slate-100" title="Activity">${icon("activity")}</button>
      </div>
    </div>`;
}

// ---------- 左 rail：worktree 列表（每个 worker = 一个 worktree 行）----------
function renderRail() {
  const rows = state.worktrees.map((w) => {
    const active = w.id === state.activeWorktreeId;
    return `
      <button data-wt="${w.id}"
        class="group flex min-h-12 w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left ${active ? "border-sky-900/70 bg-slate-900 text-slate-50" : "border-transparent text-slate-300 hover:bg-slate-900/70"}">
        <span class="min-w-0 flex-1">
          <span class="flex items-center gap-1.5">
            <span class="h-1.5 w-1.5 shrink-0 rounded-full ${dotClass(w.aggregateStatus)}"></span>
            <span class="truncate text-xs font-semibold">${escapeHtml(w.role ?? w.name)}</span>
          </span>
          <span class="block truncate text-[10px] ${w.availability === "available" ? "text-slate-500" : "text-amber-400"}">${escapeHtml(w.branch)}</span>
        </span>
        ${w.isPrimary
          ? `<span class="shrink-0 text-sky-400" title="Permanently pinned">${icon("pin")}</span>`
          : `<span class="shrink-0 text-slate-600 opacity-0 group-hover:opacity-100" title="Pin">${icon("pin")}</span>`}
      </button>`;
  }).join("");
  return `
    <aside class="relative flex min-h-0 w-[236px] shrink-0 flex-col border-r border-slate-800 bg-slate-950">
      <div class="flex h-7 items-center justify-between border-b border-slate-800 px-2">
        <span class="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Worktrees ${state.worktrees.length}</span>
        <span class="text-slate-600">${icon("chevron-left")}</span>
      </div>
      <div class="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 py-3">${rows}</div>
      <div class="absolute right-0 top-0 h-full w-2 cursor-col-resize hover:bg-sky-400/40"></div>
    </aside>`;
}

// ---------- 中间：session tab strip ----------
function renderTabStrip() {
  const w = activeWt();
  const tab = w ? `
    <div class="relative flex h-full shrink-0 items-center gap-2 border-r border-slate-800 bg-slate-900/35 pl-2 pr-3 text-slate-50
      before:absolute before:inset-x-0 before:bottom-0 before:h-0.5 before:bg-sky-500">
      <span class="max-w-[220px] truncate text-xs">${escapeHtml(w.sessionName)}</span>
      <span class="h-1.5 w-1.5 rounded-full ${dotClass(w.aggregateStatus)}"></span>
      <span class="text-slate-500 hover:text-slate-200">${icon("x")}</span>
    </div>` : "";
  return `
    <div class="flex h-[26px] items-stretch border-b border-slate-800 bg-slate-950">
      ${tab}
      <button class="flex h-full w-10 items-center justify-center border-r border-slate-800 text-slate-500 hover:bg-slate-900/60 hover:text-slate-200">${icon("plus")}</button>
    </div>`;
}

// ---------- 中间终端舞台 + 右侧面板 ----------
function renderStage() {
  return `
    <div class="relative flex h-full min-h-0">
      <div class="flex min-h-0 flex-1 flex-col">
        ${renderTerminal()}
      </div>
      ${renderSidecar()}
    </div>`;
}

function renderTerminal() {
  const w = activeWt();
  if (!w) return `<div class="flex-1 xterm-bg"></div>`;
  // diff 能否查看取决于真实 git 信号（有改动），与 agent 状态无关。
  const hasChanges = (w.changeSummary?.filesChanged ?? 0) > 0;
  const showDiff = state.diffOpen && hasChanges;
  const body = showDiff ? renderDiffBody(w) : renderTermBody(w);
  // 有改动的 worktree 顶部给切换 toolbar（终端 / Diff），对齐真实 preview/surface 位置。
  const toolbar = hasChanges
    ? `<div class="flex h-8 shrink-0 items-center gap-2 border-b border-slate-800 bg-slate-950 px-2 text-xs text-slate-300">
         <span class="font-mono text-[11px] text-slate-500">${escapeHtml(w.name)}</span>
         <div class="ml-auto inline-flex rounded-md border border-slate-800 bg-slate-900/70 p-0.5">
           <button data-diff="term" class="h-6 rounded-sm px-2 text-xs ${!showDiff ? "bg-slate-700 text-slate-50" : "text-slate-400"}">终端</button>
           <button data-diff="diff" class="h-6 rounded-sm px-2 text-xs ${showDiff ? "bg-slate-700 text-slate-50" : "text-slate-400"}">Diff</button>
         </div>
       </div>` : "";
  // worker（跑着 agent）的终端底部常显输入框：随时可打字——回答提问、补充、纠偏都用同一个入口。
  const inputBar = w.role ? renderTermInput(w) : "";
  return `${toolbar}<div class="relative min-h-0 flex-1 overflow-hidden xterm-bg">${body}</div>${inputBar}`;
}

// 终端下方输入框：就是往该 worktree 的终端打字（sendInputToSession）。
// 不区分“待回答/补充”——系统无法知道 agent 是否在等你，一律给通用输入入口。
function renderTermInput(w) {
  return `
    <div class="shrink-0 border-t border-slate-800 bg-slate-950 px-2 py-1.5">
      <div class="flex items-center gap-1.5">
        <input data-term-input class="h-8 min-w-0 flex-1 rounded-md border border-slate-800 bg-slate-950 px-2 text-[12px] text-slate-100 focus:border-sky-600 focus:outline-none" placeholder="发送到该终端…（回答 / 补充 / 纠偏）" />
        <button data-term-send class="grid h-8 w-8 place-items-center rounded-md bg-sky-600 text-white hover:bg-sky-500">${icon("play")}</button>
      </div>
    </div>`;
}

function renderTermBody(w) {
  const lines = (w.terminalLines ?? []).map(termLine).join("\n");
  const live = w.aggregateStatus === "running" || w.aggregateStatus === "starting";
  return `<pre class="term h-full w-full overflow-y-auto px-3 pt-1.5 pb-1.5 text-[13px] leading-[1.5] text-slate-200 whitespace-pre-wrap break-words">${lines}\n<span class="rw-pulse text-slate-300">▋</span></pre>`;
}
function termLine(l) {
  // 只用 codex 终端真实会有的样式：命令行 / 普通输出 / 错误。不假造“系统识别的提问”高亮。
  const cls = { cmd: "text-cyan-300", out: "text-slate-400", err: "text-rose-400" }[l.kind] ?? "text-slate-300";
  const prefix = l.kind === "cmd" ? "<span class='text-emerald-400'>$ </span>" : "";
  return `<span class="${cls}">${prefix}${escapeHtml(l.text)}</span>`;
}
function renderDiffBody(w) {
  return `<div class="h-full overflow-y-auto px-3 py-2 text-[12px]">
      <div class="mb-2 font-mono text-[11px] text-slate-500">${w.changeSummary.filesChanged} files · <span class="text-emerald-400">+${w.changeSummary.insertions}</span> <span class="text-rose-400">−${w.changeSummary.deletions}</span></div>
      <pre class="term whitespace-pre text-[12px] leading-[1.5] text-slate-300">${diffSample()}</pre>
    </div>`;
}
function diffSample() {
  return [
    `<span class="text-sky-400">@@ AuthGuard 过期兜底 @@</span>`,
    `<span class="text-rose-400">-  if (!token) return &lt;Navigate to="/login" /&gt;;</span>`,
    `<span class="text-emerald-400">+  if (!token || isExpired(token)) {</span>`,
    `<span class="text-emerald-400">+    return &lt;Navigate to="/login" replace /&gt;;</span>`,
    `<span class="text-emerald-400">+  }</span>`,
    `<span class="text-emerald-400">+  useHttp401Redirect();</span>`,
  ].join("\n");
}

// ============ 右侧 sidecar：工具 tab（Preview | Browser | Agent Team | Race）============
function renderSidecar() {
  const tools = [["preview", "Preview"], ["browser", "Browser"], ["agent-team", "Agent Team"], ["race", "Race"]];
  const tabs = tools.map(([id, label]) => `
    <button data-tool="${id}" role="tab" aria-selected="${state.sidecarTool === id}"
      class="h-6 rounded-sm px-2 text-xs ${state.sidecarTool === id ? "bg-slate-700 text-slate-50" : "text-slate-400 hover:text-slate-100"}">${label}</button>`).join("");
  return `
    <aside class="relative flex h-full min-h-0 w-[340px] shrink-0 border-l border-slate-800 bg-slate-950">
      <div class="flex min-w-0 flex-1 flex-col">
        <header class="border-b border-slate-800 px-2 py-1.5">
          <div class="flex min-h-[34px] items-center gap-2">
            <div class="inline-flex rounded-md border border-slate-800 bg-slate-900/70 p-0.5" role="tablist">${tabs}</div>
            <div class="ml-auto flex shrink-0 items-center gap-1 text-slate-400">
              <button class="grid h-7 w-7 place-items-center rounded-md hover:bg-slate-800 hover:text-slate-100">${icon("maximize")}</button>
              <button class="grid h-7 w-7 place-items-center rounded-md hover:bg-slate-800 hover:text-slate-100">${icon("x")}</button>
            </div>
          </div>
        </header>
        <div class="min-h-0 flex-1 overflow-y-auto">${state.sidecarTool === "race" ? renderRacePanel() : renderOtherToolPlaceholder()}</div>
      </div>
    </aside>`;
}

function renderOtherToolPlaceholder() {
  const name = { preview: "Preview", browser: "Browser", "agent-team": "Agent Team" }[state.sidecarTool];
  return `<div class="p-3 text-[12px] leading-relaxed text-slate-500">${name}：现有工具，原型不重绘。<br>点上方 <span class="text-slate-300">Race</span> 看本能力。</div>`;
}

// Race 面板：与 Agent Team 面板同构（Header 状态徽标 → 主体卡片流）
function renderRacePanel() {
  const r = state.race;
  if (!r) return renderRaceStart();
  const runningCount = r.workers.filter((w) => w.status === "running").length;
  const idleCount = r.workers.filter((w) => w.status === "idle").length;
  const allIdle = runningCount === 0;
  return `
    <div class="flex h-full min-h-0 flex-col text-slate-200">
      <div class="border-b border-slate-800 px-3 py-2">
        <div class="flex items-center justify-between">
          <span class="text-xs font-medium text-slate-300">Race</span>
          <span class="rounded px-1.5 py-0.5 text-[10px] uppercase ${allIdle ? "bg-slate-700 text-slate-300" : "bg-emerald-500/15 text-emerald-300"}">${allIdle ? "idle" : "running"}</span>
        </div>
        <div class="mt-0.5 font-mono text-[10px] text-slate-500">主 Agent · ${r.workers.length} workers · 各自 worktree 同一目标</div>
      </div>
      <div class="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        ${idleCount ? `<div class="rounded border border-slate-700 bg-slate-900/60 px-2 py-1.5 text-[11px] text-slate-400">${idleCount} 个 worker 已空闲——进各自终端确认是完成还是在等待输入。</div>` : ""}
        <div>
          <div class="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">目标</div>
          <div class="rounded border border-slate-800 bg-slate-900/60 px-2 py-1.5 text-[11px] leading-relaxed text-slate-300">${escapeHtml(r.goal)}</div>
        </div>
        <div>
          <div class="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Workers</div>
          <div class="space-y-1.5">${r.workers.map(renderWorkerCard).join("")}</div>
        </div>
        <div>
          <div class="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Loop 日志</div>
          <pre class="term rounded border border-slate-800 bg-slate-900/40 p-2 text-[10px] leading-relaxed text-slate-400 whitespace-pre-wrap">${r.log.map((l) => "· " + escapeHtml(l.text)).join("\n")}</pre>
        </div>
        <button data-tool-start="1" class="flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-slate-700 text-[12px] text-slate-300 hover:bg-slate-900">${icon("plus")} 新的 Race 目标</button>
      </div>
    </div>`;
}

// worker 卡：对齐 Agent Team 的验收/worker 行卡片；点击 = 聚焦到它的 worktree 终端（现有交互模型）
function renderWorkerCard(w) {
  const active = w.worktreeId === state.activeWorktreeId;
  const c = w.changeSummary;
  return `
    <button data-focus-wt="${w.worktreeId}"
      class="flex w-full items-center gap-2 rounded border px-2 py-1.5 text-left ${active ? "border-sky-700 bg-sky-950/30" : "border-slate-800 bg-slate-900/60 hover:border-slate-700"}">
      <span class="h-1.5 w-1.5 shrink-0 rounded-full ${dotClass(w.status)}"></span>
      <span class="min-w-0 flex-1">
        <span class="block truncate text-[11px] font-semibold text-slate-200">${escapeHtml(w.label)}</span>
        <span class="block truncate font-mono text-[9px]"><span class="text-sky-400">${escapeHtml(w.agent ?? "codex")}</span><span class="text-slate-500"> · ${escapeHtml(w.model ?? "default")}</span></span>
      </span>
      <span class="shrink-0 text-right">
        <span class="block text-[9px] uppercase ${w.status === "running" ? "text-cyan-300" : w.status === "starting" ? "text-amber-300" : "text-sky-300"}">${statusText(w.status)}</span>
        <span class="block font-mono text-[9px] text-slate-500"><span class="text-emerald-400">+${c.insertions}</span> <span class="text-rose-400">−${c.deletions}</span></span>
      </span>
    </button>`;
}

function agentIds() { return Object.keys(state.agentCatalog); }
function modelsFor(agent) { return state.agentCatalog[agent]?.models ?? []; }
function defaultDraft() {
  const a = agentIds()[0] ?? "codex";
  return [
    { agent: "codex", model: modelsFor("codex")[0] ?? "" },
    { agent: "traex", model: modelsFor("traex")[0] ?? "" },
    { agent: "traex", model: modelsFor("traex")[1] ?? "" },
  ];
}

function renderRaceStart() {
  if (!state.draftWorkers) state.draftWorkers = defaultDraft();
  const rows = state.draftWorkers.map(renderDraftRow).join("");
  return `
    <div class="space-y-3 p-3">
      <div class="text-[11px] leading-relaxed text-slate-400">下发一个目标，主 Agent 为每个 worker 建独立 worktree 并行做同一目标。每个 worker 可各自选协议与模型——多样性正是 Race 的价值。</div>
      <div class="space-y-1"><label class="text-[10px] uppercase tracking-wide text-slate-500">目标</label>
        <input id="c-goal" class="h-8 w-full rounded border border-slate-800 bg-slate-950 px-2 text-[12px] text-slate-100 focus:border-sky-600 focus:outline-none" placeholder="修复登录页 token 过期后白屏" /></div>
      <div class="space-y-1"><label class="text-[10px] uppercase tracking-wide text-slate-500">任务计划 / prompt</label>
        <textarea id="c-plan" class="min-h-16 w-full resize-y rounded border border-slate-800 bg-slate-950 px-2 py-1.5 text-[12px] leading-relaxed text-slate-100 focus:border-sky-600 focus:outline-none" placeholder="主 Agent 会把它下发给每个 worker…"></textarea></div>
      <div class="space-y-1.5">
        <div class="flex items-center justify-between">
          <label class="text-[10px] uppercase tracking-wide text-slate-500">Workers (${state.draftWorkers.length})</label>
          <button data-draft-add class="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-slate-400 hover:bg-slate-800 hover:text-slate-100">${icon("plus")} 加 worker</button>
        </div>
        <div class="space-y-1.5">${rows}</div>
      </div>
      <button id="c-dispatch" class="flex h-9 w-full items-center justify-center gap-1.5 rounded-md bg-sky-600 text-[13px] font-semibold text-white hover:bg-sky-500">${icon("play")} 下发给主 Agent</button>
    </div>`;
}

// 单行 worker 草稿：worker 名 + agent 下拉 + 该 agent 的真实模型下拉 + 删除
function renderDraftRow(row, i) {
  const label = `worker ${String.fromCharCode(65 + i)}`;
  const agentOpts = agentIds().map((a) => `<option value="${a}" ${row.agent === a ? "selected" : ""}>${a}</option>`).join("");
  const cat = state.agentCatalog[row.agent];
  const modelOpts = (cat?.models ?? []).map((m) => `<option value="${m}" ${row.model === m ? "selected" : ""}>${m}</option>`).join("");
  const customOpt = cat?.custom ? `<option value="__custom__" ${row.model && !(cat?.models ?? []).includes(row.model) ? "selected" : ""}>自定义…</option>` : "";
  const removable = state.draftWorkers.length > 1;
  return `
    <div class="flex items-center gap-1.5 rounded border border-slate-800 bg-slate-900/60 px-2 py-1.5">
      <span class="w-14 shrink-0 truncate text-[10px] font-semibold text-slate-300">${label}</span>
      <select data-draft-agent="${i}" class="h-7 w-[74px] shrink-0 rounded border border-slate-800 bg-slate-950 px-1 text-[11px] text-slate-100 focus:border-sky-600 focus:outline-none">${agentOpts}</select>
      <select data-draft-model="${i}" class="h-7 min-w-0 flex-1 rounded border border-slate-800 bg-slate-950 px-1 text-[11px] text-slate-100 focus:border-sky-600 focus:outline-none">${modelOpts}${customOpt}</select>
      ${removable ? `<button data-draft-remove="${i}" class="grid h-7 w-6 shrink-0 place-items-center rounded text-slate-500 hover:text-rose-400" title="移除">${icon("x")}</button>` : ""}
    </div>`;
}

// ---------- actions ----------
// 每个 worker 用自己的 agent + model 拼真实启动命令：codex 用 -m，traex 用 -c model=
function launchCmd(agent, model, goal) {
  if (!model) return `${agent} ${JSON.stringify(goal)}`;
  return agent === "codex"
    ? `codex -m ${model} ${JSON.stringify(goal)}`
    : `traex -c model=${JSON.stringify(model)} ${JSON.stringify(goal)}`;
}

function dispatch() {
  syncDraftFromDOM();
  const goal = document.querySelector("#c-goal").value.trim() || "未命名目标";
  const plan = document.querySelector("#c-plan").value.trim() || goal;
  const draft = state.draftWorkers ?? defaultDraft();
  const newWts = []; const workers = [];
  draft.forEach((row, i) => {
    const id = String.fromCharCode(97 + i);
    const wtId = `wt_${id}_${Math.random().toString(16).slice(2, 5)}`;
    const agent = row.agent, model = row.model;
    newWts.push({
      id: wtId, name: `race-${slug(goal)}-${id}`, branch: `race/${slug(goal)}-${id}`,
      isPrimary: false, availability: "available", aggregateStatus: "running", role: `worker ${id.toUpperCase()}`,
      agent, model, sessionName: `worker ${id.toUpperCase()} · ${agent}`,
      changeSummary: { filesChanged: 0, insertions: 0, deletions: 0 },
      terminalLines: [{ kind: "cmd", text: launchCmd(agent, model, goal) }, { kind: "out", text: "· 创建 worktree，启动…" }],
    });
    workers.push({ workerId: `worker_${id}`, label: `worker ${id.toUpperCase()}`, worktreeId: wtId, agent, model, status: "running", changeSummary: { filesChanged: 0, insertions: 0, deletions: 0 } });
  });
  state.worktrees = [state.worktrees.find((w) => w.isPrimary), ...newWts].filter(Boolean);
  state.activeWorktreeId = newWts[0].id;
  state.race = { goal, plan, status: "running", mainWorktreeId: state.worktrees[0].id, workers, log: [{ text: `主 Agent 下发目标给 ${draft.length} 个 worker（各自 agent + 模型）` }] };
  state.draftWorkers = null;
  render();
}

function sendToActive() {
  const w = activeWt(); if (!w) return;
  const box = appEl.querySelector("[data-term-input]");
  const text = (box?.value || "").trim(); if (!text) return;
  w.terminalLines = w.terminalLines ?? [];
  w.terminalLines.push({ kind: "cmd", text });
  // 往终端发了输入，agent 恢复活动（idle → running），这是真实行为，不需区分它之前是否在“等回答”。
  w.aggregateStatus = "running";
  w.terminalLines.push({ kind: "out", text: "· 收到，继续执行…" });
  const worker = state.race?.workers.find((x) => x.worktreeId === w.id);
  if (worker) worker.status = "running";
  render();
}

function bindEvents() {
  appEl.querySelectorAll("[data-wt]").forEach((el) => el.addEventListener("click", () => { state.activeWorktreeId = el.dataset.wt; state.diffOpen = false; render(); }));
  appEl.querySelectorAll("[data-tool]").forEach((el) => el.addEventListener("click", () => { state.sidecarTool = el.dataset.tool; render(); }));
  appEl.querySelectorAll("[data-focus-wt]").forEach((el) => el.addEventListener("click", () => { state.activeWorktreeId = el.dataset.focusWt; state.diffOpen = false; render(); }));
  appEl.querySelectorAll("[data-diff]").forEach((el) => el.addEventListener("click", () => { state.diffOpen = el.dataset.diff === "diff"; render(); }));
  appEl.querySelector("#c-dispatch")?.addEventListener("click", dispatch);
  appEl.querySelector("[data-tool-start]")?.addEventListener("click", () => { state.race = null; state.draftWorkers = null; render(); });
  // draft worker 行：先把 DOM 现值同步回 state，再改，避免 render 丢未提交改动
  appEl.querySelectorAll("[data-draft-agent]").forEach((el) => el.addEventListener("change", () => {
    syncDraftFromDOM(); const i = Number(el.dataset.draftAgent);
    state.draftWorkers[i].agent = el.value;
    state.draftWorkers[i].model = modelsFor(el.value)[0] ?? ""; // 换 agent 重置为该 agent 首个真实模型
    render();
  }));
  appEl.querySelectorAll("[data-draft-model]").forEach((el) => el.addEventListener("change", () => {
    syncDraftFromDOM(); const i = Number(el.dataset.draftModel);
    if (el.value === "__custom__") {
      const v = prompt("自定义模型名（传给该 agent 的 -m / -c model=）", state.draftWorkers[i].model || "");
      if (v && v.trim()) state.draftWorkers[i].model = v.trim();
    } else {
      state.draftWorkers[i].model = el.value;
    }
    render();
  }));
  appEl.querySelector("[data-draft-add]")?.addEventListener("click", () => {
    syncDraftFromDOM(); const a = agentIds()[0] ?? "codex";
    state.draftWorkers.push({ agent: a, model: modelsFor(a)[0] ?? "" });
    render();
  });
  appEl.querySelectorAll("[data-draft-remove]").forEach((el) => el.addEventListener("click", () => {
    syncDraftFromDOM(); state.draftWorkers.splice(Number(el.dataset.draftRemove), 1); render();
  }));
  const ti = appEl.querySelector("[data-term-input]");
  ti?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); sendToActive(); } });
  appEl.querySelector("[data-term-send]")?.addEventListener("click", sendToActive);
}

// 把 composer 里各行 select 的当前值读回 state.draftWorkers（含 goal/plan 不动）
function syncDraftFromDOM() {
  if (!state.draftWorkers) return;
  appEl.querySelectorAll("[data-draft-agent]").forEach((el) => {
    const i = Number(el.dataset.draftAgent); if (state.draftWorkers[i]) state.draftWorkers[i].agent = el.value;
  });
  appEl.querySelectorAll("[data-draft-model]").forEach((el) => {
    const i = Number(el.dataset.draftModel);
    if (state.draftWorkers[i] && el.value !== "__custom__") state.draftWorkers[i].model = el.value;
  });
}

// ---------- helpers ----------
const slug = (s) => s.toLowerCase().replace(/[^\w\u4e00-\u9fa5]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 18) || "task";
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// 极简 lucide 风格图标（stroke 1.75，对齐 lucide-react 视觉）
function icon(name) {
  const p = {
    "eye": '<circle cx="12" cy="12" r="3"/><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/>',
    "history": '<path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/>',
    "activity": '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    "pin": '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
    "chevron-left": '<path d="m15 18-6-6 6-6"/>',
    "x": '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    "plus": '<path d="M5 12h14"/><path d="M12 5v14"/>',
    "maximize": '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
    "play": '<polygon points="6 3 20 12 6 21 6 3"/>',
  }[name] ?? "";
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
}

function renderHelper() {
  if (new URLSearchParams(location.search).get("helper") !== "1") return;
  helperEl.className = "fixed bottom-3 right-[352px] z-40 flex items-center gap-2 rounded-full border border-slate-700 bg-slate-950 px-3 py-1.5 text-[11px] text-slate-400";
  helperEl.innerHTML = `原型辅助 · <button id="h-reset" class="text-emerald-400 underline">重载</button>`;
  helperEl.querySelector("#h-reset").addEventListener("click", () => location.reload());
}

boot();
