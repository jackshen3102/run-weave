// 行为核对:终端聚合状态被僵尸 agent_starting 污染的收敛修复
//
// 复现的真实现场来自终端 dd8353fe(worktree agent-team-2 的 Agent Team 会话):
//   main            cmd=codex  agent_idle      有活跃 turn 时由 hook 驱动
//   code-1          cmd=codex  agent_starting  turn 早已结束、无活跃 operation generation ← 僵尸
//   code_review-2   cmd=codex  agent_idle
//   behavior_verify cmd=null   shell_idle
// 修复前:aggregatePanelTerminalState 把整体折叠成 agent_starting(僵尸 code-1 拖住)。
// 修复后:reconcile 用 convergeStaleStartingWithoutLease 把无租约的 code-1 收敛为
//         agent_idle,整体折叠回 agent_idle。
//
// 用法:node scripts/verify-terminal-aggregate-starting-convergence.mjs

import {
  aggregatePanelTerminalState,
} from "../backend/src/terminal/terminal-state-service.ts";
import {
  convergeStaleStartingWithoutLease,
} from "../backend/src/terminal/application/panel-workspace.ts";

let failures = 0;
function check(name, ok, detail) {
  const status = ok ? "PASS" : "FAIL";
  if (!ok) failures += 1;
  console.log(`[${status}] ${name}`, detail ? JSON.stringify(detail) : "");
}

// 假 manager:只实现判据依赖的 hasPanelAgentOperationGeneration。
// leasedPanelIds 表示当前仍持有活跃启动 operation generation 的 panel。
function fakeManager(leasedPanelIds) {
  const leased = new Set(leasedPanelIds);
  return {
    hasPanelAgentOperationGeneration: (_sessionId, panelId) =>
      leased.has(panelId),
  };
}

const SID = "dd8353fe";
const state = (state, agent = "codex") => ({ state, agent });
const runningPanel = (id, terminalState) => ({
  id,
  status: "running",
  activeCommand: terminalState.agent,
  terminalState,
});

// 1) 僵尸 code-1(agent_starting 且无租约)被收敛为 agent_idle。
{
  const mgr = fakeManager([]); // 无任何活跃租约
  const converged = convergeStaleStartingWithoutLease(
    mgr,
    SID,
    "code-1",
    state("agent_starting"),
  );
  check(
    "stale-starting-without-lease-converges-to-idle",
    converged.state === "agent_idle" && converged.agent === "codex",
    converged,
  );
}

// 2) 真正启动中(agent_starting 且持有租约)不被误收敛,仍是 agent_starting。
{
  const mgr = fakeManager(["code-1"]);
  const kept = convergeStaleStartingWithoutLease(
    mgr,
    SID,
    "code-1",
    state("agent_starting"),
  );
  check(
    "starting-with-active-lease-stays-starting",
    kept.state === "agent_starting" && kept.agent === "codex",
    kept,
  );
}

// 3) 非 starting 状态原样返回(收敛只作用于 agent_starting)。
{
  const mgr = fakeManager([]);
  for (const s of ["agent_running", "agent_idle", "shell_idle"]) {
    const same = convergeStaleStartingWithoutLease(
      mgr,
      SID,
      "p",
      state(s, s === "shell_idle" ? null : "codex"),
    );
    check(`non-starting-passthrough-${s}`, same.state === s, same);
  }
}

// 4) 端到端:dd8353fe 现场,收敛前整体被拖成 starting,收敛后回到 idle。
{
  const mgr = fakeManager([]); // 现场:四个 panel 均无活跃租约
  const rawPanels = [
    runningPanel("main", state("agent_idle")),
    runningPanel("code-1", state("agent_starting")), // 僵尸
    runningPanel("code_review-2", state("agent_idle")),
    { id: "behavior_verify", status: "running", activeCommand: null, terminalState: state("shell_idle", null) },
  ];
  const beforeFix = aggregatePanelTerminalState(rawPanels);
  const convergedPanels = rawPanels.map((p) => ({
    ...p,
    terminalState: convergeStaleStartingWithoutLease(
      mgr,
      SID,
      p.id,
      p.terminalState,
    ),
  }));
  const afterFix = aggregatePanelTerminalState(convergedPanels);
  check(
    "before-fix-aggregate-is-starting",
    beforeFix.state === "agent_starting",
    beforeFix,
  );
  check(
    "after-fix-aggregate-converges-to-idle",
    afterFix.state === "agent_idle" && afterFix.agent === "codex",
    afterFix,
  );
}

// 5) 不回归 running 优先级:任一 panel 真在跑,整体仍是 running。
{
  const mgr = fakeManager([]);
  const rawPanels = [
    runningPanel("main", state("agent_running")),
    runningPanel("code-1", state("agent_starting")), // 僵尸,也会被收敛
  ];
  const convergedPanels = rawPanels.map((p) => ({
    ...p,
    terminalState: convergeStaleStartingWithoutLease(
      mgr,
      SID,
      p.id,
      p.terminalState,
    ),
  }));
  const agg = aggregatePanelTerminalState(convergedPanels);
  check(
    "running-priority-preserved",
    agg.state === "agent_running" && agg.agent === "codex",
    agg,
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed");
