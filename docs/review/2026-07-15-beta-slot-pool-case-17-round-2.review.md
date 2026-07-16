# Beta slot pool case_17 round 2 代码审查

## 结论

`case_17` 不通过。指定 full staged checkpoint 仍有 3 条未修复 P1；其中上一轮的 `beta-slot.lease-release-requires-quiescence` 在本轮 verifier 中可执行复现。磁盘预算加法问题已修复。

审查身份：

- DispatchId：`f24ec7d6-3803-439a-8aa3-668af2435724`
- baseCommit：`73171be93cc3062f577326b392ae6f0084c96036`
- targetTree：`30fb302759a7e0c7cba469170d662d68bc85fb9d`
- scope：`full`

## P1 发现

1. **缺失 recorded PID 被当作“进程已停止”，仍可继续 reset/release。** `cleanupStaleSessionServices()` 对 `process.pid` 缺失或无效的 dedicated service 执行 `isProcessLive(undefined) === false` 后直接标记 `already-stopped`，把“没有退出证明”误当成“已确认退出”。现有 `pnpm dev:session:verify` 已在 `scripts/dev-session/verify-registry.mjs:347` 复现：测试预期 cleanup 拒绝，实际命令成功，随后断言报 `Missing expected rejection`。这仍违反上一轮同一 invariant `beta-slot.lease-release-requires-quiescence`。定位：`scripts/dev-session/services.mjs:338-342`、`scripts/dev-session/verify-registry.mjs:347-370`。修复方向：只有存在有效 recorded PID 且确认该 PID 已退出时才能走 `already-stopped`；缺失/损坏身份必须 fail closed 并保留 lease。

2. **安全释放 lease 的 failed manifest 无法 status 或 stop。** start 失败且 identity-safe cleanup 成功时，代码写入 `state=failed`、`leaseRetained=false` 后删除 lease，但仍保留 assigned slot/nonce；`status` 对所有非 stopped Beta manifest 无条件断言 lease，`stop` 也按 assigned slot 再次 finalize/assert lease。隔离 HOME 的 CLI harness 中，合法 failed manifest 的 `status` 和 `stop` 都以 exit 5 返回 `Beta slot lease is missing or unreadable`，导致失败 Session 不能查看、关闭或复用。定位：`scripts/dev-session/cli.mjs:371-390`、`scripts/dev-session/cli.mjs:405-414`、`scripts/dev-session/cli.mjs:492-518`、`scripts/dev-session/cli.mjs:629-653`。修复方向：把 lease active/retained 状态纳入 manifest 合约；对已安全释放的 failed manifest 跳过 lease assert/finalize，并允许收敛到 stopped。

3. **janitor 恢复旧 lease 没有单 owner 互斥。** 每个 Beta start 都在自己的 Session lock 之外调用 `runBetaPoolJanitor()`；janitor 读取旧 lease 后直接 stop/reset/retention/写 manifest/release，没有 per-slot recovery lock、CAS claim 或旧 owner Session lock。两个并发 start 可同时恢复同一 stale slot；先完成者释放旧 lease 后，新 owner 可获取该 slot，而另一个 janitor 仍可能继续 reset mutable state，最终 lease identity 检查只能发现冲突，不能撤销已发生的数据删除。定位：`scripts/dev-session/cli.mjs:257-260`、`scripts/dev-session/beta-slot-pool.mjs:1073-1181`。修复方向：恢复前原子取得与 lease identity 绑定的 per-slot recovery ownership，并在每个 destructive step 前复核同一 lease/claim；释放与新 acquire 之间不得存在未完成的旧 recovery worker。

## 已解决

- `beta-slot.disk-budget-additive-estimate`：`plannedWriteBytes` 已改为 App、Desktop Runtime、App Server Runtime 与 tracked source 四项相加，再应用 512 MiB 下限。定位：`scripts/dev-session/beta-slot-pool.mjs:575-578`。

## 验证

- `pnpm dev:session:verify`：失败；`verify-registry.mjs:347` 报 `Missing expected rejection`。
- failed-manifest 隔离 HOME CLI harness：`status` exit 5，`stop` exit 5，均为 lease missing。
- `pnpm agent-team:verify-review-checkpoints`：通过。
- `pnpm runweave:beta:verify`：通过。
- `pnpm runweave:update:test-cases`：20/20 通过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `git diff --cached --check`：通过。

未执行 Playwright/浏览器验收：本轮是代码审查门禁，结论来自指定 staged checkpoint 的结构审查和 CLI/review harness；没有用静态证据冒充产品 UI 行为验收。
