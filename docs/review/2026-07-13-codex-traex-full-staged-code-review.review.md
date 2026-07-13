# Codex / TraeX capability parity 完整 staged diff 代码审查

## 结论

`case_14` **FAIL**。目标 staged tree 与 review checkpoint 一致，`typecheck`、`lint`、Hook、App Server state sync 和 review checkpoint 验证均通过，但完整 diff 仍有 3 个 P1 正确性问题。当前不能进入 behavior verification。

## Review checkpoint

- scope: `full`
- base commit: `798f25a22b2c28e8b9cdd7da9b528e712346b0e7`
- target tree: `60f062efc2eab57f31c47a56615c26b4a07ec440`
- staged paths: 40 个，与 review prompt 完全一致
- whitespace: `git diff --cached --check` 通过

## Remaining findings

### P1：迟到的 lifecycle observation 会覆盖当前已切换的 provider/thread

`backend/src/app-server/handlers/agent-lifecycle.ts:39-68` 在找到 session 后直接调用 `setAgentRunning` / `setAgentIdle` 和 `syncAgentThreadMetadata`，没有像既有 `processTerminalAgentHook` 一样校验当前 active command、panel owner、`threadProvider` 与 `threadId`。因此，用户从 TraeX thread A 切到 Codex thread B 后，A 的迟到 reconcile 事件仍可把 session 改回 A。

最小执行验证以 `threadId=codex-current, threadProvider=codex` 开始，注入 `source=traex, correlationId=stale-traex-thread, observedStatus=running` 后，session 变成 `threadId=stale-traex-thread, threadProvider=traex`，同时写入 TraeX running state。

修复方向：把 lifecycle observation 复用到带 current-agent/current-thread guard 的共享 processor，或在修改 session/panel 前显式校验 provider、thread 和事件顺序；迟到事件只应更新其自身 App Server thread/Activity，不得覆盖更新的前台 owner。

### P1：fallback 到真实 thread 的恢复不能保证收敛为单一记录

`app-server/src/state-store.ts:169-188` 删除 fallback 时重新用“真实事件的 `sourceInstanceId`”构造 fallback key；但 fallback Hook 的 source instance 与 `app-server/src/agent-thread-status-reconciler.ts:213-238` 生成 observation 时的 App Server instance 不同。最小执行验证先写入 `unknown-thread:traex:t:panel:hook-instance`，再写入 `real-thread`（source=`app-server-instance`），`listThreads()` 仍同时返回两条记录。

此外，reconciler 在 `app-server/src/agent-thread-status-reconciler.ts:130-145` 明确排除 `unknown-thread:*`，因此没有独立的 unresolved fallback promotion 路径；恢复也不会重写此前 threadId 为空的 Activity facts。这违反 AGT-TRAE-005 的“恢复后只有一个权威 thread，Terminal、Activity、App Server 都改用真实 ID”。

修复方向：使用不依赖生产者 instance 的稳定 fallback identity，并为 unresolved -> resolved 建立显式、幂等的 promotion/reattribution 流程；补充“不同 source instance”覆盖，不能只测同一 Hook source 后来补 correlationId。

### P1：未知 lifecycle 被映射为 idle，可能伪造状态迁移

`app-server/src/agent-thread-status-reconciler.ts:178-193` 将 `detail.status` 除 `running` 外的所有值都映射为 `idle`。最小执行验证让 reader 返回 `detail.status=unknown` 和 `future_lifecycle`，reconciler 产出的 observation 是 `status=idle`。若当前 thread 为 running，这会生成错误补偿并由 Backend 清理 current thread，违反 AGT-TRAE-006 的“未知事件保留 raw 且不臆造状态迁移”。

修复方向：`unknown` 必须 no-op/保留现状；只允许明确的 `task_complete` 与 `turn_aborted` 收敛到 idle，并保留 `interrupted` detail。

## 已执行检查

- `git cat-file -t 60f062efc2eab57f31c47a56615c26b4a07ec440` + `git diff --cached --exit-code <targetTree> --`：target tree 匹配。
- `git diff --cached --check`：通过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm toolkit:verify-hooks`：通过。
- `pnpm app-server:verify-state-sync`：通过；现有 fallback case 使用同一 source，未覆盖上述跨 source 缺陷。
- `pnpm agent-team:verify-review-checkpoints`：通过。
- 3 条最小 `tsx` 验证分别复现 stale owner 覆盖、fallback 双记录和 unknown -> idle。

## 验证边界

本轮是只读代码审查，没有执行 `$toolkit:playwright-cli` 或 Dev Session 行为验收。由于仍有 P1，按串行门禁不应启动 behavior worker。
