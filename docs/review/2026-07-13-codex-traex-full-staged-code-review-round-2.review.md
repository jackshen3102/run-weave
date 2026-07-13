# Codex / TraeX capability parity 完整 staged diff 代码复审（Round 2）

## 结论

`case_14` **FAIL**，结论与 Round 1 相同。Round 2 prompt 的 `targetTree=60f062efc2eab57f31c47a56615c26b4a07ec440` 与 Round 1 位级相同，当前 index 与该 tree 无差异，工作树也没有 unstaged 源码修复。因此，本轮被审查代码没有包含 code pane 所声称的修复，原 3 个 P1 在重新执行最小验证后仍全部复现。

## Review checkpoint

- scope: `full`
- base commit: `798f25a22b2c28e8b9cdd7da9b528e712346b0e7`
- target tree: `60f062efc2eab57f31c47a56615c26b4a07ec440`
- requestedAt: `2026-07-13T04:32:51.493Z`
- staged paths: 40 个，与 prompt 完全一致
- `git diff --cached --exit-code <targetTree> --`: 通过
- `git diff --name-only`: 空；没有 unstaged 源码修复
- `git diff --cached --check`: 通过

## Remaining findings

### P1：迟到的 lifecycle observation 仍会覆盖当前 provider/thread

`backend/src/app-server/handlers/agent-lifecycle.ts:39-68` 仍未校验 session/panel 当前 owner。Round 2 最小执行验证从 `codex-current/codex` 开始，注入迟到的 `stale-traex-thread/traex` running observation 后，session 再次被覆盖成 `stale-traex-thread/traex`，并依次执行 running state、last thread、current thread 和 preview 清理写入。

修复方向：复用带 current-agent/current-thread guard 的共享 processor，或在写入前显式校验 provider、thread 和事件顺序；旧 thread 的观察不得覆盖更新的前台 owner。

### P1：fallback 恢复后仍保留 fallback 与真实 thread 两条记录

`app-server/src/state-store.ts:169-188` 仍使用真实事件的 `sourceInstanceId` 重建 fallback key，而 reconciler 的 source 与原 Hook source 不同。Round 2 最小执行验证仍返回：

```json
[
  {
    "threadId": "unknown-thread:traex:t:panel:hook-instance",
    "identityStatus": "unresolved"
  },
  { "threadId": "real-thread", "identityStatus": "resolved" }
]
```

`app-server/src/agent-thread-status-reconciler.ts:130-145` 仍排除 `unknown-thread:*`，没有 unresolved -> resolved 的独立 promotion/reattribution 流程。

修复方向：fallback identity 不得依赖生产者 instance；实现显式、幂等的 promotion，并覆盖不同 source instance 与 Activity reattribution。

### P1：unknown lifecycle 仍被错误映射为 idle

`app-server/src/agent-thread-status-reconciler.ts:178-193` 仍把 `detail.status !== "running"` 统一映射成 `idle`。Round 2 让 reader 返回 `status=unknown` 与 `future_lifecycle`，结果仍是 `observed.status=idle`。

修复方向：`unknown` 必须 no-op/保留现状；只有明确的完成或中断 lifecycle 才能收敛为 idle。

## Round 2 已执行检查

- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm toolkit:verify-hooks`：通过。
- `pnpm app-server:verify-state-sync`：通过。
- `pnpm agent-team:verify-review-checkpoints`：通过。
- stale owner、跨 source fallback、unknown lifecycle 三条最小 `tsx` 验证：均再次复现 P1。

静态门禁通过不能覆盖状态机错误。本轮仍不应启动 behavior worker。
