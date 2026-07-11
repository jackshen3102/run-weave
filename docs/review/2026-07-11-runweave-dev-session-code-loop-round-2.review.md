# Runweave Dev Session Loop Round 2 代码复审

## 结论

`case_24` 通过。本轮未发现仍未修复的 P0/P1。Round 1 的 live partial port lease 双 owner 竞态已按根因修复：owner payload 先在私有临时文件中完整写入并 fsync，再通过 hard link 的 no-replace 语义原子发布 canonical lease；发布者返回前还会复核 canonical inode。空或损坏的 legacy canonical lease 现在 fail closed，不再按 5 秒 mtime 猜测回收。

## 复审依据

- **Canonical lease 只暴露完整 payload。** `scripts/dev-session/registry.mjs:375-413` 在随机私有 candidate 文件完成 owner JSON、0600 和 fsync 后才调用 `link(candidatePath, lockPath)`；竞争者不会观察到当前实现产生的空 canonical 文件。
- **发布者返回前复核 ownership。** `scripts/dev-session/registry.mjs:414-420` 比较 candidate 与 canonical 的 `dev/ino`，identity 不一致会 fail closed；成功后只删除 candidate 名称，canonical hard link 继续持有同一 inode。
- **异常与释放清理绑定 inode。** 发布失败、发布后校验失败和正常 release 均通过 `removeFileNoFollow(..., expectedStats)` 删除，路径被替换时不会误删其他 owner。
- **Partial/损坏 lease 保守处理。** `scripts/dev-session/registry.mjs:449-457` 只有完整且合法的 owner 才允许按 PID 判断 stale；无法解析的 canonical lease直接返回 `null`，不再按时间删除。
- **原失败复现已反转。** 子进程创建空 `6210.lock` 并保持存活 5.2 秒后，竞争者返回 `competitorAcquired=false`。
- **真实跨进程互斥成立。** 两个独立 Node 进程同时争抢 6211，结果为 `acquiredCount=1`，另一个进程返回 `acquired=false`。

## Findings

### P0/P1

无。

### 已修复

- **P1 resolved — live creator 的部分 lease 被错误回收。** Canonical lease 已改为完整 payload 原子发布，旧的 5 秒 partial 回收分支已删除。
- **P1 resolved — root 级长锁导致不同 Session 串行。** Per-port lease 保持不同端口并行，不重新引入全局 readiness 临界区。
- **P1 resolved — 已写 owner 的 stale lease ABA。** Stale 回收继续绑定 `dev/ino`，并发竞争时不会删除新的 live owner。

## 验证证据

- `pnpm dev:session:verify`：通过，18 项 checks 包含 `atomic-port-lease-publication`、`stale-port-lease-aba`、`partial-port-lease-fail-closed`。
- `pnpm typecheck`：通过，9 个 workspace project 完成。
- `pnpm lint`：通过。
- `pnpm exec eslint scripts/dev-session/registry.mjs scripts/verify-dev-session.mjs`：通过。
- `node --check scripts/dev-session/registry.mjs`、`node --check scripts/verify-dev-session.mjs`：通过。
- `git diff --check -- . ':(exclude)docs/review'`：通过。

## 残余验证边界

本轮是代码复审，没有替代后续 `behavior_verify` 对完整 DVS 用例的真实进程、浏览器和桌面验收。本地 `main` 仍落后 `origin/main` 2 个提交；后续同步 `frontend/src/App.tsx` 时应保留 upstream 四段 prototype 路由并合入现有 Dev Session guard。上述事项不是当前未修复的 P0/P1。
