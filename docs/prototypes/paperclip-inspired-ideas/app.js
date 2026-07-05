/* global document, fetch, window */

import React, { useEffect, useMemo, useState } from "https://esm.sh/react@18.3.1";
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client";
import htm from "https://esm.sh/htm@3.1.1";

const html = htm.bind(React.createElement);

// React needs `style` as an object; parse inline CSS strings into style objects
// so the prototype can keep readable CSS strings at call sites.
function css(str) {
  const out = {};
  String(str)
    .split(";")
    .forEach((decl) => {
      const idx = decl.indexOf(":");
      if (idx === -1) return;
      const prop = decl.slice(0, idx).trim();
      const value = decl.slice(idx + 1).trim();
      if (!prop) return;
      const jsProp = prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      out[jsProp] = value;
    });
  return out;
}

// 5 borrowable ideas. Each maps a Paperclip control-plane concept onto Runweave's
// real multi-terminal / multi-backend model.
const IDEAS = [
  {
    id: "fleet",
    title: "Fleet Overview",
    sub: "跨 backend 的终端总览墙",
    paperclip: "Paperclip Dashboard / Org Chart",
    why: "Runweave 现在每个 backend、每个项目下的终端是分开的 tab，开了十几个 agent 终端后无法一眼看清「谁在跑、谁卡住、谁在等我」。借鉴 Paperclip 的任务面板：把所有 backend × 项目 × 终端聚合成一面状态墙，按「需要关注」排序，点卡片深链回具体终端。",
  },
  {
    id: "budget",
    title: "Cost & Budget",
    sub: "按项目/agent 的 token 花费与硬停",
    paperclip: "Paperclip Budget & Cost Control",
    why: "Runweave 只有 CPU/内存 badge，没有 token 成本视角。借鉴 Paperclip 的预算硬停：按项目、按 agent 统计 token 花费，设月度上限，接近阈值告警、超限自动暂停该项目下的 agent 终端，避免 runaway loop 烧钱。",
  },
  {
    id: "routines",
    title: "Scheduled Routines",
    sub: "定时 / 事件唤醒的重复任务",
    paperclip: "Paperclip Routines & Heartbeats",
    why: "重复性工作（每日 lint 巡检、延迟基线报告、CI 失败自动修）现在都要手动开终端敲命令。借鉴 Paperclip 的 heartbeat：给项目挂 cron / webhook 触发的例行任务，到点自动开一个终端、跑指定 agent、留下结果，不用人肉 kick-off。",
  },
  {
    id: "approvals",
    title: "Approval Gate",
    sub: "高危操作的人工批准门",
    paperclip: "Paperclip Governance & Approvals",
    why: "AGENTS.md 明令禁止 --force、mac-only 打包等硬约束，但现在全靠 agent 自觉。借鉴 Paperclip 的审批门：把高危动作（force push、rm -rf、重装依赖）拦成待批准队列，人一键批准/驳回，驳回带理由注入回 agent 上下文。",
  },
  {
    id: "activity",
    title: "Activity Timeline",
    sub: "跨终端的统一活动流与审计",
    paperclip: "Paperclip Activity & Events",
    why: "每个终端的输出是孤立的滚动流，事后无法回溯「14:25 到底哪个 agent 干了什么、花了多少、卡在哪」。借鉴 Paperclip 的 activity log：把工具调用、成本、完成、审批、阻塞事件汇成一条带时间戳、可按终端/类型过滤的统一时间线。",
  },
];

const STATUS_LABEL = {
  running: "运行中",
  waiting_input: "等待输入",
  blocked: "已阻塞",
  done: "已完成",
  idle: "空闲",
};
const STATUS_DOT = {
  running: "green",
  waiting_input: "amber",
  blocked: "danger",
  done: "cyan",
  idle: "dim",
};
// terminals needing human attention rank first
const ATTENTION_RANK = { blocked: 0, waiting_input: 1, running: 2, done: 3, idle: 4 };

function fmtUsd(n) {
  return `$${n.toFixed(1)}`;
}
function fmtAgo(sec) {
  if (sec < 60) return `${sec}s 前`;
  if (sec < 3600) return `${Math.round(sec / 60)}m 前`;
  return `${Math.round(sec / 3600)}h 前`;
}
function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function AgentBadge({ agent }) {
  return html`<span class=${`agent-badge agent-${agent}`}>${agent}</span>`;
}

// ---------------- Idea 1: Fleet Overview ----------------
function FleetView({ state, notify }) {
  const [filter, setFilter] = useState("all");
  const terminals = state.fleet.terminals;

  const counts = useMemo(() => {
    const c = { blocked: 0, waiting_input: 0, running: 0 };
    terminals.forEach((t) => {
      if (t.status in c) c[t.status] += 1;
    });
    return c;
  }, [terminals]);

  const projectName = (id) => state.projects.find((p) => p.id === id)?.label ?? id;
  const backendName = (id) => state.backends.find((b) => b.id === id)?.label ?? id;

  const visible = useMemo(() => {
    const list = filter === "all" ? terminals : terminals.filter((t) => t.status === filter);
    return [...list].sort((a, b) => ATTENTION_RANK[a.status] - ATTENTION_RANK[b.status]);
  }, [terminals, filter]);

  return html`
    <div>
      <div class="attention-strip">
        <div class="attn hot">
          <div class="n status-blocked">${counts.blocked}</div>
          <div class="l">阻塞 · 需要你介入</div>
        </div>
        <div class="attn warn">
          <div class="n status-waiting_input">${counts.waiting_input}</div>
          <div class="l">等待输入</div>
        </div>
        <div class="attn">
          <div class="n status-running">${counts.running}</div>
          <div class="l">自主运行中</div>
        </div>
        <div class="attn">
          <div class="n">${terminals.length}</div>
          <div class="l">终端总数 · ${state.backends.length} 个 backend</div>
        </div>
      </div>

      <div class="fleet-toolbar">
        <div class="seg">
          ${["all", "blocked", "waiting_input", "running", "done", "idle"].map(
            (f) => html`<button
              key=${f}
              class=${filter === f ? "active" : ""}
              onClick=${() => setFilter(f)}
            >
              ${f === "all" ? "全部" : STATUS_LABEL[f]}
            </button>`,
          )}
        </div>
      </div>

      <div class="grid grid-3">
        ${visible.map(
          (t) => html`
            <div
              key=${t.id}
              class="card fleet-card"
              onClick=${() => notify(`深链跳转 → ${backendName(t.backendId)} / ${t.name}`)}
            >
              <div class="row between">
                <div class="row" style=${css("gap:7px")}>
                  <span class=${`dot ${STATUS_DOT[t.status]}`}></span>
                  <span class=${`status-${t.status}`} style=${css("font-weight:600")}>${STATUS_LABEL[t.status]}</span>
                  ${t.aiMarker &&
                  html`<span class="chip" style=${css("border-color:var(--green);color:var(--green)")}
                    >AI ●</span
                  >`}
                </div>
                <${AgentBadge} agent=${t.agent} />
              </div>
              <div class="task">${t.task}</div>
              ${t.status === "blocked" &&
              html`<div class="chip" style=${css("border-color:var(--danger);color:var(--danger);align-self:flex-start")}
                >⚠ ${t.blockedReason}</div
              >`}
              <div class="row between">
                <span class="dim mono" style=${css("font-size:11px")}>${projectName(t.projectId)} · ${backendName(t.backendId)}</span>
              </div>
              <div class="metrics">
                <span>CPU ${t.cpuPercent}%</span>
                <span>${t.memoryMb}MB</span>
                <span>round ${t.round}</span>
                <span>diff ${t.diffFiles}</span>
                <span>${fmtAgo(t.lastActivitySec)}</span>
              </div>
            </div>
          `,
        )}
      </div>

      <div class="note-box">
        <b>真实映射：</b> 数据源来自各 backend 的 <code>terminal</code> 会话 + <code
          >runtime-monitor</code
        > 的 CPU/内存快照 + AI 完成绿点（<code>TerminalCompletionEvent</code>）。原型里的「深链跳转」对应切 backend + 选中终端 tab。<b>缺口：</b> 目前没有跨 backend 聚合层，多后端状态需要一个汇总 WebSocket/轮询。
      </div>
    </div>
  `;
}

// ---------------- Idea 2: Cost & Budget ----------------
function BudgetView({ state, notify }) {
  const { budget } = state;
  return html`
    <div>
      <div class="grid grid-3">
        ${budget.scopes.map((s) => {
          const pct = Math.min(100, Math.round((s.usd / s.hardCapUsd) * 100));
          return html`
            <div key=${s.id} class="card">
              <div class="row between">
                <span style=${css("font-weight:600")}>${s.label}</span>
                <span class=${`chip`} style=${css(s.state === "stopped"
                  ? "border-color:var(--danger);color:var(--danger)"
                  : s.state === "warn"
                    ? "border-color:var(--amber);color:var(--amber)"
                    : "border-color:var(--green);color:var(--green)")}
                  >${s.state === "stopped" ? "已硬停" : s.state === "warn" ? "接近上限" : "正常"}</span
                >
              </div>
              <div class="budget-usd" style=${css("margin:12px 0 2px")}>${fmtUsd(s.usd)}
                <span class="dim" style=${css("font-size:13px;font-weight:400")}> / ${fmtUsd(s.hardCapUsd)}</span>
              </div>
              <div class="dim" style=${css("font-size:11px;margin-bottom:10px")}>${budget.windowLabel} · ${pct}%</div>
              <div class="bar"><i class=${s.state} style=${css(`width:${pct}%`)}></i></div>
              <div class="metrics" style=${css("display:flex;gap:14px;margin-top:12px;font-size:11px;color:var(--dim)")}>
                <span>in ${fmtTokens(s.tokensIn)}</span>
                <span>out ${fmtTokens(s.tokensOut)}</span>
                <span>${s.topModel}</span>
              </div>
              ${s.state === "stopped" &&
              html`<button class="btn danger sm" style=${css("margin-top:12px;width:100%")}
                onClick=${() => notify(`已解除 ${s.label} 的硬停并 +$20 临时额度（模拟）`)}
                >⏸ 已暂停该项目 agent · 点此提额恢复</button
              >`}
              ${s.state === "warn" &&
              html`<button class="btn ghost sm" style=${css("margin-top:12px;width:100%")}
                onClick=${() => notify(`已给 ${s.label} 提高预算上限（模拟）`)}
                >调高上限</button
              >`}
            </div>
          `;
        })}
      </div>

      <div class="section-title">按 agent 拆分（本月累计）</div>
      <div class="card">
        <div class="split-bar">
          ${budget.agents.map(
            (a) => html`<span
              key=${a.id}
              class=${`agent-${a.label}`}
              style=${css(`width:${a.share * 100}%;background:${
                a.label === "codex"
                  ? "var(--cyan)"
                  : a.label === "claude"
                    ? "#fdba74"
                    : a.label === "coco"
                      ? "var(--violet)"
                      : "var(--dim)"
              }`)}
              title=${`${a.label} ${fmtUsd(a.usd)}`}
            ></span>`,
          )}
        </div>
        <div class="row" style=${css("gap:18px;margin-top:12px;flex-wrap:wrap")}>
          ${budget.agents.map(
            (a) => html`<div key=${a.id} class="row" style=${css("gap:7px")}>
              <${AgentBadge} agent=${a.label} />
              <span class="mono">${fmtUsd(a.usd)}</span>
              <span class="dim">${Math.round(a.share * 100)}%</span>
            </div>`,
          )}
        </div>
      </div>

      <div class="note-box">
        <b>真实映射：</b> Runweave 现有 <code>runtime-monitor</code> 已经在采 CPU/内存，这里叠加一层「每回合 token/成本」采样（agent 完成事件里带用量）。<b>缺口：</b> 需要在 <code>TerminalCompletionEvent</code> 或 hook bridge 里回传 token 用量，并加一个预算存储 + 超限时向该终端发暂停信号。
      </div>
    </div>
  `;
}

// ---------------- Idea 3: Scheduled Routines ----------------
function RoutinesView({ state, notify }) {
  const [routines, setRoutines] = useState(state.routines);
  const projectName = (id) => state.projects.find((p) => p.id === id)?.label ?? id;

  const toggle = (id) => {
    setRoutines((rs) =>
      rs.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)),
    );
    const r = routines.find((x) => x.id === id);
    notify(`${r.enabled ? "已停用" : "已启用"}例行任务：${r.name}`);
  };

  return html`
    <div>
      <div class="row between" style=${css("margin-bottom:14px")}>
        <span class="muted">项目挂载的定时 / 事件触发任务</span>
        <button class="btn primary sm" onClick=${() => notify("打开「新建例行任务」表单（模拟）")}>
          + 新建例行任务
        </button>
      </div>
      <div class="card" style=${css("padding:0")}>
        <table>
          <thead>
            <tr>
              <th>任务</th><th>项目</th><th>Agent</th><th>触发</th>
              <th>上次</th><th>下次</th><th style=${css("text-align:right")}>启用</th>
            </tr>
          </thead>
          <tbody>
            ${routines.map(
              (r) => html`
                <tr key=${r.id} class="clickable">
                  <td>
                    <div style=${css("font-weight:600")}>${r.name}</div>
                    <div class="dim" style=${css("font-size:11px;margin-top:3px")}>${r.note}</div>
                  </td>
                  <td class="muted">${projectName(r.projectId)}</td>
                  <td><${AgentBadge} agent=${r.agent} /></td>
                  <td>
                    <span class="chip">${r.trigger === "cron" ? "⏰ cron" : "🔗 webhook"}</span>
                    <div class="dim" style=${css("font-size:11px;margin-top:4px")}>${r.schedule}</div>
                  </td>
                  <td>
                    <span class="row" style=${css("gap:6px")}>
                      <span class=${`dot ${r.lastResult === "ok" ? "green" : r.lastResult === "skipped" ? "dim" : "danger"}`}></span>
                      <span class="muted">${r.lastRun}</span>
                    </span>
                  </td>
                  <td class="dim mono" style=${css("font-size:11px")}>${r.nextRun}</td>
                  <td style=${css("text-align:right")}>
                    <button
                      class=${`toggle ${r.enabled ? "on" : ""}`}
                      onClick=${() => toggle(r.id)}
                      aria-label="toggle"
                    ><i></i></button>
                  </td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
      <div class="note-box">
        <b>真实映射：</b> 每个例行任务到点/触发时，等价于自动 <code>rw</code> 新开一个终端、注入指定 agent 与命令、跑完记录结果。cron 用本地调度，webhook 对接 CI 事件。<b>缺口：</b> Runweave 无调度器与「无人值守自动开终端」的语义，需要 backend 侧常驻调度 + 终端自动创建 API。
      </div>
    </div>
  `;
}

// ---------------- Idea 4: Approval Gate ----------------
function ApprovalsView({ state, notify }) {
  const [items, setItems] = useState(state.approvals);
  const termName = (id) => state.fleet.terminals.find((t) => t.id === id)?.name ?? id;

  const decide = (id, ok) => {
    setItems((xs) => xs.map((x) => (x.id === id ? { ...x, state: ok ? "approved" : "rejected" } : x)));
    const it = items.find((x) => x.id === id);
    notify(ok ? `已批准：${it.action}` : `已驳回并把理由注入回 ${it.agent} 上下文`);
  };

  const pending = items.filter((x) => x.state === "pending");
  const resolved = items.filter((x) => x.state !== "pending");

  return html`
    <div>
      <div class="row between" style=${css("margin-bottom:14px")}>
        <span class="muted">高危动作在执行前被拦截，等待人工放行</span>
        <span class="chip" style=${css("border-color:var(--violet);color:var(--violet)")}>${pending.length} 个待批准</span>
      </div>

      ${pending.length === 0
        ? html`<div class="card empty">没有待批准的操作 🎉</div>`
        : pending.map(
            (a) => html`
              <div key=${a.id} class="card" style=${css("margin-bottom:12px")}>
                <div class="row between">
                  <div class="row" style=${css("gap:8px")}>
                    <span class=${`chip risk-${a.risk}`} style=${css(`border-color:currentColor`)}
                      >${a.risk === "high" ? "高危" : a.risk === "medium" ? "中危" : "低危"}</span
                    >
                    <${AgentBadge} agent=${a.agent} />
                    <span class="dim">${termName(a.terminalId)}</span>
                  </div>
                  <span class="dim mono" style=${css("font-size:11px")}>${fmtAgo(a.requestedSec)}请求</span>
                </div>
                <div class="mono" style=${css("margin:12px 0 8px;padding:10px 12px;background:var(--surface);border-radius:6px;border:1px solid var(--line);font-size:12.5px;color:var(--text)")}>
                  $ ${a.action}
                </div>
                <div class="muted" style=${css("font-size:12px")}>${a.reason}</div>
                <div class="dim" style=${css("font-size:11px;margin-top:4px")}>影响：${a.diffSummary}</div>
                <div class="row" style=${css("gap:8px;margin-top:14px")}>
                  <button class="btn primary sm" onClick=${() => decide(a.id, true)}>批准执行</button>
                  <button class="btn danger sm" onClick=${() => decide(a.id, false)}>驳回并说明</button>
                </div>
              </div>
            `,
          )}

      ${resolved.length > 0 &&
      html`
        <div class="section-title">历史</div>
        <div class="card" style=${css("padding:0")}>
          <table>
            <tbody>
              ${resolved.map(
                (a) => html`<tr key=${a.id}>
                  <td style=${css("width:90px")}>
                    <span class="chip" style=${css(a.state === "approved"
                      ? "border-color:var(--green);color:var(--green)"
                      : "border-color:var(--danger);color:var(--danger)")}
                      >${a.state === "approved" ? "已批准" : "已驳回"}</span
                    >
                  </td>
                  <td class="mono" style=${css("font-size:12px")}>${a.action}</td>
                  <td class="dim" style=${css("text-align:right")}>${termName(a.terminalId)}</td>
                </tr>`,
              )}
            </tbody>
          </table>
        </div>
      `}

      <div class="note-box">
        <b>真实映射：</b> AGENTS.md 的硬约束（禁 <code>--force</code>、mac-only 打包、surgical changes）可以从「口头规则」升级成「执行前拦截」。agent 要跑高危命令时先写进审批队列，人在此放行/驳回，驳回理由注入回 agent 上下文。<b>缺口：</b> 需要在终端/hook 层识别高危命令模式并挂起，以及一条把决定回灌给 agent 的通道。
      </div>
    </div>
  `;
}

// ---------------- Idea 5: Activity Timeline ----------------
function ActivityView({ state }) {
  const [kind, setKind] = useState("all");
  const termName = (id) => state.fleet.terminals.find((t) => t.id === id)?.name ?? id;
  const kinds = ["all", "tool", "cost", "completion", "approval", "blocked", "routine"];
  const KIND_LABEL = {
    all: "全部", tool: "工具调用", cost: "成本", completion: "完成",
    approval: "审批", blocked: "阻塞", routine: "例行",
  };
  const visible = kind === "all" ? state.activity : state.activity.filter((e) => e.kind === kind);

  return html`
    <div>
      <div class="fleet-toolbar">
        <div class="seg">
          ${kinds.map(
            (k) => html`<button key=${k} class=${kind === k ? "active" : ""} onClick=${() => setKind(k)}>
              ${KIND_LABEL[k]}
            </button>`,
          )}
        </div>
      </div>
      <div class="card">
        ${visible.length === 0
          ? html`<div class="empty">该类型暂无事件</div>`
          : visible.map(
              (e) => html`
                <div key=${e.id} class="feed-item">
                  <div class="ts">${e.ts}</div>
                  <div class="body">
                    <div class="row" style=${css("gap:0;flex-wrap:wrap")}>
                      <span class=${`kind kind-${e.kind}`}>${KIND_LABEL[e.kind] ?? e.kind}</span>
                      <span style=${css("font-weight:500")}>${e.text}</span>
                    </div>
                    <div class="dim" style=${css("font-size:11px;margin-top:4px")}>
                      ${termName(e.terminalId)} · ${e.agent} · ${e.meta}
                    </div>
                  </div>
                </div>
              `,
            )}
      </div>
      <div class="note-box">
        <b>真实映射：</b> 把现在散落在各终端的输出/完成绿点/成本采样，统一成一条可过滤的时间线（类似 diagnostic-logs，但跨终端聚合）。<b>缺口：</b> 需要一个跨终端的事件总线把 tool/cost/completion/approval 事件归一化后落库，供回溯审计。
      </div>
    </div>
  `;
}

const VIEWS = {
  fleet: FleetView,
  budget: BudgetView,
  routines: RoutinesView,
  approvals: ApprovalsView,
  activity: ActivityView,
};

function App() {
  const [state, setState] = useState(null);
  const [active, setActive] = useState("fleet");
  const [toast, setToast] = useState("");

  useEffect(() => {
    fetch(`./mock-state.json?t=${Date.now()}`, { cache: "no-store" })
      .then((r) => r.json())
      .then(setState);
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  if (!state) return html`<div class="empty" style=${css("padding:80px")}>加载 mock-state…</div>`;

  const idea = IDEAS.find((i) => i.id === active);
  const View = VIEWS[active];

  return html`
    <div class="app">
      <nav class="nav">
        <div class="nav-brand">
          <h1>Runweave × Paperclip</h1>
          <p>把 Paperclip 的「AI 公司控制面」能力借鉴进 Runweave 的多终端场景 · 5 个可落地点</p>
        </div>
        <div class="nav-section">借鉴点</div>
        ${IDEAS.map(
          (i, idx) => html`
            <button
              key=${i.id}
              class=${`nav-item ${active === i.id ? "active" : ""}`}
              onClick=${() => setActive(i.id)}
            >
              <span class="idx">${idx + 1}</span>
              <span class="nav-text">
                <span class="nav-title">${i.title}</span>
                <span class="nav-sub">${i.sub}</span>
              </span>
            </button>
          `,
        )}
        <div class="nav-foot">
          原型 = 交互意图，非产品合约。<br />数据全为 mock，落地缺口见每页底部说明。
        </div>
      </nav>

      <main class="main">
        <div class="view-head">
          <h2>${idea.title} · ${idea.sub}</h2>
          <p class="why">${idea.why}</p>
          <span class="paperclip-tag">📎 借鉴自 ${idea.paperclip}</span>
        </div>
        <div class="view-body">
          <${View} state=${state} notify=${setToast} />
        </div>
      </main>

      ${toast && html`<div class="toast">${toast}</div>`}
    </div>
  `;
}

createRoot(document.getElementById("root")).render(html`<${App} />`);
