# Beta 固定资源池管理 Round 1 代码审查

## 结论

审查不通过。当前实现仍有 2 条 P1，均直接违反已冻结的资源回收安全/并发不变量；在修复前，`AGT-REVIEW-GATE` 应保持 fail。

## 审查范围

- Dispatch：`8de582b3-deb7-48a5-8770-2cb166480b72`
- 基线：`HEAD=af3f8b8`
- 实现边界：Code Agent outbox 中列出的 19 个 `changedFiles`
- 需求输入：`docs/plans/2026-07-18-beta-resource-management.md`、`docs/testing/platform/beta-resource-management.testplan.yaml`
- 当前 run 未提供冻结的 `reviewTarget`，因此未把计划/测试计划本身计入实现 diff。

## Findings

### P1：存活的 recorded PID 没有阻止 slot reset/release

`scripts/dev-session/beta-slot-pool-process-inspection.mjs:35-48` 只把“不可信记录”和“命令行路径引用”加入 blocker，却没有把 `inspectRecordedProcessState()` 已确认的 `entry.active=true` 加入 `active`。因此，只要存活进程的命令行不含 slot 路径，`safeToReset` 仍为 true；`scripts/dev-session/beta-slot-pool-recovery.mjs:187-228` 随后会 reset 并 quarantine corrupt lease。

隔离 review harness 已复现：真实 Node 子进程 PID 55132 被写入 `beta-desktop-status.json`，检查结果同时出现 `recorded.desktop.active=true`、`pathReferencesActive=false`、`safeToReset=true`；startup janitor 返回 recovered、删除 lease，而子进程仍存活。该路径会让旧进程与新 slot owner 并存，违反 BRM-006/BRM-008 的 fail-closed 与零进程前置条件。

修复方向：`safeToReset` 必须同时要求所有可信 recorded process 均为 inactive；live PID 还应基于记录中的 process identity/signature 做身份核验，不能只把“记录可解析”视为安全。

### P1：start-failure finalizer 反向获取 recovery claim

`scripts/dev-session/cli.mjs:299-497` 在整个 `runStart` transaction 外层先持有 owner Session lock；失败清理在 `scripts/dev-session/cli.mjs:439-458` 调用没有 `claimAlreadyHeld` 的 `finalizeBetaSlotRelease()`，后者才在 `scripts/dev-session/beta-slot-pool-lifecycle.mjs:219-235` 获取 recovery claim。实际顺序是 `Session lock -> recovery claim`，与计划冻结的 `recovery claim -> owner Session lock` 相反，也与 normal stop 的实现顺序不一致。

当另一 start 的 startup hygiene 已持有该 slot claim 并尝试 owner Session lock 时，当前 start-failure finalizer 会立即得到 `beta_pool_recovery_claim_busy`，把本可安全释放的 lease 留为 stale；这使 BRM-009 的统一 release transaction 与 BRM-010 的并发收敛不成立。

修复方向：把 start-failure 的 slot finalization 重构为固定 claim-first 的事务边界；不要在已经持有 Session lock 后再获取 claim。应补一个并发受控验证，覆盖 janitor claim 与 start-failure cleanup 交错。

## 已执行检查

- `pnpm dev:session:verify`：通过。
- `pnpm testplan:validate docs/testing/platform/beta-resource-management.testplan.yaml`：通过，12 个 required cases。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `git diff --check`：通过。
- 隔离 live-recorded-process review harness：复现 P1；fixture 已清理，没有启动/停止 Dev Session。

现有 verifier 的 corrupt-lease 场景只覆盖“无进程”成功分支，没有覆盖“recorded PID 存活但命令行无 slot 路径”的拒绝分支；静态门禁通过不能替代该安全不变量。

## Resolved Findings

无。本轮是首次独立审查，没有上一轮 finding 可关闭。
