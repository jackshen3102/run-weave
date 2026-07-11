# Runweave Dev Session Loop Round 5 代码复审

## 结论

`case_24` 通过。本轮未发现仍未修复的 P0/P1。Round 4 的 Backend profile lock live-partial 双 owner 竞态已按根因修复：create 在私有 candidate 中完整写入 owner、chmod、fsync 后，以 hard link no-replace 原子发布 canonical lock；update 在 owner/inode 复核后通过 rename 原子替换，不再 truncate canonical；无法解析的 lock 永久 fail closed。

## 复审依据

- **Create 只暴露完整 owner。** `backend/src/server/profile-lock.ts:115-143` 先完成 candidate 写入与 fsync，再通过 `link(candidate.path, lockFile)` 发布；返回前复核 candidate/canonical 的 `dev/ino`。
- **Update 不再产生 partial canonical。** `backend/src/server/profile-lock.ts:146-190` 在 candidate 完整落盘后复核当前 owner 与 inode，再用 rename 原子替换；`this.owner` 仅在替换成功后更新。
- **Unknown lock fail closed。** `backend/src/server/profile-lock.ts:90-109` 对无法解析的 lock 直接返回 `BackendProfileLockConflictError`，旧的 10 秒 mtime 回收分支已删除。
- **释放与 stale 回收绑定 identity。** `backend/src/server/profile-lock.ts:62-74,261-278` 只有当前 `dev/ino` 与读取快照一致时才删除 canonical；路径已变化时保留新 owner。
- **Round 4 原失败已反转。** creator 创建空 canonical lock 并保持存活 10.2 秒后，竞争者返回 `acquired=false`、`conflict=true`、`owner=null`。
- **Stale owner 并发回收稳定。** 200 轮真实 Lock API 双竞争者压力执行中，`doubleAcquired=0`、`rawEnoent=0`、`otherRejected=0`；每轮一个 owner 成功，另一个得到结构化 conflict。

## Findings

### P0/P1

无。

### 已修复

- **P1 resolved — live creator 的部分 Backend profile lock 被错误回收。** Create/update 均只发布完整 owner，unknown canonical 永久 fail closed。
- **P1 resolved — Backend profile 冲突只返回通用 readiness 超时。** Dedicated Backend 继续返回 exit code 5、resource、requested/owner identity 与 remediation。
- **P1 resolved — Dev Session port lease 的 live-partial 双 owner 竞态。** 独立 per-port lease 的原子发布和 inode 复核保持有效。

## 验证证据

- `pnpm dev:session:verify`：通过，20 项 checks 包含 `atomic-backend-profile-lock`、`backend-profile-conflict-attribution`、`stale-port-lease-aba`。
- Round 4 原复现：`{"liveCreatorStillRunning":true,"competitorResult":{"acquired":false,"conflict":true,"owner":null}}`。
- 200 轮 stale-owner 并发：`{"doubleAcquired":0,"rawEnoent":0,"conflicts":200,"otherRejected":0}`。
- `pnpm typecheck`：通过，9 个 workspace project 完成。
- `pnpm lint`、目标 ESLint、`node --check scripts/verify-dev-session.mjs`、`git diff --check -- . ':(exclude)docs/review'`：全部通过。

## 残余验证边界

本轮为代码复审，没有替代后续 `behavior_verify` 的真实 DVS-005 双 Session 启动、回滚与既有 Session 保持验收。本地 `main` 仍落后 `origin/main` 2 个提交；后续同步 `frontend/src/App.tsx` 时需保留 upstream 路由契约。上述事项不是当前未修复的 P0/P1。
