# Runweave Dev Session Loop Round 9 代码复审

## 结论

`case_24` 通过。本轮未发现仍未修复的 P0/P1。Round 8 的 stale Session 恢复指引缺失已修复：status 和普通 stop 会返回包含 stale service、identity drift 原因、logPath、三步安全说明与精确 cleanup 命令的 recovery；显式 `stop --cleanup-stale` 只停止当前 manifest 中 identity 仍匹配的 dedicated 服务，跳过 drift identity，并保留 shared 服务。

## 复审依据

- **恢复指引可执行且可追溯。** `scripts/dev-session/cli.mjs:135-153` 生成固定 Session ID 的 cleanup 命令，并逐项列出 stale service、原因和 logPath；Session ID 已由 CLI 合约校验，不存在命令拼接歧义。
- **Status 持久化 recovery。** `scripts/dev-session/cli.mjs:263-295` 仅在 ready Session 检出 drift 后转为 stale，并把 recovery 写入公开 manifest 的 failure；其他 Session manifest 不参与修改。
- **普通 stop 继续 fail closed。** `scripts/dev-session/cli.mjs:360-393` 在 ownership inspection 失败时拒绝停止，保存 recovery，并把同一 recovery 提升到 CLI error details。
- **Cleanup 必须显式且只接受 stale。** `scripts/dev-session/cli.mjs:315-358` 仅在 `stop --cleanup-stale` 且 manifest.state 为 stale 时进入清理；整个过程持有当前 Session lock，失败会恢复 stale 状态。
- **停止前后双重 identity 校验。** `cleanupStaleSessionServices()` 先做完整 Backend/App Server/Electron/process handshake；实际 kill 前 `stopOwnedProcess()` 再比较 PID 的 processSignature，避免检查后 PID 漂移导致误杀。
- **Shared 与 drift 均不进入停止分支。** `scripts/dev-session/services.mjs:1645-1695` 只遍历 dedicated 服务；health 非 live 标记 `skipped-stale-identity`，shared 只记录 `sharedServicesPreserved`。

## Findings

### P0/P1

无。

### 已修复

- **P1 resolved — stale status/stop 缺少 cleanup 和恢复指引。** Recovery 现在包含精确命令、步骤、安全边界、drift 原因和 logPath。
- **P1 resolved — Terminal Browser blank target 缺少 renderer/document。** 新 view 立即加载 `about:blank`，CDP Page/Runtime 初始化链保持完整。
- **P1 resolved — Backend profile lock live-partial 双 owner。** Create/update 原子发布、unknown fail-closed 与 identity-safe 回收保持有效。

## 验证证据

- **临时进程级 cleanup 复验。** 正确签名的 dedicated frontend 被停止；伪造签名的 backend 被标记 `skipped-stale-identity`，当前审查进程仍存活；shared App Server 被列入 preserved。
- 临时进程输出：`{"childStillLive":false,"currentReviewerStillLive":true,"stoppedServices":["frontend"],"sharedServicesPreserved":["appServer"],"frontendCleanupStatus":"stopped-identity-verified","backendCleanupStatus":"skipped-stale-identity"}`。
- `pnpm dev:session:verify`：通过，21 项 checks 包含 `stale-session-recovery-guidance`、`status-stop-serialization`、`stale-session-preservation`。
- `pnpm typecheck`：通过，9 个 workspace project 完成。
- `pnpm lint`、目标 ESLint、3 个 Node syntax check、`git diff --check -- . ':(exclude)docs/review'`：全部通过。

## 残余验证边界

本轮是代码复审，没有替代后续 `behavior_verify` 的跨 worktree 真实进程强退、cleanup 和 B Session 保持验收。该运行时复验应由 backend 按 DVS-018 继续执行，不构成当前未修复的 P0/P1。
