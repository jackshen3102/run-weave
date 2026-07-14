# Terminal Activity Work History · Round 122 Code Review

## 结论

`case_25` 通过。审查增量仅修改 `frontend/src/pages/activity/activity-policy-operations.tsx`，未发现 P0/P1 阻断问题。

本轮把 Data Policy 的直接删除入口改为 Radix `AlertDialog` 二次确认：外层 Delete 仅打开对话框，只有确认 action 才调用 `operation.mutate("delete")`。对话框展示当前 scope 类型和 ID，Cancel 不触发 mutation；空 ID 即使确认也会被现有 `mutationFn` 的 `Enter a scope ID` 校验拒绝。异步 pending 会禁用 Export/Delete，失败仍通过页面级 `operation.isError` 呈现，没有形成误删或重复提交链路。

## Review target

- scope: `incremental`
- baseCommit: `ad79a5e27ff8207df4dff7e7fc3749d7746bcc36`
- targetTree: `74b17d61f7a71768d372b6bc5979fb9e71738384`
- changedPaths: `frontend/src/pages/activity/activity-policy-operations.tsx`
- planSha256: `7d0ef294770bdbe3e3081ea32ccd2edcdee0bc46dc846051a9aad2319cbb8d42`
- testCaseSha256: `c92e190387c6a929239e61f960018b429d634053934ee61d045841df2d2210de`
- requestedAt: `2026-07-14T03:13:57.627Z`

## 影响与失败链路

- `ActivityPolicyOperations` 仍是 `PolicyPanel` 的唯一操作消费者，API 仍经 `executeActivityOperation` 调用 `/api/activity/operations`；本轮没有改变 DTO、请求体或 delete-job polling。
- Trigger (`frontend/src/pages/activity/activity-policy-operations.tsx:65-68`) 不再绑定 mutation；确认 action (`:79-85`) 是唯一新增删除触发点。
- Cancel 由 Radix `AlertDialogCancel` 关闭对话框，不调用业务回调。
- 确认 action 按 Radix 默认行为关闭对话框；请求失败时现有页面级错误 (`:90`) 可见，请求 pending 时两个入口均禁用，因此该行为不构成阻断问题。
- Round 120 已关闭的 `recheck-watchdog-active-runtime-timeout` 与 `agent-team-round-attribution-visibility` 位于 backend recheck / Agent Team history 模型链路，本轮单文件 Data Policy 增量不导入或修改这些路径，未发现结构性回归。

## 验证

- `git rev-parse HEAD` → `ad79a5e27ff8207df4dff7e7fc3749d7746bcc36`
- `git write-tree` → `74b17d61f7a71768d372b6bc5979fb9e71738384`
- `git diff --cached --name-only` → 仅目标文件
- `git diff --cached --check` → exit 0
- `pnpm activity:verify` → exit 0，16 项 Activity 数据基础检查通过
- `pnpm --filter @runweave/frontend typecheck` → exit 0
- `pnpm --filter @runweave/frontend lint` → exit 0
- `pnpm --filter @runweave/frontend build` → exit 0
- 独立检查既有运行证据 `.runweave/evidence/dvs-ff9854/agt-wh-021/runtime-observation.json`：确认前 `factCount=2`，Cancel 后仍为 2，确认后为 0；确认框含精确 project scope。

## Findings

无 remaining findings。AGT-WH-021 的删除确认保护缺失已由本增量关闭。
