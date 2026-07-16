# Beta slot pool case_17 round 11 增量审查

## 结论

`case_17` 通过。对 `7fddb5f51946e6af117c462e6b66d5706ee01933` 到 staged tree `5eddde081d9d2aeb6b20ea20e1a910547418fc8c` 的 2 个指定路径完成独立增量审查，未发现开放 P0/P1。

本轮修复把磁盘预算的 symlink 策略收窄到正确边界：待计量的顶层 Beta App 仍禁止为 symlink；App bundle 目录内部的标准 framework symlink 只按 symlink 自身大小计量且不跟随，真实 target 目录仍由正常递归计量。这样既不再拒绝合法 Electron App bundle，也不引入路径逃逸或外部 target 遍历。

审查身份：

- DispatchId：`7f96f2b7-ce03-492a-935d-ea8708de0ffc`
- scope：`incremental`
- baseCommit / HEAD：`7fddb5f51946e6af117c462e6b66d5706ee01933`
- targetTree / staged tree：`5eddde081d9d2aeb6b20ea20e1a910547418fc8c`
- changedPaths：`scripts/dev-session/beta-slot-pool.mjs`、`scripts/dev-session/verify-beta-slot-pool.mjs`
- plan SHA-256：`f727eb15e6fb82448b1c2a70dc5bd3b1616fed77bbf411d4d4a9846bdeae8c5c`
- test case SHA-256：`bafcfd0741f3825a6756a20ac76f5465bd2583e5f4b5f56477deb0fee30b0fbc`

## 调用链与失败分支

- `dev-session/cli.mjs` 在取得 slot lease、写入 starting manifest 并执行 retention 后调用 `assertBetaPoolDiskBudget()`；预算通过后才启动 Session services。
- 生产调用未传 `applicationsDir`，因此仍锁定 `/Applications/<Beta App>.app`；新增参数仅为 verifier 提供隔离 Applications 根目录。
- `calculatePathBytes(appPath)` 首层保持 `rejectSymlink=true`，顶层 App symlink 会 fail closed。
- 递归进入真实目录后使用 `rejectSymlink=false`；遇到内部 symlink 只读取 `lstat.size` 并立即返回，不会跟随 target。
- runtime release 与 App backup 的清理仍要求待删除顶层 target 不是 symlink；目录内部 symlink 由 `fs.rm(..., recursive)` 作为链接本身删除，不会遍历链接目标。
- 磁盘不足、非法 floor、无法形成正 planned-write estimate 的既有 fail-closed 分支未改变。

## Fresh 证据

- `pnpm dev:session:verify` 新增 fixture 创建 Electron Framework 的 `Versions/Current` 与 framework binary symlink，预算计算通过；随后把整个 Beta App 路径替换为 symlink，确认仍以 `refusing to size a symlinked Beta path` 拒绝。
- 对当前 `/Applications/Runweave Beta pool-01.app` 执行只读场景 `beta-disk-budget-standard-framework-symlinks` 成功：`retainedBytes=328213539`、`plannedWriteBytes=536870912`、`requiredFreeBytes=1610612736`、`freeBytes=55187697664`。
- 该命令只读取 App、runtime、tracked source 与文件系统空间，没有启动、停止或修改 Beta/Stable 服务。

## Resolved findings 回归

以下既有 P1 均保持 resolved：

- `beta-slot.disk-budget-additive-estimate`：本轮直接修改该路径；fresh fixture、真实 App 只读预算与磁盘不足 fail-closed verifier 均通过。
- `beta-slot.lease-release-requires-quiescence`
- `beta-legacy.cleanup-requires-all-components-inactive`
- `beta-slot.failed-manifest-lease-state`
- `beta-slot.janitor-single-owner-recovery`

后四条实现路径未被本增量修改，`pnpm dev:session:verify` 与 `pnpm runweave:beta:verify` fresh 通过其回归合同。

## 验证记录

- `review-harness:beta-disk-budget-standard-framework-symlinks`：真实 pool-01 App 只读计算通过。
- `pnpm dev:session:verify`：通过，`ok=true`。
- `pnpm runweave:beta:verify`：通过，`ok=true`。
- `pnpm runweave:update:test-cases`：20/20 通过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `git diff --cached --check`：通过，无输出。
- `git rev-parse HEAD` 与 `git write-tree` 分别精确等于本轮 baseCommit 与 targetTree。

本轮是 review-only 增量代码审查，没有修改业务代码、配置或测试。BSP-001 的完整产品行为结论仍由后续 behavior verifier 在同一 runtime 场景中给出，本报告不以结构审查替代该验收。
