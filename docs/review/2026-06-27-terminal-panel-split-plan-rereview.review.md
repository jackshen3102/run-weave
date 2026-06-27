# Terminal Panel Split 计划复审

评审对象：`docs/plans/2026-06-26-terminal-panel-split.md`

评审类型：计划评审复审，只读审阅。除本报告外未修改源码、配置、测试或计划文档。

## 结论

当前计划相比上一版已有明显收敛：tmux selected pane 同步、TerminalState session 级边界、alias/role 不进 pane env、恢复/迁移验收都已补进计划。tmux 原生 split 作为首期方向仍然成立。

但复审仍发现两个需要在实现前修正的方案矛盾：旧 `history/snapshot` 兼容路径的语义不清，以及 Orchestrator panel 绑定与 session 级 agent 状态边界冲突。建议先修计划再进入产品代码实现。

## 发现

- **P1 严重：旧 `GET /history` / `rw terminal snapshot` 被同时定义为 session-level 和 panel-routed，兼容语义冲突**。计划一方面保留 `GET /api/terminal/session/:id/history` 作为 session-level route，并写明 session-level `GET /history` 继续返回 attach/session scrollback；另一方面又把 `history` 放进 `resolvePanelTarget(...)` 的未指定 Panel 同步路径，后端验证项也要求 session-level input 未传 panel 时同步 selected pane 后路由 active/default panel。这会让旧 `rw terminal snapshot <session>` / `rw terminal history <session>` 到底返回 session scrollback 还是 selected panel capture 变得不确定，破坏旧客户端兼容。定位：`docs/plans/2026-06-26-terminal-panel-split.md:206`、`docs/plans/2026-06-26-terminal-panel-split.md:215`、`docs/plans/2026-06-26-terminal-panel-split.md:317`、`docs/plans/2026-06-26-terminal-panel-split.md:337`、`docs/plans/2026-06-26-terminal-panel-split.md:357`、`docs/plans/2026-06-26-terminal-panel-split.md:717`；代码现状：`packages/runweave-cli/src/commands/terminal.ts:102`、`packages/runweave-cli/src/commands/terminal.ts:146`、`packages/runweave-cli/src/client/terminal-http-client.ts:75`、`backend/src/routes/terminal.ts:333`、`backend/src/terminal/runtime-launcher.ts:477`。修复方向：把旧 `GET /session/:id/history` 和无 `--panel` 的 `rw terminal snapshot/history` 明确保留为原 session-level 语义，不进入 `resolvePanelTarget`；panel 级读取只走 `/panels/:panelId/history` 和 `rw terminal snapshot --panel/--role`。如果决定改变旧 history 语义，也必须把兼容风险和迁移策略写清楚，不能同时承诺两种行为。

- **P1 严重：Orchestrator role panel 绑定仍承诺过宽，和“首期不支持多 agent-active panel”冲突**。计划明确 `TerminalStateStore`、readiness、completion 等首期仍按 `terminalSessionId` 聚合，并且不支持同一 terminal session 内多个 agent-active panel 的独立状态；但阶段 5 又要求 Orchestrator worker 可以绑定到指定 role panel，`binding.mode === "new"` 还会为 role split panel。当前 Orchestrator 的 session resolver、prompt sender、agent readiness 都是 session 级：readiness 用 session state 和 session scrollback，prompt sender 对 tmux session target 发送。这意味着一旦多个 worker/role 复用同一个 tmux session 的不同 panel，worker 启动、prompt、completion/outbox 和状态判断都可能串到错误 pane 或被 session 级状态覆盖。定位：`docs/plans/2026-06-26-terminal-panel-split.md:421`、`docs/plans/2026-06-26-terminal-panel-split.md:432`、`docs/plans/2026-06-26-terminal-panel-split.md:519`、`docs/plans/2026-06-26-terminal-panel-split.md:676`；代码现状：`packages/shared/src/orchestrator.ts:87`、`backend/src/orchestrator/terminal/session-resolver.ts:30`、`backend/src/orchestrator/terminal/prompt-sender.ts:27`、`backend/src/orchestrator/terminal/agent-readiness.ts:43`、`backend/src/terminal/terminal-state-store.ts:3`。修复方向：首期二选一：要么把 Orchestrator panel binding 降级为“仅支持一个 agent-active panel，role panel 只用于显式单 worker 目标”，并在 create/reuse 时阻止同 session 多 agent panel；要么把 Orchestrator panel 绑定从首期移出，等 panel-keyed readiness、prompt sender、scrollback/outbox 设计补齐后再做。

## 已收敛点

- selected pane 反向同步已写入默认路由、tmux 实现和验收。
- TerminalState 已明确保持 session 级，不再承诺 panel chip 上的精确 completion/readiness。
- alias/role 不再写入 pane env，避免重命名后的陈旧事实源；且首期取消 Rename/Edit role。
- backend 重启、pane 外部删除、tmux session 丢失重建的恢复验收已补充。

## 更简单的替代方向

更小的首期可以只做“tmux panes 可寻址 + CLI/API 显式目标 + Web target bar”，暂缓 Orchestrator panel binding。这样仍能交付 split、focus、send、snapshot 和 UI chips，但避开 agent readiness、completion、outbox、prompt sender 全链路 panel 化的状态复杂度。代价是 Orchestrator 暂时继续使用独立 terminal session 作为 worker 隔离单元，panel 只服务手工/CLI 控制。

## 检查范围

- 阅读当前计划全文：`docs/plans/2026-06-26-terminal-panel-split.md`
- 抽查上一轮报告：`docs/review/2026-06-27-terminal-panel-split-plan.review.md`
- 抽查现有代码：
  - `backend/src/routes/terminal.ts`
  - `backend/src/terminal/runtime-launcher.ts`
  - `backend/src/terminal/tmux-service.ts`
  - `backend/src/terminal/terminal-state-store.ts`
  - `backend/src/terminal/terminal-state-service.ts`
  - `backend/src/orchestrator/terminal/session-resolver.ts`
  - `backend/src/orchestrator/terminal/prompt-sender.ts`
  - `backend/src/orchestrator/terminal/agent-readiness.ts`
  - `packages/shared/src/orchestrator.ts`
  - `packages/runweave-cli/src/commands/terminal.ts`
  - `packages/runweave-cli/src/client/terminal-http-client.ts`

## 验证摘要

- `git status --short` 显示计划、prototype 和两份 review report 为未跟踪文件；本次未改动被评审计划或源码。
- 未运行 typecheck/lint/Playwright，因为本次是计划复审，且产品代码尚未实现。

## 残余风险

- 未启动 HTML 原型做浏览器交互验收；本轮只评审计划与现有代码契约。
- 未检查原型视觉细节；本轮重点是方案与现有代码契约是否一致。
