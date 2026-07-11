# Runweave Dev Session 代码复审（Round 5）

## 结论

`case_24` 仍不通过。Round 4 指出的全局 build lock、普通 update 隐式迁移、standalone stop 仅凭 PID 发信号三项直接问题均有针对性修复；但沿最新失败路径复核后，当前 live diff 仍存在 4 个 P1。静态门禁全部通过，但现有 verify/test cases 没有覆盖“CDP 失败时清理”“同 worktree 多实例 runtime update”“干净 checkout 的 App Server restart”和“迁移 copy 中途失败”。

## P1 阻断问题

1. **Beta cleanup/rollback 要求双 CDP 健康，恰好在 CDP readiness 失败时无法停止进程。** `inspectBetaDesktopOwnership` 把 Desktop target 和 Terminal Browser endpoint 的完整健康作为 `ok` 条件，`quitBeta` 在任一 CDP 缺失/漂移时直接拒绝。Dev Session readiness 失败和 ownership handshake 失败都调用这个 stop 并吞掉异常；update 的 `restoreBaseline` 也依赖同一个 stop。因此 Beta 因 CDP 启动失败时会进入“需要清理但清理先要求 CDP 成功”的闭环，遗留进程并阻断 App 回滚。定位：`scripts/runweave-beta-state.mjs:262-333`、`scripts/runweave-beta-operations.mjs:128-157,181-195`、`scripts/dev-session/services.mjs:951-966,984-995`。修复方向：将“可安全终止的进程身份”与“可附着的 endpoint 健康”拆开；stop 只需以 PID + process start/signature + executable/App path + userData/instance 证明目标进程，CDP 缺失应让 status/open 失败，但不能阻止对已证明 ownership 的进程做 cleanup。

2. **Runtime update 仍使用共享构建目录和 `--latest`，同 worktree 的不同实例可能安装/记录另一份 release。** `runRuntimeUpdate` 虽生成局部 `releaseId`，但 `build-runtime-package.mjs` 仍改写共享 `frontend/dist`、`electron/dist` 和 `.runtime-artifacts`；安装时没有传刚构建的 zip，而是使用 `--latest`，返回状态又重新扫描全局最新 manifest。两个实例并行时，A 可安装 B 的 zip 或把 B 的 revision 记入 A 的 state，实例锁无法隔离这些共享选择。定位：`scripts/runweave-update-operations.mjs:145-207`、`scripts/build-runtime-package.mjs:15-16,70-113,149-151`、`scripts/install-runtime-package.mjs:175-190,355-380`；与 `docs/plans/2026-07-11-runweave-dev-session.md:68` 和 Beta 计划的“不同实例并行更新”冲突。修复方向：runtime build 输出按 instance/session 隔离，并把确定的 release 路径/ID直接传给 install 和 state，禁止在控制路径使用 `--latest` 或全目录重新选最新。

3. **App Server 已构建实例私有 control CLI，但 restart 仍调用 ignored 的共享 dist。** `install-app-server-runtime.mjs` 会将 CLI 构建到 `RUNWEAVE_CLI_BUNDLE_OUTFILE`，即实例的 `control/cli/index.js`；紧接着 `runAppServerUpdate` 却硬编码执行 `packages/runweave-cli/dist/index.js`。该共享文件被 gitignore，干净 checkout 不存在，且并发 worktree 中可能是旧产物，导致 Beta profile 固定要求的 `--app-server update` 在 install 成功后 restart 失败。定位：`scripts/install-app-server-runtime.mjs:41-60`、`packages/runweave-cli/scripts/bundle.mjs:3-10`、`scripts/runweave-update-operations.mjs:210-234`、`scripts/runweave-beta-operations.mjs:48-80`。修复方向：restart 复用本次已经构建并验证的实例 control CLI 路径，作为显式参数贯穿 updater；不得依赖 ignored/shared dist。

4. **迁移 commit 中当前失败的目标不会被回滚删除。** `copyMigrationEntry(entry.backup, entry.target)` 成功后才把 target 放进 `committed`；如果 `ditto` 因磁盘、权限或 I/O 错误在复制中途失败，当前 target 已可能部分创建，却不在 `committed` 中，catch 只删除之前完成的目标。结果 journal 写成 `rolled-back`，但残留 target 会让下次 migrate 在“target already exists”处永久拒绝，和“失败删除新副本、可恢复迁移”不一致。定位：`scripts/runweave-beta.mjs:106-116,182-233`、`docs/testing/runweave-beta-instance-cdp-routing-test-cases.md:186-193`。修复方向：在每次 copy 前登记目标，或 catch 中按 planned targets 逆序清理所有本次创建路径；同时保留备份和旧源，不删除预先存在路径。

## 已修复项

- update/rollback/migrate 已只持实例 `update.lock`，全局 `build.lock` 已移除。
- 普通 update 不再隐式搬移旧 default；迁移已有显式 `runweave:beta:migrate` 入口，并先复制备份、保留旧源。
- standalone stop 在发送信号前已校验 channel、instance、App/userData 路径、executable、process signature，并在 SIGTERM 前再次核对实时 signature。
- Beta App、Electron build/release、control CLI 和 App Server release ID 已增加实例化路径/标识。

## 验证证据

- `pnpm typecheck`：通过，覆盖 9 个 workspace project。
- `pnpm lint`：通过。
- `pnpm dev:session:verify`：10 项 checks 全部通过。
- `pnpm runweave:update:test-cases`：18 项通过。
- 目标脚本 ESLint：通过。
- `pnpm runweave:beta:verify -- --instance default`：静态隔离路径/status contract 校验通过；输出包含实例 buildRoot 与 control CLI，本机实例未运行。
- `git diff --check -- . ':(exclude)docs/review'`：通过。

## 验证边界

本轮为 review-only 代码复审，没有安装、迁移、启动或停止真实 Beta，也没有执行 Playwright/Computer Use。上述 P1 均由确定的控制流或硬编码路径直接成立；真实多实例并发、CDP 失败清理、迁移故障注入和干净 checkout 验收应在代码修复并再次通过 code review 后执行。
