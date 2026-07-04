# Codex interrupt state reconciler 代码审查

## 结论

发现 1 个 P1。实现覆盖了计划中的主要结构：新增 backend reconciler、30 秒周期、3 小时窗口、独立 cursor id、running guard、只处理 `codex`、只从 `agent_running/codex` 收敛到 `agent_idle/codex`，并通过 `TerminalStateService.handleAgentHook()` 复用 `terminal_state_changed` 发布链路；但分页结束条件存在边界错误，会在特定事件分布下导致补偿永远不生效。

## 检查范围

- Run: `atr_fa85d437_20260704153009`
- Worker: `code_review`
- 代码 diff：`backend/src/app-server/codex-interrupt-state-reconciler.ts`、`backend/src/app-server/handlers/agent-event-payload.ts`、`backend/src/app-server/handlers/agent-hook.ts`、`backend/src/app-server/handlers/agent-completion.ts`、`backend/src/index.ts`
- 计划文件：`docs/plans/2026-07-04-codex-interrupt-state-reconciliation.md`

## 关键发现

### P1 严重：最后一页正好 500 条相关事件时，下一页空结果会丢弃本轮补偿并且不推进 cursor

`reconcileOnce()` 在每页拉取后，如果 `response.events.length === 0` 就直接 `return`。问题是上一页可能已经收集了 `latestBySession`，但因为上一页数量正好等于 `EVENT_PAGE_LIMIT`，且 `latestEventId` 是其它 kind 的全局最新事件，`reachedLatest` 不会在上一页变成 true，于是下一次 `listEvents({ after: finalCursor, kinds })` 会返回空数组。当前代码在空数组处直接返回，跳过后面的 `applyLatestStates()` 和 `cursorStore.write()`。

影响：本轮已经看到的 Stop / `hook_stop` 状态不会写回，cursor 也不会推进；下一轮会从同一个 cursor 重读同一批 500 条事件，形成稳定重试，导致目标 session 长期保持 `agent_running/codex`，正好破坏本功能要修复的中断后 running 卡住问题。这个场景在 App Server `latestEventId` 是全局 latest、而 `/events?kind=agent.hook&kind=agent.completion` 只返回过滤后列表时成立。

定位：`backend/src/app-server/codex-interrupt-state-reconciler.ts:149`、`backend/src/app-server/codex-interrupt-state-reconciler.ts:182`

修复方向：当 `response.events.length === 0` 且已有 `finalCursor` / `latestBySession` 时，不要 `return`；应 `break` 到统一 apply/write 阶段，或把空页作为 reachedLatest 处理。原则是：只要已经完整处理过一页事件，就必须进入 apply/write，除非本页拉取失败或处理抛错。

## 已确认点

- 筛选边界：候选 session 同时检查 `status === "running"`、`activeCommand` basename 为 `codex`、`lastActivityAt` 3 小时内、当前状态为 `agent_running/codex`。
- 状态收敛：`deriveCodexState()` 能识别 `UserPromptSubmit` 为 running、`Stop` 和 `hook_stop` completion 为 idle；实际写入只处理 `agent_idle`，没有从 idle/start 推 running。
- 发布链路：写入走 `TerminalStateService.handleAgentHook(session.id, "codex", "Stop", { reason: "agent_hook" })`，会复用现有 session store 与 `terminal_state_changed`。
- 生命周期：`backend/src/index.ts` 在 App Server integration 成功后启动 reconciler，shutdown 时停止 reconciler；现有 `AppServerEventConsumer` 仍使用原 consumer id。
- 集成边界：未修改 `packages/common`，未新增 App Server API，未修改 interrupt route，未新增测试文件。

## 验证摘要

- `pnpm --filter @runweave/backend typecheck`：通过
- `pnpm --filter @runweave/backend lint`：通过
- `git diff --check -- backend/src/app-server backend/src/index.ts`：通过
- 未执行浏览器/Playwright 行为验收；本 run 已分配独立 `behavior_verify` worker。

## 建议下一步

1. 让 code worker 修复空页分页逻辑，保证已处理页的状态和 cursor 能落盘。
2. 修复后重点验证“500 条满页 + latestEventId 属于其它 kind + 下一页空数组”的 cursor 推进场景。
3. 再由 behavior verifier 跑正向 Stop 补偿、`terminal_state_changed` 推送和负向边界用例。
