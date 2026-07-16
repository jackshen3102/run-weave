# Beta slot pool case_17 round 3 代码审查

## 结论

`case_17` 不通过。指定 full staged checkpoint 仍有 2 条未修复 P1。Round 3 已关闭上一轮的 missing-PID、failed manifest 和 janitor 单 owner 三个具体问题，但完整 diff 的 orphan recovery 与 legacy cleanup 仍会在无法证明所有相关进程已退出时删除资源或释放 lease。

审查身份：

- DispatchId：`c7d7b01d-8dbe-430d-b758-6fa1d211bad6`
- baseCommit：`73171be93cc3062f577326b392ae6f0084c96036`
- targetTree：`6e7d7943612b2b7f4b627ec0d86459c3a81d620e`
- scope：`full`

## P1 发现

1. **orphan lock 损坏被当作进程不存在，janitor 会在活进程仍存在时 reset/release。** `recordedSlotProcessesAreAbsent()` 对 desktop/backend/App Server 状态文件的读取或 JSON 解析失败统一返回 `null`，最终仍返回 `true`。受控 `orphan-corrupt-lock-live-process` harness 构造缺失 manifest、死亡 allocator、损坏 App Server lock 和一个仍存活的 slot 关联进程；janitor 将 `pool-01` 记为 recovered，删除损坏 lock 与 mutable state、释放 lease，而进程仍存活。该路径继续违反 `beta-slot.lease-release-requires-quiescence`。定位：`scripts/dev-session/beta-slot-pool.mjs:1097-1124,1220-1232,1276-1306`；合同：`docs/plans/2026-07-15-beta-slot-pool.md:146-156,187-196`、`docs/testing/beta-slot-pool-test-cases.md:119-124`。修复方向：orphan 恢复只有在每一种可能的 slot-owned 进程身份都获得可验证的“不存在”证据时才可继续；状态文件缺失、损坏或字段无效必须标记 broken 并保留 lease/mutable state。

2. **legacy inventory 只检查 Desktop，仍存活的 Backend/App Server 不会阻止 cleanup。** `inventoryLegacyBeta()` 的 `active` 只来自 desktop status PID 与 App bundle 进程匹配，不读取 backend/App Server lock PID；`cleanupLegacyBeta()` 直接信任该布尔值并移动 App、instanceRoot 与 appServerHome。受控 `legacy-live-appserver-cleanup` harness 构造 bundle identity 正确、Desktop 不运行、App Server lock 指向活进程的 legacy instance；inventory 返回 `active=false, trusted=true`，cleanup 进入 quarantined 并移走 appServerHome，进程仍存活。定位：`scripts/runweave-beta-legacy.mjs:144-178,189-265`；合同：`docs/plans/2026-07-15-beta-slot-pool.md:198-205`、`docs/testing/beta-slot-pool-test-cases.md:182-187`。修复方向：cleanup 前联合 Desktop、packaged Backend 与 App Server 的 lock/process identity 判定；任一 live、缺失可信退出证明或锁损坏均拒绝迁移。

## 已解决

- `beta-slot.failed-manifest-lease-state`：`retainsBetaSlotLease()` 识别 `failed + leaseRetained=false`，status 可读取，stop 可收敛为 stopped。
- `beta-slot.janitor-single-owner-recovery`：per-slot recovery claim 将同一槽位的 janitor 恢复串行化，受控并发 verifier 通过。
- `beta-slot.disk-budget-additive-estimate`：计划写入量继续按四个分量累加。
- 上一轮 missing recorded PID 的具体 fail-open 分支已修复，`pnpm dev:session:verify` 通过；但同一 quiescence invariant 仍被本轮 finding 1 的损坏 orphan lock 路径违反，因此该 invariant 不能标记 resolved。

## 验证

- checkpoint：HEAD 为 baseCommit，staged index 与 targetTree 无差异，28 个 changedPaths 匹配。
- `pnpm dev:session:verify`：通过。
- `pnpm runweave:beta:verify`：通过。
- `pnpm runweave:update:test-cases`：20/20 通过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm agent-team:verify-review-checkpoints`：通过。
- `git diff --cached --check`：通过。
- `review-harness:orphan-corrupt-lock-live-process`：`recovered=pool-01`、`leaseExists=false`、`corruptLockExists=false`、`childLive=true`。
- `review-harness:legacy-live-appserver-cleanup`：`active=false`、`trusted=true`、`cleanupState=quarantined`、`originalHomeExists=false`、`childLive=true`。

未执行 Playwright/浏览器验收：本轮是代码审查门禁；两条 finding 均由隔离 HOME 的可执行 review harness 复现，未用静态检查冒充 UI/产品行为验收。
