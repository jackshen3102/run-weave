# Runweave Dev Session Loop Round 1 代码复审

## 结论

`case_24` 不通过。当前未发现 P0，但仍有 1 个未修复 P1：per-port lease 在 canonical 文件创建后才写入 owner payload；live creator 若在这段窗口暂停超过 5 秒，竞争者会把空 lease 当 stale 删除并取得同一端口。当前 code pane 没有产生覆盖该问题的新源码修改，独立复现仍得到 `liveCreatorStillRunning=true`、`competitorAcquired=true`。

## P1 阻断问题

1. **Live creator 的部分 lease 会在 5 秒后被错误回收。** `acquireServicePortLease()` 先以 `O_CREAT | O_EXCL` 创建 canonical `port.lock`，随后才写 owner JSON；另一进程读到空 payload 时只保护 5 秒，超时后即按 inode 删除文件。创建者仍持有已 unlink 的 fd，恢复后会继续写入并直接返回成功 lease；竞争者则已为相同端口返回另一个成功 lease，两个 Session 随后都可能通过 free-port probe，重新触发 DVS-005 的 EADDRINUSE/错误回滚。定位：`scripts/dev-session/registry.mjs:373-401,417-435`、`scripts/dev-session/services.mjs:1284-1311`。修复方向：在同一私有目录先完成临时文件 payload 写入与 fsync，再用 hard-link/link-at 或等价 no-replace 原子操作发布 canonical lease；发布后校验 canonical inode，竞争者只能看到完整 owner，不能按时间阈值回收 live creator 的半成品。

## 已修复项

- **P1 resolved — root 级长锁已替换为 per-port lease。** 不同端口可以并行取得，完整 readiness 不再被一个全局锁串行。
- **P1 resolved — 已写 owner 的 stale lease ABA 已关闭。** stale 读取与删除绑定 `dev/ino`，identity 变化时不会误删新的 live lease。
- **P1 resolved — Beta/packaged Backend sourceRevision 传播已闭环。** App Server、packaged Backend 和最终 ownership handshake 继续严格比较当前 revision，没有回退为端口/PID 宽松判断。

## 验证证据

- live partial lease 独立复现：子进程以 `O_EXCL` 创建空 `6210.lock` 并保持存活；等待 5.2 秒后调用 `acquireServicePortLease()`，输出 `{"liveCreatorPid":37484,"liveCreatorStillRunning":true,"competitorAcquired":true}`。
- `pnpm dev:session:verify`：通过，16 项 checks 全部通过；现有回归未覆盖 open 与 owner payload 写入之间的 live creator 暂停窗口。
- `pnpm typecheck`、`pnpm lint`、目标脚本 ESLint、Node syntax check、`git diff --check -- . ':(exclude)docs/review'`：全部以 0 退出。

## 集成风险

本地 `main` 落后 `origin/main` 2 个提交，唯一重叠文件是 `frontend/src/App.tsx`。当前工作树仍是三段 `/prototypes/:projectId/:prototypeSlug`，最新 upstream 已扩展为四段 `/prototypes/:projectId/:prototypeSource/:prototypeSlug`。这不是本轮 lease P1 的根因，但后续同步时必须保留 upstream 路由契约并合入 Dev Session guard，不能用当前旧快照覆盖新路由。
