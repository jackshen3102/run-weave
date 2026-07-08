# agent-team-loop-flow（Agent Team / Loop Engine 流程图）

Agent Team / Loop Engine 端到端流程的可视化梳理，聚焦**流程本身**与**loop 如何闭环**。

- **性质**：一次性设计梳理产物，冻结后不回头改。
- **不代表实现细节**：以线上代码与 `docs/architecture/multi-agent-orchestrator.md`、`docs/architecture/terminal-completion-hooks.md` 为准。
- **本地预览**：`python3 -m http.server --directory docs/prototypes/agent-team-loop-flow`，浏览器打开 `http://localhost:8000`。

## 图里讲了什么

1. 生命周期状态机：`intake → executing → done`（前端默认 `autoApproveSplit=true`，跳过 proposal 人工门），含熔断/恢复/失败旁路。
2. 起手流程：`startRun → applySplit`（为每个 worker split tmux pane）；`autoApproveSplit=false` 时才多一道 `submitSplitGate` 人工确认。
3. 核心 loop：completion hook 发条 → service 接线 → 串行调度 `code→code_review→behavior_verify` → `foldRound` 折叠 → 三个出口（done / 继续 / 熔断）。
4. 人工恢复 `resumeRun(note)` 与复验看门狗。
5. 关键 loop 参数与设计取舍（debounce=2、熔断=3）。

## 代码源

- `backend/src/agent-team/service.ts`（`startRun` / `applySplit` / `handleTerminalEvent` / `applyRound` / `resumeRun` / recheck watchdog）
- `backend/src/agent-team/loop.ts`（`foldRound` / `shouldEscalate` / `fingerprintFailure`）
- `backend/src/agent-team/prompt-builders.ts`（worker startup / bounce-back / recheck / human-note prompt）
- `packages/shared/src/agent-team.ts`（数据模型）
