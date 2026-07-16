# Runweave Beta 五槽位池独立 Code Review

## 结论

`case_17` 不通过。完整 staged checkpoint 存在 2 条阻断 P1：槽位 lease 在两条失败路径上会在未证明 slot-owned 进程全部退出时被释放；磁盘门禁把本应相加的计划写入量做成了二选一估算，会低估 `requiredFreeBytes`。本审查未修改实现代码，也未执行产品运行态或 Playwright 验收。

## 固定边界

- Dispatch：`c5fb3cdb-b01c-4cc5-b0de-556fd53cf970`
- scope：`full`
- baseCommit / HEAD：`73171be93cc3062f577326b392ae6f0084c96036`
- targetTree / staged tree：`8c96c6490e2200c50b82c30fd818138c6752d77c`
- changedPaths：prompt 指定的 19 个 staged path，`2667 insertions / 40 deletions`
- plan SHA-256：`f727eb15e6fb82448b1c2a70dc5bd3b1616fed77bbf411d4d4a9846bdeae8c5c`
- test case SHA-256：`bafcfd0741f3825a6756a20ac76f5465bd2583e5f4b5f56477deb0fee30b0fbc`

## P1 阻断

### 1. 未证明 slot-owned 进程退出时仍可能 reset 并释放 lease

`cleanupStaleSessionServices()` 遇到身份漂移的 dedicated service 时不会失败，而是记录 `skipped-stale-identity` 后返回；`runStop --cleanup-stale` 不检查 `skippedStaleServices`，随后仍执行 mutable reset、把 manifest 写成 `stopped` 并释放 lease。这样一个仍存活但身份不匹配的进程可以继续使用旧槽位路径，同时新 owner 已获得同一槽位，直接违反 BSP-007 的“不发信号、不删数据、保持 broken/occupied”。

同一 invariant 还在 start 完成后的失败窗口出现：`startSessionServices()` 返回后，如果 ready manifest 的构造/持久化失败，外层 catch 会直接 reset 并释放 lease，没有先停止刚启动的服务。该窗口同样允许 live service 与下一 owner 并存。

定位：`scripts/dev-session/services.mjs:337-375`、`scripts/dev-session/cli.mjs:324-379`、`scripts/dev-session/cli.mjs:533-549`；合同：`docs/plans/2026-07-15-beta-slot-pool.md:146-156`、`docs/testing/beta-slot-pool-test-cases.md:119-124`。

修复方向：把“所有 slot-owned service 已身份验证并退出”做成 release 前的显式成功条件。`cleanupStaleSessionServices()` 只要存在 `skippedStaleServices`，pooled Beta 就必须保留 lease、停止 reset 并保持 `stale/broken`；start 外层 catch 必须持有已启动 services 的 cleanup handle，在 ready manifest 写入失败时先完成 identity-safe stop，任何 stop/reset/persist 失败都不得释放 lease。

稳定 invariant：`beta-slot.lease-release-requires-quiescence`。

### 2. 磁盘预算把总写入量做成二选一估算

计划合同明确要求 `plannedWriteBytes = App + Desktop Runtime + App Server Runtime + 临时产物估算总和`。实现虽然分别计算了 App、两类 Runtime 与 tracked source，但最终使用 `Math.max(existingBytes || sourceEstimate, 512 MiB)`：只要任一既有产物非零，`sourceEstimate` 就被完全丢弃；既有产物为零时，又只保留 sourceEstimate。`requiredFreeBytes = plannedWriteBytes * 3` 因此会系统性低估，磁盘空间可能在真实 update/build 中途耗尽，且磁盘写满会连带威胁失败状态和回滚元数据落盘。

定位：`scripts/dev-session/beta-slot-pool.mjs:517-589`；合同：`docs/plans/2026-07-15-beta-slot-pool.md:174-185`、`docs/testing/beta-slot-pool-test-cases.md:140-145`。

修复方向：按合同对各类本轮新增/复制量做可解释的加法估算，并对无法估算的分量 fail closed；不要用既有资源总量与源码大小互相替代。补一个同时存在非零 current App/Runtime 和非零临时构建估算的边界用例，断言两部分都进入 `plannedWriteBytes`。

稳定 invariant：`beta-slot.disk-budget-additive-estimate`。

## 验证记录

- `git rev-parse HEAD`：`73171be93cc3062f577326b392ae6f0084c96036`。
- `git write-tree`：`8c96c6490e2200c50b82c30fd818138c6752d77c`。
- `pnpm dev:session:verify`：通过。首次与其它门禁并行运行时命中既有 100ms status/lock 时序波动，单独复跑通过，不计为本轮 finding。
- `pnpm runweave:beta:verify`：通过。
- `pnpm runweave:update:test-cases`：20 cases 通过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm agent-team:verify-review-checkpoints`：通过。
- `git diff --cached --check`：通过。

上述门禁没有覆盖两条负向生命周期路径，也没有断言磁盘估算的加法合同，因此门禁通过不消除本次 P1。

## 残余风险

- 本轮为代码审查，不代替 `BSP-001` 至 `BSP-016` 的真实行为验收。
- 未使用 `$toolkit:playwright-cli`：本轮没有执行浏览器产品验收，两个 finding 均由 staged code path 与明确合同做 `static_contract` 确认。
