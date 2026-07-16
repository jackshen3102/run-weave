# Beta slot pool case_17 round 4 代码审查

## 结论

`case_17` 通过。指定 full staged checkpoint 未发现未修复 P0/P1；上一轮两条重复 P1 已在当前 checkpoint 由 reviewer 使用原 scenario 的独立 `review_harness` 实际复验并关闭：损坏 orphan lock 场景保留 lease/mutable state 并标记 broken，legacy 活 App Server 场景拒绝 cleanup 且资源保持原位。

审查身份：

- DispatchId：`74542cae-56e9-4423-86f6-f80a25df3bbb`
- baseCommit / HEAD：`73171be93cc3062f577326b392ae6f0084c96036`
- targetTree / staged tree：`c8136e3c313ff8391dc7f72daef0bf5f7f64eb09`
- scope：`full`
- changedPaths：prompt 指定的 28 个 staged path，逐项匹配
- plan SHA-256：`f727eb15e6fb82448b1c2a70dc5bd3b1616fed77bbf411d4d4a9846bdeae8c5c`
- test case SHA-256：`bafcfd0741f3825a6756a20ac76f5465bd2583e5f4b5f56477deb0fee30b0fbc`

## 重复 finding 实际复验

1. `beta-slot.lease-release-requires-quiescence`：执行 `orphan-corrupt-lock-live-process`。隔离 HOME 中构造缺失 manifest、死亡 allocator、损坏 App Server lock 和仍存活且命令行引用 slot App Server home 的 Node 进程；`runBetaPoolJanitor()` 返回 `recovered=[]`，将 `pool-01` 标记为 broken，lease 与损坏 lock 均保留，子进程仍存活。实现通过 `inspectRecordedProcessState()` 与 `inspectProcessReferences()` 要求所有证据都可信且 inactive 后才允许 orphan recovery。定位：`scripts/runweave-beta-state.mjs:120-225`、`scripts/dev-session/beta-slot-pool.mjs:1101-1124,1219-1232`。

2. `beta-legacy.cleanup-requires-all-components-inactive`：执行 `legacy-live-appserver-cleanup`。隔离 HOME/Applications 中构造可信 bundle、App Server lock 指向存活进程且 Desktop 未运行；inventory 返回 `active=true`，`legacy-cleanup` 报 `legacy Beta instance is active or has untrusted identity`，App Server home 保持原位，子进程仍存活。实现联合 Desktop、Backend、App Server recorded PID 与全进程路径引用判定。定位：`scripts/runweave-beta-legacy.mjs:145-225,234-251`。

## 其余已关闭 P1

- `beta-slot.failed-manifest-lease-state`：安全释放 lease 的 failed manifest 可读取并由 stop 收敛为 stopped。
- `beta-slot.janitor-single-owner-recovery`：per-slot recovery claim 保证同一槽位只有一个 janitor 执行恢复。
- `beta-slot.disk-budget-additive-estimate`：planned writes 按 App、Desktop Runtime、App Server Runtime 与 tracked source 四项累计，再应用 512 MiB 下限。

## 验证记录

- Checkpoint：`git rev-parse HEAD`、`git write-tree`、28 个 changedPaths、plan/test case SHA-256 均与 prompt 精确匹配。
- `review-harness:orphan-corrupt-lock-live-process`：通过；`recovered=[]`、`broken=pool-01`、`leaseExists=true`、`corruptLockExists=true`、`childLive=true`。
- `review-harness:legacy-live-appserver-cleanup`：通过；`active=true`、`cleanupRejected=true`、`appServerHomeExists=true`、`childLive=true`。
- `pnpm dev:session:verify`：通过。
- `pnpm runweave:beta:verify`：通过。
- `pnpm runweave:update:test-cases`：20/20 通过。
- `pnpm agent-team:verify-review-checkpoints`：通过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- changed `.mjs` 全量 `node --check`：通过。
- `git diff --check <baseCommit> <targetTree>`：通过。

本轮是代码审查门禁，不代替 BSP-001 至 BSP-016 的完整真实产品行为验收；未执行 Playwright/桌面端验收，也未用静态检查冒充 UI/产品行为结果。
