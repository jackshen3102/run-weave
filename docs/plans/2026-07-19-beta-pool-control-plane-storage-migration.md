# Beta Pool canonical 控制面现状

> 状态：当前实现说明。文件名为历史兼容入口，不再表示要执行旧控制面数据迁移。
> 测试入口：`docs/testing/platform/beta-pool-storage-migration.testplan.yaml`
> 长期运行回归：`docs/testing/platform/beta-pool-runtime-regressions.testplan.yaml`

## 1. 当前范围

当前 Beta Pool 固定为 `pool-01` 至 `pool-05` 五个物理槽位。本文只描述当前 canonical 控制面、真实 App/Runtime 生命周期和恢复合同，不把以下历史路径作为验收范围：

- legacy 控制面旧数据构造或搬迁；
- migration journal、tombstone、旧 backup 和 downgrade；
- 依赖全新 HOME、空 `/Applications` 或人工清盘的 Case。

兼容代码仍可存在于仓库中，但不能被当前 Beta Pool 测试计划当成必测场景。仓库级兼容回归使用 `pnpm dev:session:verify`；当前 Beta 验收使用 `pnpm dev:session:verify:beta-current`。

## 2. 当前代码事实

### 2.1 物理资源与控制面

- 物理 App 使用 `/Applications/Runweave Beta pool-0N.app`。
- slot runtime、user data、诊断日志和 warm-state 位于 `~/Library/Application Support/Runweave Beta/instances/pool-0N`。
- canonical lease、claim 和 metadata 位于 `~/.runweave/beta-pool`。
- Dev Session manifest 位于 `~/.runweave/dev-sessions/<devSessionId>/manifest.json`。
- lease 通过原子文件发布保证同一 canonical HOME 内单 owner；`dev:pool` 只投影，不创建或修复资源。

物理 App 是机器级路径，而 canonical lease 是 HOME 级路径。当前实现尚需用运行时回归 `BPR-009` 验证跨 HOME 不会同时声明同一个全局物理槽位；在该合同通过前，不能把随机临时 HOME 当作完整 Beta 物理命名空间。

### 2.2 启动与停止

真实 Beta 生命周期统一由以下入口管理：

```bash
pnpm dev:session --profile beta --json
pnpm dev:status --session <devSessionId> --json
pnpm dev:open --session <devSessionId> --surface desktop --json
pnpm dev:stop --session <devSessionId> --json
pnpm dev:pool --json
```

启动顺序以当前实现为准：只读投影和安全恢复、原子 lease acquire、manifest 发布、隔离构建与更新、组件身份握手、ready。停止顺序以 identity-safe stop、mutable state reset、retention、终态 receipt 和 lease release 为准。

任何失败都必须保留原始 blocker 和所有权证据。未知 App、rollback、进程或 pointer 不能因“让测试继续”而删除；安全可证的本次资源必须通过产品恢复链收敛。

### 2.3 并发构建

每个 slot 的 Electron build root、Activity SQLite native staging 和 bundle output 必须相互隔离。多个 Beta start 不得共同删除或写入 worktree 级 `.native-artifacts`；生成的 worker、manifest 和 native module 直接进入对应 slot 的 Electron `dist/backend`，再由该 slot 的打包流程消费。

该边界由 `BETA-016` 的两轮真实五槽并发 start、满池第六请求和并发 stop 验证。用单进程 allocator fixture 不能替代真实构建竞争证据。

## 3. 当前测试结构

`beta-pool-storage-migration.testplan.yaml` 保留原始文件入口，承载当前控制面与恢复合同。历史 BSP 场景按不变量合并到 BETA Case；没有删除仍然有效的生产行为，只删除了与 BETA-002 完全重复的正常停止/再次启动 Case。

`beta-pool-runtime-regressions.testplan.yaml` 只承载控制面计划不能等价覆盖的长期行为：十轮资源上限、连续更新 retention、新 owner 数据隔离、真实 CDP、Stable/shared 边界、跨 HOME 物理所有权和 App pointer 崩溃收敛。

两个计划都不构造旧控制面数据。执行顺序为：

1. 校验两个 YAML；
2. 先执行控制面计划，遇到首个产品失败或环境阻塞即停；
3. 对产品失败做最小修复并从同一 Case 顶部重跑；
4. 控制面计划完成后再执行运行时计划；
5. 所有本次 Session 必须停止并确认 lease 收敛。

## 4. 验证命令

```bash
pnpm testplan:validate docs/testing/platform/beta-pool-storage-migration.testplan.yaml
pnpm testplan:validate docs/testing/platform/beta-pool-runtime-regressions.testplan.yaml
pnpm testplan:verify
pnpm dev:session:verify:beta-current
pnpm typecheck
pnpm lint
```

涉及真实页面身份时，先通过 `dev:open` 解析目标，再用 `$toolkit:playwright-cli` 附着返回的 CDP endpoint。涉及 macOS App Data 弹窗时必须在未预授权的隔离账号中使用 `$computer-use` 并核对同一时间窗的 tccd 日志；工具或账号条件不满足时记为环境阻塞，不能静态判通过。

## 5. 完成标准

- 五个槽位的 owner、nonce、manifest、runtime 和 CDP 身份一致；
- 满池第六请求 fail closed，不覆盖现有 owner；
- 重复执行不要求清空 HOME、App、rollback 或 warm runtime；
- 正常停止和安全失败都不泄漏 lease/claim；
- slot-owned 清理不修改 Stable、shared 或未知资源；
- 物理 App 数、release、rollback 和日志长期有界；
- 测试结果明确区分产品失败、环境阻塞和未执行，不复用过时结论。
