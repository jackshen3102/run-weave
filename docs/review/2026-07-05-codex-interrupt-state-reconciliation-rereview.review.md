# Codex interrupt state reconciler 复审

## 结论

case_6 仍未通过。上一轮指出的分页空页 P1 已修复：`response.events.length === 0` 现在会 `break` 到统一的 apply/write 阶段，不再提前 `return`。但当前 diff 仍有 1 个 P1，会导致 code pane 修复完成后复验调度卡死。

## 检查范围

- Run: `atr_fa85d437_20260704153009`
- Worker: `code_review`
- 代码 diff：`backend/src/agent-team/service.ts`、`backend/src/agent-team/outbox-resolver.ts`、`backend/src/agent-team/prompt-builders.ts`、`backend/src/app-server/codex-interrupt-state-reconciler.ts`、`backend/src/app-server/handlers/agent-event-payload.ts`、`backend/src/app-server/handlers/agent-hook.ts`、`backend/src/app-server/handlers/agent-completion.ts`、`backend/src/index.ts`、`packages/shared/src/agent-team.ts`

## 关键发现

### P1 严重：初次复验投递失败只记录 warn，case 不会进入 retry/watchdog

`dispatchBouncedCasesForRecheck()` 在 code pane 完成后调用 `sendRecheckToWorker()`。这个调用会先 `ensureAgentReady()`，再 `sendPromptToPane()`，两者都可能因 pane 不存在、tmux target 解析失败、Codex UI 启动超时或 send-key 失败而抛错。当前 catch 只写 warn，没有把相关 case 标记为 `pending`，也没有调用已有的 `markRecheckDispatchFailed()`。

影响：这些 case 仍保持 `status="fail"` 且 `bouncedToPanelId` 指向 code pane。因为没有 `recheckRequestedAt`，`findRecheckWatchdogCases()` 不会选中它；因为 `bouncedToPanelId` 未清空，后续 `isUnbouncedFailCase()` 也不会重新 bounce。结果是 run 保持 `running`，但不会再自动触发 review/behavior worker，也不会升级人工，正好卡住本轮要修的“修复后重新审查/验收”链路。

定位：

- `backend/src/agent-team/service.ts:771`
- `backend/src/agent-team/service.ts:782`
- `backend/src/agent-team/service.ts:793`
- `backend/src/agent-team/service.ts:814`
- `backend/src/agent-team/service.ts:825`

修复方向：初次 dispatch catch 中也应对 `dispatch.cases` 调用 `markRecheckDispatchFailed()`，或等价地写入 `pending + recheckRequestedAt + recheckAttempt`，让 watchdog 能按现有 retry/exhaust 逻辑推进。不要只记录日志后返回原 run。

## 已确认修复点

- 上一轮分页 P1 已修复：空事件页现在设置 `reachedLatest` / `finalCursor` 后 `break`，随后执行 `applyLatestStates()` 和 cursor write。
- `AgentTeamOutboxResolver` 会归一化 legacy outbox，并限制 evidence type 到 `text` / `dom` / `screenshot`。
- review worker 启动 prompt 和 recheck prompt 已明确要求写 pane-scoped outbox 顶层字段与 `acceptanceResults`。

## 验证摘要

- `git diff --check`：通过
- `pnpm --filter @runweave/backend typecheck`：通过
- `pnpm --filter @runweave/backend lint`：通过
- 未执行 Playwright；本次是代码审查 gate，不是浏览器验收。

## 建议下一步

1. 修复初次复验 dispatch catch，确保投递失败进入 retry/watchdog 或人工升级路径。
2. 修复后重点复查：code pane 完成、review pane 不存在/不可达、`ensureAgentReady()` 超时这三类路径。
