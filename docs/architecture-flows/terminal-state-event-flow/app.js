/* global document */

const axes = [
  {
    tone: "var(--green)",
    name: "进程生命周期",
    owner: "TerminalSessionRecord.status",
    states: ["running", "exited"],
    detail:
      "PTY / tmux-backed session 是否仍存在。它是退出判断的第一优先级，不表达 Agent 是否忙。",
  },
  {
    tone: "var(--amber)",
    name: "数据连接",
    owner: "useTerminalConnection",
    states: ["connecting", "connected", "closed"],
    detail:
      "每个已挂载 terminal surface 独立维护。重连中禁止发送输入；closed 可能需要人工恢复。",
  },
  {
    tone: "var(--cyan)",
    name: "Agent 本地投影",
    owner: "TerminalStateService",
    states: ["shell_idle", "agent_starting", "agent_running", "agent_idle"],
    detail:
      "由 activeCommand、hook、持久化状态与生命周期补偿共同更新，是 Terminal tab 的主要工作状态。",
  },
  {
    tone: "var(--violet)",
    name: "Provider Thread 事实",
    owner: "App Server state projection",
    states: ["starting", "running", "idle", "completed", "failed", "unknown"],
    detail:
      "Codex thread/read 与 Trae 生命周期记录提供更接近 provider 的事实，用于 Home 状态和缺 hook 补偿。",
  },
  {
    tone: "var(--blue)",
    name: "注意力标记",
    owner: "Session revision + workspace store",
    states: ["completionRevision", "acknowledged", "bell", "none"],
    detail:
      "右侧小点只回答“用户要不要看”。completion revision 持久化并在选中时确认；bell 仍仅 live、非当前 session，2 秒清除。",
  },
  {
    tone: "var(--red)",
    name: "多 Pane 聚合",
    owner: "aggregatePanelTerminalState",
    states: [
      "any running → running",
      "any starting → starting",
      "agent pane → idle",
      "else shell_idle",
    ],
    detail:
      "Session 级状态由所有 running Pane 汇总；优先级为 running → starting → idle → shell_idle。",
  },
];

const scenarios = [
  {
    id: "normal",
    label: "正常执行",
    title: "从 shell 到 Agent 完成一轮任务",
    description:
      "metadata 先识别 Agent，hook 再表达一轮工作的开始与结束。Thread 投影与本地 TerminalState 并行更新。",
    result: "running + connected + agent_idle；completion marker 可独立存在",
    steps: [
      {
        actor: "Shell / OSC",
        title: "识别 activeCommand",
        detail: "shell integration 上报 activeCommand=codex。",
        event: "metadata(activeCommand=codex)",
        axes: ["Agent → agent_starting", "Session metadata"],
      },
      {
        actor: "Hook bridge",
        title: "提交用户请求",
        detail:
          "UserPromptSubmit 带 session、panel、tmux pane、thread 和 operation identity。",
        event: "agent.hook(UserPromptSubmit)",
        axes: ["Thread → running", "候选事件"],
      },
      {
        actor: "Backend gate",
        title: "校验事件归属",
        detail:
          "拒绝已退出 session、旧 operation、错 Pane、错 Agent 或过期 hook。",
        event: "processTerminalAgentHook()",
        axes: ["身份校验", "无状态变化"],
      },
      {
        actor: "State projection",
        title: "投影为工作中",
        detail: "TerminalStateService 写入并持久化 agent_running。",
        event: "terminal_state_changed",
        axes: ["Agent → agent_running", "Live event"],
      },
      {
        actor: "Stop / completion",
        title: "结束本轮并提醒",
        detail: "Stop 把 Agent 投影回 idle；completion 事件单独点亮右侧绿点。",
        event: "Stop + completion(hook_stop)",
        axes: ["Agent → agent_idle", "Attention → completion"],
      },
    ],
  },
  {
    id: "attention",
    label: "完成与提醒",
    title: "状态点与提醒点的生命周期不同",
    description:
      "Agent 已 idle 不等于用户已看过结果；右侧 completion 和 bell 是 UI 本地注意力标记。",
    result: "左点回答“在做什么”；右点回答“要不要看”",
    steps: [
      {
        actor: "Agent hook",
        title: "Stop 到达",
        detail: "先把左侧 Agent 状态从 running 更新为 idle。",
        event: "terminal_state_changed(next=agent_idle)",
        axes: ["Agent → agent_idle"],
      },
      {
        actor: "Completion",
        title: "完成事件到达",
        detail:
          "Backend 先增加 session completionRevision，再把 revision 放入 completion live event。",
        event: "completion(reason=hook_stop, revision=N)",
        axes: ["Attention → completion", "Session revision → N"],
      },
      {
        actor: "Terminal bell",
        title: "非当前页响铃",
        detail:
          "仅 live 事件且 session 非当前时设置琥珀 marker，2 秒后自动清除。",
        event: "terminal_bell",
        axes: ["Attention → bell", "TTL 2s"],
      },
      {
        actor: "Tab rendering",
        title: "同一槽位有优先级",
        detail: "右侧先显示 bell，bell 消失后 completion 仍可继续显示。",
        event: "bell || completion",
        axes: ["amber > green"],
      },
      {
        actor: "User",
        title: "选中 Session",
        detail:
          "进入该 session 时提交 acknowledgedCompletionRevision=N；刷新后仍保持已读，不改变 Agent 或进程状态。",
        event: "PATCH session(acknowledgedCompletionRevision=N)",
        axes: ["Attention → none", "Ack → N"],
      },
    ],
  },
  {
    id: "reconnect",
    label: "断线恢复",
    title: "两条 WebSocket，两套恢复规则",
    description:
      "terminal data WS 恢复单个 xterm 数据；global terminal-events WS 恢复工作区增量。二者不可混用。",
    result: "连接状态过渡不应覆盖最后一次已知 Agent 状态",
    steps: [
      {
        actor: "Terminal data WS",
        title: "连接中断",
        detail: "如果 session 未 exited 且 close 原因允许，进入指数退避重连。",
        event: "/ws/terminal close",
        axes: ["Connection → connecting", "禁止输入"],
      },
      {
        actor: "Runtime",
        title: "重新附着",
        detail:
          "tmux session 保留；重新 attach runtime 并获取 snapshot / output。",
        event: "ticket → connected → snapshot",
        axes: ["Connection → connected"],
      },
      {
        actor: "Global events WS",
        title: "携带 cursor 重连",
        detail:
          "客户端提交最后 event id，服务端在内存 500 条窗口内补发 catchup。",
        event: "/ws/terminal-events?after=cursor",
        axes: ["Event cursor"],
      },
      {
        actor: "Recovery gate",
        title: "检测 stream 或 gap",
        detail:
          "Backend 重启导致 streamId 变化，cursor 太旧或超前也会触发 reset。",
        event: "streamId changed / cursor gap",
        axes: ["Connection → resync"],
      },
      {
        actor: "REST snapshot",
        title: "回到权威列表",
        detail:
          "清空 event cursor / seen ids，重新 loadSessions，再继续消费 live 增量。",
        event: "loadSessions()",
        axes: ["Session snapshot", "Event cursor reset"],
      },
    ],
  },
  {
    id: "exit",
    label: "退出与重启",
    title: "进程终态覆盖其它显示状态",
    description:
      "Agent 状态可能仍保留在 store 或持久化记录里，但读取和 UI 都必须先尊重 session exited。",
    result: "exited 是显示终态；重新创建 / 恢复 runtime 才能回到 running",
    steps: [
      {
        actor: "PTY / tmux",
        title: "进程退出",
        detail:
          "runtime recorder 收到 exit，manager 持久化 status=exited 与 exitCode。",
        event: "onExit(exitCode)",
        axes: ["Process → exited"],
      },
      {
        actor: "Terminal WS",
        title: "推送终态",
        detail: "客户端收到 status/exit；退出后不再自动重连该 runtime。",
        event: "{type:exit}",
        axes: ["Runtime → exited", "Connection → closed"],
      },
      {
        actor: "State read",
        title: "压制陈旧 Agent 状态",
        detail:
          "getCurrent 对 exited 直接返回 shell_idle；tab 先用 exited 灰点。",
        event: "session.status first",
        axes: ["Agent display shadowed"],
      },
      {
        actor: "Late hook",
        title: "拒绝迟到事件",
        detail:
          "agent hook processor 对 exited session 返回 exited，不恢复工作状态。",
        event: "hook → 202 / ignored",
        axes: ["No resurrection"],
      },
      {
        actor: "User / manager",
        title: "显式恢复或新建",
        detail:
          "只有 session/runtime 回到 running，连接与 Agent 投影才开始新一轮状态流。",
        event: "resume / create",
        axes: ["Process → running", "Connection → connecting"],
      },
    ],
  },
  {
    id: "panes",
    label: "多 Pane",
    title: "Pane 是事实单位，Session 是聚合视图",
    description:
      "hook 先落到 panel/tmux pane，Session tab 再把所有 running Pane 聚合成一个状态。",
    result: "agent_running 优先，其次保留 agent_starting，再降到 agent_idle",
    steps: [
      {
        actor: "Panel A",
        title: "Shell 空闲",
        detail: "running Pane，没有 Agent command。",
        event: "shell_idle",
        axes: ["Pane A → shell_idle"],
      },
      {
        actor: "Panel B",
        title: "Agent 启动中",
        detail: "activeCommand=codex，Pane 自身 terminalState=agent_starting。",
        event: "agent_starting",
        axes: ["Pane B → agent_starting"],
      },
      {
        actor: "Aggregator",
        title: "第一次汇总",
        detail:
          "没有 running Agent、但存在 starting Agent；当前实现保留 starting。",
        event: "agent_starting → agent_starting",
        axes: ["Session → agent_starting", "启动语义保留"],
      },
      {
        actor: "Panel C",
        title: "Agent 工作中",
        detail: "另一个 Pane 收到 UserPromptSubmit，状态进入 agent_running。",
        event: "agent_running",
        axes: ["Pane C → agent_running"],
      },
      {
        actor: "Aggregator",
        title: "running 抢占",
        detail: "任意 running Agent Pane 都优先成为 Session 级状态。",
        event: "any running wins",
        axes: ["Session → agent_running"],
      },
    ],
  },
];

const legend = [
  {
    type: "dot",
    color: "var(--cyan)",
    pulse: true,
    label: "agent_running",
    detail: "左点，Agent 正在执行",
  },
  {
    type: "dot",
    color: "var(--amber)",
    pulse: true,
    label: "agent_starting",
    detail: "左点，Agent 启动过渡",
  },
  {
    type: "dot",
    color: "var(--sky)",
    fill: true,
    label: "agent_idle",
    detail: "左点，Agent 已就绪 / 空闲",
  },
  {
    type: "dot",
    color: "#64748b",
    label: "shell_idle",
    detail: "左点，普通 shell 空闲",
  },
  {
    type: "dot",
    color: "#64748b",
    fill: true,
    label: "exited",
    detail: "左点，进程终态",
  },
  {
    type: "attention",
    color: "var(--green)",
    label: "completion",
    detail: "右点，持久 revision；选中后服务端确认",
  },
  {
    type: "attention",
    color: "var(--amber)",
    label: "bell",
    detail: "右点，仅 live / 非当前，2 秒",
  },
  {
    type: "stripe",
    color: "var(--amber)",
    label: "connecting / resync",
    detail: "本图建议的过渡编码，非当前产品枚举",
  },
];

const precedence = [
  {
    surface: "Terminal tab",
    chain: [
      "session.status=exited",
      "terminalStateBySessionId",
      "session.terminalState",
    ],
  },
  {
    surface: "App Home",
    chain: [
      "session.status=exited",
      "running panels aggregate",
      "provider thread snapshot",
      "TerminalState fallback",
    ],
  },
  {
    surface: "State API",
    chain: ["running panels aggregate", "TerminalStateService.getCurrent"],
  },
  {
    surface: "Event recovery",
    chain: ["streamId + cursor", "gap detection", "REST loadSessions"],
  },
];

const risks = [
  {
    title: "跨接口快照不是原子读取",
    detail:
      "Pane workspace、State API、Session 列表和 Home 分别读取；真实 prepare 转换中观察到 128–297ms 的短暂回退与交叉状态。",
  },
  {
    title: "多 Pane session activeCommand 是有损摘要",
    detail:
      "两个 running panel 时 session activeCommand 会被压成 null，但 /state 仍聚合各 panel；不能用 session null 证明所有 Pane 已回到 shell。",
  },
  {
    title: "OSC command marker 缺少来源认证",
    detail:
      "普通进程可输出 RunweaveCommand OSC；当前只解析内容，没有 shell 级 nonce，能把 printf + sleep 显示成 Codex。",
  },
  {
    title: "live event 不是持久事实",
    detail:
      "TerminalEventService 仅保留内存 500 条，Backend 重启会换 streamId；恢复必须回到 REST 快照。",
  },
  {
    title: "completion 不是完成态枚举",
    detail:
      "它是持久化注意力 revision，不是 Agent 状态；可以与 running、idle 或后续任务并存，直到用户确认。",
  },
];

const issueFilters = [
  { id: "all", label: "全部问题" },
  { id: "architecture", label: "系统架构" },
  { id: "reliability", label: "可靠稳定性" },
  { id: "reproduced", label: "真实场景复现" },
];

const issues = [
  {
    id: "A7",
    category: "architecture",
    severity: "中",
    status: "reproduced",
    title: "启动 Codex 时，几个页面的状态可能短暂对不上",
    summary:
      "这是短暂的显示不一致，不是状态永久错乱。启动或完成 Codex 时，终端页、状态接口和 Home 分别读取数据，可能在不到 300ms 的窗口里显示不同阶段。",
    verdict: "结论：状态可能闪一下，但实测会在 300ms 内自动一致。",
    story: [
      {
        title: "用户启动 Codex",
        detail: "系统开始把状态从“Shell 空闲”切换成“Agent 启动中”。",
      },
      {
        title: "几个页面各自读取",
        detail:
          "终端面板、状态接口、Session 列表和 Home 没有读取同一份瞬时快照。",
      },
      {
        title: "短时间看到不同状态",
        detail: "一个地方已经显示“启动中”，另一个地方还停留在“Shell 空闲”。",
      },
      {
        title: "约 300ms 后自动一致",
        detail: "本次实测全部收敛，没有复现持续 5–7 秒的旧问题。",
      },
    ],
    correctCheckLabel: "怎么判断是不是真故障",
    correctCheck:
      "不要用转换瞬间的一次读取直接判失败。连续观察 300ms：如果之后仍然对不上，才判为持续性状态故障；如果只在边界短暂出现，则记录为瞬时一致性问题。",
    trigger:
      "prepare command_submitted 后并发读取 Pane workspace、State API、Session 列表与 Home，或在 hook 转换边界切换页面。",
    mechanism:
      "GET panels 会刷新 tmux metadata 并写 Pane/Session；State API、Session DTO 与 Home provider snapshot 各自独立读取，没有共享 revision 或原子快照。",
    consequence:
      "启动状态可在百毫秒窗口内 starting → shell_idle → starting；完成边界也会出现 Pane idle、Home running 的短暂交叉，造成闪烁或错误操作判断。",
    protection:
      "实测均在 300ms 内收敛；旧版持续 5–7 秒的多 Pane读模型分裂已经无法复现。",
    evidence:
      "真实复现：prepare 响应后 39ms /state=starting 但 Pane=shell_idle；169ms Pane=starting 但 /state、Session、Home=shell_idle；297ms 全部收敛 starting。hook 边界另出现约 130ms Pane idle / Home running。",
    sources: [
      "backend/src/terminal/application/panel-metadata.ts",
      "backend/src/routes/app-home-overview.ts",
      "backend/src/routes/terminal-state.ts",
      "backend/src/terminal/manager-session-runtime.ts",
    ],
  },
  {
    id: "A8",
    category: "architecture",
    severity: "中",
    status: "reproduced",
    title: "验收看错了对象：Codex 其实还没退出",
    summary:
      "这不是终端状态残留。一个面板回到了 shell，另一个面板中的 Codex 仍在运行；旧验收规则只看终端汇总字段，于是把正常状态误判成故障。",
    verdict: "结论：不用修状态机，要修验收条件。",
    story: [
      {
        title: "同一终端有两个面板",
        detail: "面板 A 已回到 shell；面板 B 的 Codex 还在运行。",
      },
      {
        title: "终端汇总字段变成 null",
        detail:
          "session.activeCommand=null 只表示两个面板没有一个共同命令，不表示 Codex 已退出。",
      },
      {
        title: "/state 仍显示 Agent idle",
        detail:
          "它逐个读取面板，发现 Codex 面板仍存在，所以 agent_idle/codex 是正确结果。",
      },
      {
        title: "旧用例把 null 当成“全部退出”",
        detail: "于是报出“退出后状态没清理”。这是验收误报，不是产品故障。",
      },
    ],
    correctCheckLabel: "正确验收方式",
    correctCheck:
      "只盯住启动 Codex 的那个面板：先确认该面板里的 Codex 进程真的退出，再检查该面板回到 shell_idle/null。",
    trigger:
      "一个 session 有两个 running panel，其中一个是 shell、另一个仍运行 Codex；诊断只读取 session activeCommand 和 /state。",
    mechanism:
      "多 Pane 路径主动清空 session activeCommand；State API 则绕过 session getCurrent，优先聚合 running panel 的 terminalState。两者表达不同层级的事实。",
    consequence:
      "TS-API-007、诊断脚本或人工排障可能在 Agent 仍存活时宣告退出清理失败，随后基于错误根因修改状态机。",
    protection:
      "panel workspace 和 tmux 仍保留逐 Pane 事实；只要验收绑定目标 panel、确认真实进程退出并读取该 panel metadata，就能避免误判。",
    evidence:
      "真实现场 ac7ac256：session activeCommand=null、/state=agent_idle/codex；但活动 %1 的 Codex PID 21440 仍存活，tmux @runweave_command 仍为 codex。K1 状态残留未复现，观测契约歧义已复现。",
    sources: [
      "backend/src/terminal/manager-session-runtime.ts",
      "backend/src/terminal/application/panel-metadata.ts",
      "backend/src/routes/terminal-state.ts",
      "docs/testing/terminal/terminal-runtime-core.testplan.yaml",
    ],
  },
  {
    id: "R2",
    category: "reliability",
    severity: "高",
    status: "reproduced",
    title: "普通命令能让终端短暂冒充“Codex 正在运行”",
    summary:
      "这是一个真实代码 Bug。普通程序只要打印一段特殊控制信息，就能被误认成 Codex；API 和终端标签会短暂显示 Codex，尽管实际上根本没有启动它。",
    verdict: "结论：需要修。现有自动纠正只能缩短错误时间，不能阻止误识别。",
    story: [
      {
        title: "普通命令打印特殊信息",
        detail: "真实运行的只是 printf + sleep，并没有启动 Codex。",
      },
      {
        title: "Backend 把信息当真",
        detail:
          "当前只检查内容像不像合法命令，没有确认信息是否来自可信的 Shell 集成。",
      },
      {
        title: "页面和 API 显示 Codex",
        detail:
          "终端标签会短暂变成 feature(codex)，依赖命令身份的判断也会收到错误信息。",
      },
      {
        title: "稍后自动纠正",
        detail: "tmux 最终会恢复真实命令，但错误身份已经出现过。",
      },
    ],
    correctCheckLabel: "怎么复现与验收修复",
    correctCheck:
      "让普通命令输出同样的控制信息；如果 API 或终端标签曾显示 Codex，就说明问题仍存在。修复后，这类非可信信息必须被拒绝，并且页面始终保持真实命令身份。",
    trigger: "终端程序输出与 shell integration 相同的 OSC 序列。",
    mechanism:
      "Backend 只按正则和 command allowlist解析，没有校验 shell 注入时生成的随机 nonce。",
    consequence:
      "普通命令能让 tab 从 feature 变为 feature(codex)，并让依赖 activeCommand 的状态门禁接收错误身份。",
    protection:
      "tmux fallback 随后把 command 修正为真实前台命令，但无法阻止错误窗口。",
    evidence:
      "真实复现：实际执行 printf OSC; sleep 2，300ms API activeCommand=codex，页面按钮为 feature(codex)，尽管真实前台流程只是 printf + sleep。已保存截图。",
    sources: [
      "backend/src/terminal/shell-integration.ts",
      "backend/src/ws/terminal-metadata-sync.ts",
    ],
  },
];

const sources = [
  {
    title: "Session / Agent contracts",
    files: [
      "packages/shared/src/terminal/session.ts",
      "packages/shared/src/terminal/state.ts",
    ],
  },
  {
    title: "Hook authenticity gate",
    files: [
      "backend/src/terminal/agent-hook-processor.ts",
      "backend/src/routes/terminal-state.ts",
    ],
  },
  {
    title: "Terminal projection",
    files: [
      "backend/src/terminal/terminal-state-service.ts",
      "backend/src/terminal/terminal-state-store.ts",
    ],
  },
  {
    title: "Provider truth",
    files: [
      "app-server/src/state-projector.ts",
      "app-server/src/agent-thread-status-reconciler.ts",
    ],
  },
  {
    title: "Event recovery",
    files: [
      "backend/src/terminal/terminal-event-service.ts",
      "frontend/src/features/terminal/use-terminal-events-connection.ts",
    ],
  },
  {
    title: "UI semantics",
    files: [
      "frontend/src/components/terminal/terminal-session-tab.tsx",
      "frontend/src/components/terminal/terminal-workspace-events.ts",
    ],
  },
];

let activeScenarioId = "normal";
let activeIssueFilterId = "all";
let activeIssueId = "A7";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderAxes() {
  document.querySelector("#axis-grid").innerHTML = axes
    .map(
      (axis, index) => `
      <article class="axis-card" style="--tone:${axis.tone}">
        <div class="axis-top"><span class="axis-no">AXIS 0${index + 1}</span><span class="axis-owner">${escapeHtml(axis.owner)}</span></div>
        <h3>${escapeHtml(axis.name)}</h3>
        <div class="state-pills">${axis.states.map((state) => `<span class="state-pill">${escapeHtml(state)}</span>`).join("")}</div>
        <p>${escapeHtml(axis.detail)}</p>
      </article>`,
    )
    .join("");
}

function renderScenario() {
  const scenario =
    scenarios.find((item) => item.id === activeScenarioId) ?? scenarios[0];
  document.querySelector("#scenario-nav").innerHTML = scenarios
    .map(
      (item) =>
        `<button type="button" role="tab" class="scenario-button ${item.id === scenario.id ? "active" : ""}" data-scenario="${item.id}" aria-selected="${item.id === scenario.id}">${escapeHtml(item.label)}</button>`,
    )
    .join("");
  document.querySelector("#scenario-summary").innerHTML =
    `<div><h3>${escapeHtml(scenario.title)}</h3><p>${escapeHtml(scenario.description)}</p></div><div class="scenario-result">RESULT · ${escapeHtml(scenario.result)}</div>`;
  document.querySelector("#scenario-flow").innerHTML = scenario.steps
    .map(
      (step, index) => `
      <article class="flow-step">
        <div class="step-meta"><span>STEP ${String(index + 1).padStart(2, "0")}</span><span>${escapeHtml(step.actor)}</span></div>
        <h3>${escapeHtml(step.title)}</h3>
        <p>${escapeHtml(step.detail)}</p>
        <div class="axis-change">${step.axes.map((axis) => `<span>${escapeHtml(axis)}</span>`).join("")}</div>
        <div class="step-event">${escapeHtml(step.event)}</div>
      </article>`,
    )
    .join("");
  document.querySelectorAll("[data-scenario]").forEach((button) => {
    button.addEventListener("click", () => {
      activeScenarioId = button.dataset.scenario;
      renderScenario();
    });
  });
}

function renderLegend() {
  document.querySelector("#legend-list").innerHTML = legend
    .map((item) => {
      const visual =
        item.type === "stripe"
          ? `<i style="width:18px;height:10px;border:1px solid ${item.color};border-radius:3px;background:repeating-linear-gradient(135deg,rgba(251,191,36,.28) 0 3px,transparent 3px 6px)"></i>`
          : item.type === "attention"
            ? `<i class="attention-dot" style="--tone:${item.color}"></i>`
            : `<i class="visual-dot ${item.pulse ? "pulse" : ""}" style="--tone:${item.color};--fill:${item.fill ? item.color : "transparent"}"></i>`;
      return `<div class="legend-item">${visual}<strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(item.detail)}</span></div>`;
    })
    .join("");
}

function renderTruth() {
  document.querySelector("#precedence-list").innerHTML = precedence
    .map(
      (item) =>
        `<div class="precedence-row"><strong>${escapeHtml(item.surface)}</strong><div class="precedence-chain">${item.chain.map((step, index) => `${index ? "→" : ""} <b>${escapeHtml(step)}</b>`).join(" ")}</div></div>`,
    )
    .join("");
  document.querySelector("#risk-list").innerHTML = risks
    .map(
      (risk) =>
        `<article class="risk-card"><strong><span class="fact-tag">FACT</span>${escapeHtml(risk.title)}</strong><p>${escapeHtml(risk.detail)}</p></article>`,
    )
    .join("");
}

function getFilteredIssues() {
  if (activeIssueFilterId === "all") {
    return issues;
  }
  if (
    activeIssueFilterId === "architecture" ||
    activeIssueFilterId === "reliability"
  ) {
    return issues.filter((issue) => issue.category === activeIssueFilterId);
  }
  return issues.filter((issue) => issue.status === activeIssueFilterId);
}

function issueTone(issue) {
  if (issue.status === "reproduced") return "var(--red)";
  if (issue.status === "structural-risk") return "var(--amber)";
  return issue.category === "architecture" ? "var(--violet)" : "var(--blue)";
}

function issueStatusLabel(status) {
  if (status === "reproduced") return "真实场景复现";
  if (status === "structural-risk") return "结构性风险";
  return "代码事实";
}

function issueCategoryLabel(category) {
  return category === "architecture" ? "系统架构" : "可靠稳定性";
}

function renderIssueDetail(issue) {
  if (!issue) {
    return `<div class="issue-index-empty">当前筛选没有问题项</div>`;
  }
  const tone = issueTone(issue);
  const explanation = issue.story
    ? `
      <div class="issue-verdict">${escapeHtml(issue.verdict)}</div>
      <ol class="issue-story">
        ${issue.story
          .map(
            (step, index) => `
              <li>
                <span>${index + 1}</span>
                <div>
                  <strong>${escapeHtml(step.title)}</strong>
                  <p>${escapeHtml(step.detail)}</p>
                </div>
              </li>`,
          )
          .join("")}
      </ol>
      <div class="issue-correct-check">
        <strong>${escapeHtml(issue.correctCheckLabel ?? "正确验收方式")}</strong>
        <p>${escapeHtml(issue.correctCheck)}</p>
      </div>
      <details class="issue-technical">
        <summary>展开技术原因与现场证据</summary>
        <dl class="issue-chain">
          <div><dt>触发条件</dt><dd>${escapeHtml(issue.trigger)}</dd></div>
          <div><dt>代码机制</dt><dd>${escapeHtml(issue.mechanism)}</dd></div>
          <div><dt>可能结果</dt><dd>${escapeHtml(issue.consequence)}</dd></div>
          <div><dt>现有保护</dt><dd>${escapeHtml(issue.protection)}</dd></div>
        </dl>
        <div class="issue-evidence">
          <strong>真实现场证据</strong>
          <p>${escapeHtml(issue.evidence)}</p>
        </div>
        <div class="issue-source-list">${issue.sources.map((source) => `<code>${escapeHtml(source)}</code>`).join("")}</div>
      </details>`
    : `
      <dl class="issue-chain">
        <div><dt>触发条件</dt><dd>${escapeHtml(issue.trigger)}</dd></div>
        <div><dt>代码机制</dt><dd>${escapeHtml(issue.mechanism)}</dd></div>
        <div><dt>可能结果</dt><dd>${escapeHtml(issue.consequence)}</dd></div>
        <div><dt>现有保护</dt><dd>${escapeHtml(issue.protection)}</dd></div>
      </dl>
      <div class="issue-evidence">
        <strong>Evidence level</strong>
        <p>${escapeHtml(issue.evidence)}</p>
      </div>
      <div class="issue-source-list">${issue.sources.map((source) => `<code>${escapeHtml(source)}</code>`).join("")}</div>`;
  return `
    <div style="--issue-tone:${tone}">
      <div class="issue-detail-topline">
        <span class="issue-id">${escapeHtml(issue.id)}</span>
        <div class="issue-statuses">
          <span>${escapeHtml(issueCategoryLabel(issue.category))}</span>
          <span>影响 ${escapeHtml(issue.severity)}</span>
          <span class="status-primary">${escapeHtml(issueStatusLabel(issue.status))}</span>
        </div>
      </div>
      <h3>${escapeHtml(issue.title)}</h3>
      <p class="issue-summary">${escapeHtml(issue.summary)}</p>
      ${explanation}
    </div>`;
}

function renderIssues() {
  const filteredIssues = getFilteredIssues();
  if (!filteredIssues.some((issue) => issue.id === activeIssueId)) {
    activeIssueId = filteredIssues[0]?.id ?? "";
  }
  const activeIssue = issues.find((issue) => issue.id === activeIssueId);
  const architectureCount = issues.filter(
    (issue) => issue.category === "architecture",
  ).length;
  const reproducedCount = issues.filter(
    (issue) => issue.status === "reproduced",
  ).length;
  const highCount = issues.filter((issue) => issue.severity === "高").length;

  document.querySelector("#issue-overview").innerHTML = [
    { label: "Architecture", value: architectureCount, tone: "var(--violet)" },
    { label: "Reproduced", value: reproducedCount, tone: "var(--red)" },
    { label: "High impact", value: highCount, tone: "var(--amber)" },
  ]
    .map(
      (metric) =>
        `<div class="issue-metric" style="--metric-tone:${metric.tone}"><span>${escapeHtml(metric.label)}</span><strong>${metric.value}</strong></div>`,
    )
    .join("");
  document.querySelector("#issue-filter-bar").innerHTML = issueFilters
    .map(
      (filter) =>
        `<button type="button" role="tab" class="issue-filter ${filter.id === activeIssueFilterId ? "active" : ""}" data-issue-filter="${filter.id}" aria-selected="${filter.id === activeIssueFilterId}">${escapeHtml(filter.label)}</button>`,
    )
    .join("");
  document.querySelector("#issue-index").innerHTML = filteredIssues.length
    ? filteredIssues
        .map((issue) => {
          const tone = issueTone(issue);
          return `<button type="button" class="issue-index-item ${issue.id === activeIssueId ? "active" : ""}" style="--issue-tone:${tone}" data-issue-id="${issue.id}" aria-pressed="${issue.id === activeIssueId}">
            <span class="issue-id">${escapeHtml(issue.id)}</span>
            <span class="issue-index-copy"><strong>${escapeHtml(issue.title)}</strong><span>${escapeHtml(issueStatusLabel(issue.status))}</span></span>
            <span class="severity">${escapeHtml(issue.severity)}</span>
          </button>`;
        })
        .join("")
    : `<div class="issue-index-empty">当前筛选没有问题项</div>`;
  document.querySelector("#issue-detail").innerHTML =
    renderIssueDetail(activeIssue);

  document.querySelectorAll("[data-issue-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      activeIssueFilterId = button.dataset.issueFilter;
      renderIssues();
    });
  });
  document.querySelectorAll("[data-issue-id]").forEach((button) => {
    button.addEventListener("click", () => {
      activeIssueId = button.dataset.issueId;
      renderIssues();
    });
  });
}

function renderSources() {
  document.querySelector("#source-grid").innerHTML = sources
    .map(
      (source) =>
        `<article class="source-card"><strong>${escapeHtml(source.title)}</strong>${source.files.map((file) => `<code>${escapeHtml(file)}</code>`).join("")}</article>`,
    )
    .join("");
}

renderAxes();
renderScenario();
renderLegend();
renderTruth();
renderIssues();
renderSources();
