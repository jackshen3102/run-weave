# Terminal Panel Agent 活动租约 Round 9 代码审查

## 结论

AGT-REVIEW-GATE 通过。本轮未发现 open P0/P1；Round 8 暴露的 AR-GRACE-006 响应契约缺口已修复。唯一 running Panel 的 legacy Stop 被 processor 解析并 recorded 后，HTTP body 现在返回与结构化日志一致的 resolved `panelId`，且没有新增 Session-scope 重复 activity。

## 审查边界

- Round 9 直接增量：`backend/src/routes/terminal-state.ts` 与 `packages/shared/src/terminal/events.ts` 各新增一行。
- 关联路径：`processTerminalAgentHook` 的 resolved Panel result、内部 hook HTTP response、共享响应类型及现有消费者。
- 独立检查：审阅 Round 8 真实失败证据、Round 9 同 scenario/validation session 的真实产品 After 证据、全仓消费者搜索及 backend/shared 静态门禁。
- 排除：工作树中与 AR-GRACE-006 修复无关的既有 Agent Team 和 Terminal activity lease 改动。
- 本轮只评审，不修改业务代码，不重复启动 Dev Session。

## Findings

无 open P0/P1。

## 已关闭 Finding

### P1：legacy Stop recorded 响应缺少 resolved Panel ID

稳定 invariant key：`terminal.legacy-stop-response-panel-id`。

Round 8 的真实单 Panel 场景中，processor 与日志已正确解析唯一 Panel，但 HTTP body 丢弃了 `result.panelId`。Round 9 在 recorded response 直接返回该既有结果字段（`backend/src/routes/terminal-state.ts:187-200`），共享 `AgentHookStateResponse` 以可选字段表达向后兼容响应（`packages/shared/src/terminal/events.ts:210-220`）。改动没有重新实现 Panel 推断，也没有扩大状态写入路径。

同一 `scenarioId=AR-GRACE-006-single-panel-legacy-stop-response-panel-id`、`validationSessionId=dvs-2f895c` 的真实产品 After 结果为：HTTP 202 `recorded`，body 与 backend log 均返回 `94979b56-a5f1-454a-ba0e-efbbe2dde6f5`；活动投影仍只有一条 Panel-scoped 记录，Session-scope 重复数为 0。

## 回归与消费面

- `AgentHookStateResponse` 当前仅由内部 terminal-state hook 路由返回；仓库内未发现依赖 recorded/exited 精确对象键集合的消费者。
- `panelId` 为可选字段，现有调用方保持兼容；ignored 分支形状未变化。
- Round 8 已在真实产品中验证 AR-GRACE-001 至 AR-GRACE-005，最新修复仅增加响应字段与共享类型，不改变其 Panel/grace/operation 判定路径。
- Round 7 的 `terminal.stop-grace-expiry-command-name-bypass` 修复仍保留在当前 diff；本轮未发现回退。

## 独立检查

- `rg -n "AgentHookStateResponse|disposition.*recorded|panelId.*disposition" backend frontend app electron packages scripts`：消费面仅命中共享类型与内部路由。
- `pnpm --filter ./backend typecheck`：通过。
- `pnpm --filter ./backend lint`：通过。
- `pnpm --filter ./packages/shared typecheck`：通过。
- `git diff --check`：通过。
- Round 9 两文件 diff SHA-256：`112e43bbd5ce17819ef9d16f5dfb5b2c6289c75e7ae4f4f8258026ebdb3efa64`。

## 验证边界

本轮未重复启动真实产品环境；运行时结论来自 Code Agent 在修复前后使用同一 scenarioId 和 validationSessionId 保存的真实 Beta desktop 证据。本轮独立复核了原始 JSON、源码数据流、消费面和静态门禁。
