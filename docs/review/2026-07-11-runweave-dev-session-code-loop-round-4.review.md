# Runweave Dev Session Loop Round 4 代码复审

## 结论

`case_24` 不通过。Round 3 的 Backend profile lock 冲突归因已修复，但同一 lock 实现仍存在 1 个 P1：canonical `backend.lock.json` 在 owner payload 完整写入前就对外可见，无法解析的 lock 超过 10 秒会被当作 stale 删除。独立复现确认 creator 进程仍存活时，竞争者可以成功取得同一 profile lock，两个 Backend 随后都可能使用同一 profile。

## P1 阻断问题

1. **Live Backend creator 的部分 profile lock 会在 10 秒后被错误回收。** `tryCreateLockFile()` 先对 canonical lock 执行 `open("wx")`，再异步写 owner JSON；`acquireBackendProfileLock()` 对无法解析的 owner 仅保留 10 秒，随后直接 unlink 并重试。若 creator 在 open/write 或 `BackendProfileLock.update()` 的 truncate/write 窗口暂停超过 10 秒，竞争者无法识别其 PID，却会删除 lock 并成为新 owner；原 creator 恢复后仍会返回成功，导致两个 Backend 共享同一 browser profile，重新违反 DVS-005 的互斥与隔离契约，并可能造成状态串扰或文件损坏。定位：`backend/src/server/profile-lock.ts:49-60,80-115,118-143`。修复方向：复用已在 port lease 验证过的完整临时文件 + fsync + no-replace 原子发布；更新 owner 时也使用 identity-safe 原子替换。无法解析的 canonical lock 必须 fail closed，不能仅按 mtime 删除可能仍由 live creator 持有的半成品。

## 已修复项

- **P1 resolved — Backend profile 冲突只返回通用 readiness 超时。** Dedicated Backend 现在在 spawn 前和 readiness 期间识别 live owner，并以 exit code 5 返回 `conflict.resource`、requested/owner identity 与 remediation。
- **P1 resolved — 旧 lock 缺少 devSessionId 时无法归因 Session。** 旧 owner 可通过 manifest 的 Backend `serviceInstanceId + pid` 回查所属 Session。
- **P1 resolved — port lease 的 live partial 双 owner 竞态。** Dev Session per-port lease 已使用完整 candidate、fsync、hard-link no-replace 与 inode 复核原子发布；本发现位于独立的 Backend profile lock 实现。

## 验证证据

- **新 lock 结构化归因通过。** 临时 profile 中注入 live owner 后，`startSessionServices()` 返回 `DevSessionError`、exit code 5、`type=backend-profile-lock`、requested/owner Session、owner PID、lockPath 与 `pnpm dev:stop --session dvs-owner`。
- **Live partial profile lock 复现失败。** creator 以 `wx` 创建空 `backend.lock.json` 后保持存活；等待 10.2 秒，竞争者调用真实 `acquireBackendProfileLock()`，exit code 0 并返回新 owner。输出包含 `liveCreatorStillRunning=true`、`competitorExitCode=0`、`acquired=true`。
- `pnpm dev:session:verify`：通过，19 项 checks 全部通过；现有 `backend-profile-conflict-attribution` 只覆盖完整 owner，没有覆盖 live creator 的部分 profile lock。
- `pnpm typecheck`、`pnpm lint`、目标脚本 ESLint、Node syntax 与 `git diff --check -- . ':(exclude)docs/review'`：全部以 0 退出。

## 验证边界

本轮是代码复审，没有执行后续浏览器/桌面 behavior verification。P1 修复后应新增 Backend profile lock 原子发布/partial fail-closed 回归，再由 backend 触发下一轮 code review；当前静态门禁通过不能覆盖已独立复现的双 owner 竞态。
