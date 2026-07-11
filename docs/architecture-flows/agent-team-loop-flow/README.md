# agent-team-loop-flow（Agent Team / Loop Engine 流程图）

Agent Team / Loop Engine 端到端流程的可视化梳理，聚焦**流程本身**与**loop 如何闭环**。

- **性质**：随 main loop 代码演进更新的流程图；代码有大改动时同步修订，力求与实现一致。
- **不代表实现细节**：以线上代码与 `docs/architecture/multi-agent-orchestrator.md`、`docs/architecture/terminal-completion-hooks.md` 为准。
- **本地预览**：`python3 -m http.server --directory docs/architecture-flows/agent-team-loop-flow`，浏览器打开 `http://localhost:8000`。

## 图里讲了什么

1. 生命周期状态机：`intake → executing → done`（前端默认 `autoApproveSplit=true`，跳过 proposal 人工门），含验收来源前置门、熔断/恢复/失败旁路。
2. 起手流程：`startRun` 先解析验收来源（`verification`）——没有可追溯测试案例文件时停在 `intake`，注入 `buildMainTestCaseGenerationPrompt` 让主 Agent 跑 `$toolkit:write-test-cases` 写 `docs/testing/*-test-cases.md` 再回调 `propose-split`；有可追溯用例才 `applySplit`（为每个 worker split tmux pane，并 `assertTraceableBehaviorAcceptance` 校验用例可追溯）。`autoApproveSplit=false` 时才多一道 `submitSplitGate` 人工确认。
3. 核心 loop：completion hook 发条 → service 接线 → 串行调度 `code→code_review→behavior_verify`（verify 默认只局部重跑失败/未执行/依赖 case）→ `foldRound` 折叠（含 `pass|fail|skipped`）→ 三个出口（done / 继续 / 熔断）。
4. 人工恢复 `resumeRun(note)` 与复验看门狗。
5. 关键 loop 参数与设计取舍（debounce=2、熔断=3、验收用例必须可追溯）。

## 代码源

- `backend/src/agent-team/service.ts`（`startRun` / `prepareInitialAcceptance` / `applySplit` / `handleTerminalEvent` / `applyRound` / `resumeRun` / recheck watchdog）
- `backend/src/agent-team/acceptance-case-loader.ts`（从 `docs/testing/*-test-cases.md` 解析可追溯验收用例）
- `backend/src/agent-team/loop.ts`（`foldRound` / `shouldEscalate` / `fingerprintFailure`）
- `backend/src/agent-team/prompt-builders.ts`（main test-case generation / worker startup / bounce-back / recheck / human-note prompt）
- `packages/shared/src/agent-team.ts`（数据模型，含 `AgentTeamVerificationConfig`）
