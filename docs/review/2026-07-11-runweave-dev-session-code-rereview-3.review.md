# Runweave Dev Session 代码复审（Round 4）

## 结论

`case_24` 仍不通过。Round 3 的 4 个 P1 和 1 个 P2 均已有针对性修复：Beta profile 已接入安装态 adapter，spawn 后立即登记清理，Electron Dev 使用 Session 私有 bundle，CDP 增加 PID/identity/target 交叉校验，Beta instanceId 也收紧到 32 字符。但当前 live diff 新增了 3 个 P1，分别破坏不同 Beta 实例并发、旧 default 安全迁移，以及 stale PID 下的安全停止。

## P1 阻断问题

1. **所有 Beta update 仍被全局 `build.lock` 串行化，不同实例无法并发更新。** `withBetaLock(..., { globalBuild: true })` 会先获取 `~/Library/Application Support/Runweave Beta/build.lock`，该路径不含 `instanceId`；A 更新持锁时，B 会直接报 busy。实现与计划“update/rollback lock 每实例独立”和 BIC-005“使用全局锁互相阻塞即失败”正面冲突。定位：`scripts/runweave-beta.mjs:66-105,370-378`、`docs/plans/2026-07-11-runweave-beta-instance-cdp-routing.md:60-70`、`docs/testing/runweave-beta-instance-cdp-routing-test-cases.md:96-103`。修复方向：将构建输出本身实例化/快照化，使 update 只持实例 lock；不要用跨实例全局锁掩盖共享构建目录竞争。

2. **旧 default 迁移被普通 update 隐式触发，并在建立基线/备份前逐项 `rename`。** default 的每次 update 都先调用 `migrateLegacyDefault`；该函数直接搬移旧 App、userData 和 App Server 目录，没有显式迁移命令、备份、事务回滚或运行实例身份检查。任一中途失败都会把旧安装拆成两半，而随后 `collectBaseline` 只能看到迁移后的路径，无法恢复旧路径。这违背计划和 BIC-015 对“显式迁移、迁移前备份、失败可恢复旧 App”的硬要求。定位：`scripts/runweave-beta.mjs:110-165,370-378`、`docs/plans/2026-07-11-runweave-beta-instance-cdp-routing.md:129-135,206-210`、`docs/testing/runweave-beta-instance-cdp-routing-test-cases.md:186-193`。修复方向：提供显式 migrate 命令；先验证 ownership/进程状态并创建可取证备份，再原子提交或按 journal 回滚，失败时保持旧 Beta 完整可用。

3. **standalone Beta stop 仍可因 stale status / PID 复用而误杀无关进程。** `quitBeta` 只从 status 读取 PID 并用 `kill(pid, 0)` 判断存活，随后按应用名 quit，超时后直接对该 PID 发送 `SIGTERM`；没有校验 executable、App path、startedAt、instance/devSession/revision 或 CDP identity。若旧 PID 已被复用，`runweave-beta stop` 会向无关进程发信号。Dev Session 的外层 stop handshake 不能保护直接调用的 Beta stop，也不能保护启动失败路径中的 cleanup callback。定位：`scripts/runweave-beta-operations.mjs:124-140`、`scripts/runweave-beta.mjs:404-410`、`docs/plans/2026-07-11-runweave-dev-session.md:68-71,373-377`。修复方向：stop 前复用完整 Beta ownership handshake；身份无法证明时 fail closed 并保留诊断状态，禁止仅凭 PID/应用名发送信号。

## 已修复项

- Beta profile 已通过 `runweave-beta.mjs update/status/stop` 接入实例 App、独立 userData/App Server home、安装态 health 与 manifest ownership。
- 各服务 spawn 后立即登记 cleanup，Beta readiness 失败也会走 control stop，上一轮未登记进程问题已闭环。
- Electron Dev bundle 支持 `RUNWEAVE_ELECTRON_BUNDLE_OUTDIR` 并构建到 Session 私有目录，不再并发覆盖共享 `electron/dist`。
- Desktop CDP 现校验监听 PID 与目标 URL；Terminal Browser version 现暴露 instance/session/revision/PID，上一轮 endpoint 归属缺口已闭环。
- Beta instanceId 使用独立的 1–32 字符校验；实测 32 字符接受、33 字符以退出码 2 拒绝。

## 验证证据

- `pnpm typecheck`：通过，覆盖 9 个 workspace project。
- `pnpm lint`：通过。
- `pnpm exec eslint scripts/runweave-beta.mjs scripts/runweave-beta-operations.mjs scripts/runweave-beta-state.mjs scripts/dev-session/*.mjs scripts/verify-dev-session.mjs electron/scripts/bundle.mjs scripts/electron-dist-retry.mjs`：通过。
- `node scripts/verify-dev-session.mjs`：10 项 checks 全部通过。
- `pnpm runweave:update:test-cases`：18 项通过。
- `pnpm runweave:beta:verify -- --instance default`：静态 Beta 隔离/status contract 校验通过；本机该实例未运行，所有 health 为 false。
- `git diff --check -- . ':(exclude)docs/review'`：通过。
- instanceId 边界实测：32 字符 accepted；33 字符 rejected，错误为 `Beta instance id must be 1-32 lowercase letters, numbers, or hyphens`。

## 验证边界

本轮是 review-only 代码复审，没有安装/启动真实 Beta，也没有执行 Playwright 或 Computer Use 行为验收。上述 3 个 P1 都可由控制流和既定验收条件直接判定；真实桌面、多实例并发、迁移和回滚用例应在阻断问题修复并再次通过代码复审后执行。
