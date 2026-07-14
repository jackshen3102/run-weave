# Terminal Activity Work History Code Review（Round 120）

## 结论

`case_25` 不通过。休眠导致 recheck 误超时与 AGT-WH-015 归属来源不可见两个回归点已关闭，但失败链路仍有 1 条 P1：behavior worker readiness 失败时，serial dispatch 在持久化新 dispatch 之前抛错，run 留在 `running + activeWorkerRole=code_review + activeWorkerDispatch=null`，无法继续 behavior 或进入人工处理。另有 1 条非阻断 P2：完成态 run 的 watchdog 内存时钟未清理。

## Review checkpoint

- scope：`incremental`
- baseCommit：`1faef9862e94bc93dc44fae4dd01fd796e0158b1`
- targetTree：`5f0c6c0ade05b045d1c614248b41e5d2d506c642`
- changedPaths：6 个，与 prompt/run package 完全一致
- planSha256：`7d0ef294770bdbe3e3081ea32ccd2edcdee0bc46dc846051a9aad2319cbb8d42`
- testCaseSha256：`c92e190387c6a929239e61f960018b429d634053934ee61d045841df2d2210de`
- requestedAt：`2026-07-14T02:21:57.392Z`
- `HEAD`、staged tree、文档哈希与 diff check 均精确匹配。

## 已关闭的回归点

1. Recheck watchdog 改为按同一 dispatch 的连续实际观察时间累计。独立时钟探针确认：首轮不超时，连续观察满 1 小时才超时；40 秒间隔不计入；dispatch 切换清除旧 key；无 active case 清空当前 run 的 key。
2. Agent Team Journal 将既有 `round` 和 `attributionSource` 透传到 fact selection。E1-E3 展示对应归属来源；E4 继续留在 Unassigned events，并在卡片与 Inspector 明确显示 `attributionSource=unavailable`，未修改归属算法或共享 DTO。

## Remaining findings

- **P1** readiness 失败会把 serial gate 留在无 dispatch 的运行态：Round 120 通过后，Backend 尝试对替换后的 behavior pane 调用 `ensureAgentReady`；该调用超时并从 watchdog completion 链抛出，但 `dispatchSerialWorker` 尚未持久化 behavior role/dispatch，也没有把异常转换为 `need_human`。真实 run 自 `2026-07-14T02:28:57.436Z` 起保持 `status=running`、`activeWorkerRole=code_review`、`activeWorkerDispatch=null`；Backend 日志明确记录 `Timed out waiting for agent-team agent "codex" to start`。修复方向是在 readiness 失败时 fail closed 到可恢复状态（至少 `need_human` + frozen + reason），或在 readiness 前持久化可由 watchdog 恢复的 dispatch boundary。定位：`backend/src/agent-team/service-recheck.ts:62-103`，消费者 `backend/src/agent-team/service-serial-dispatch.ts:98-146`。
- **P2** 完成态 run 的 watchdog clock entry 不会释放：`runRecheckWatchdog` 对非 `executing/running` run 在调用清理函数前直接跳过；生命周期探针得到 `before=1, after=1`。长生命周期 Backend 会按曾进入 recheck 且随后结束/人工暂停的 run 数量缓慢保留 Map 条目。修复方向是在跳过非运行态时清理该 run，或在 run 状态转换/服务级 sweep 中统一 prune。定位：`backend/src/agent-team/service-recheck.ts:68-71,109-145`。

## 独立验证

- Watchdog 连续时钟、gap、dispatch 切换、无 active case 探针：通过。
- 完成态生命周期清理探针：确认 P2，`before=1, after=1`。
- 真实 Round 120 failure-chain：run package 显示 `running/code_review/null dispatch`；Backend 日志显示 behavior readiness timeout 从 watchdog completion 链抛出，确认 P1。
- Code Agent 的隔离 Beta/desktop Playwright 证据：E4 卡片与 Inspector 均显示 `unavailable`，console error 为 0，Dev Session 已清理。
- `pnpm agent-team:verify-review-checkpoints`：通过。
- `pnpm work-history:verify`：通过。
- `pnpm activity:verify`：通过。
- `pnpm typecheck`、`pnpm lint`、`pnpm build`：通过。
- 增量 `git diff --check`：通过。
