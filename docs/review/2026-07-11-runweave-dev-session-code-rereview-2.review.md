# Runweave Dev Session 代码复审（Round 3）

## 结论

`case_24` 仍不通过。Round 2 的 stop handshake、旧入口 env 兼容、跨 profile override，以及 Electron Dev adapter 已修复；但当前 live diff 仍有 4 个 P1 和 1 个 P2。最关键的问题是 Beta profile 实际启动源码开发 Electron，并未接入计划要求的实例化 Beta App、更新、回滚和迁移控制面。

## P1 阻断问题

1. **Beta profile 只是贴上 beta channel 的开发 Electron，不是计划中的 Beta adapter。** `startDedicatedElectron` 始终启动 `node_modules/electron ... electron/dist/main.cjs`，没有调用 `scripts/runweave-beta.mjs` / `runweave-update-core.mjs`，也没有实例化 App bundle、bundle id、update state、backup、rollback lock 或迁移路径。Round 3 smoke 的真实 manifest 记录的命令是开发 Electron，desktop status 为 `app.path=null`、`version=33.4.11`；与此同时 `pnpm runweave:beta:verify` 读取的是另一条固定 `/Applications/Runweave Beta.app` 单实例链路。两条控制面没有统一，DVS-020 与 BIC-001..018 不能成立。定位：`scripts/dev-session/services.mjs:640-771`、`docs/plans/2026-07-11-runweave-dev-session.md:324-331`、`docs/plans/2026-07-11-runweave-beta-instance-cdp-routing.md:137-186`。修复方向：让 Dev Session beta profile 调用实例化 Beta update/status/open/stop/rollback adapter，复用同一 manifest ownership；按 instance 生成独立 App/bundle id/userData/update/backup/lock，并完成旧 default 迁移。

2. **任一 adapter 在 readiness/handshake 阶段失败都会遗留未登记进程。** App Server、Backend、Frontend、Electron 都先 `spawnDetached`，直到各自 wait/lock/status/CDP 校验全部成功后才返回；`startSessionServices` 又只在 helper 返回后 `started.push(...)`。因此 health identity 不匹配、status 超时或 CDP readiness 失败时，刚启动的进程不在 `started` 清理栈，外层 catch 也不会停止它；manifest 仍只有 planned services，没有 PID/signature，后续 `dev:stop` 无法接管。定位：`scripts/dev-session/services.mjs:425-492,494-583,585-638,640-772,783-897`、`scripts/dev-session/cli.mjs:192-227`。修复方向：spawn 成功后立即登记 cleanup handle，或每个 helper 用 try/catch 在抛错前停止自身进程；失败 manifest 需保留可诊断、可安全清理的已启动资源身份。

3. **并发 Electron/Beta Session 共享并改写同一个 `electron/dist` bundle。** 每次 start 都在共享源码目录同步执行 `bundleElectron(electronDir, env)`，build define 包含 channel/revision，输出固定写 `electron/dist/main.cjs`，并删除重建共享 backend/cli dist。不同 Session 的 lock 只按 sessionId 隔离，两个 Session 可并发进入 bundle；后写者可让先启动者加载错误 channel/revision，或在 esbuild/rm 期间得到半套产物。这直接违反同 worktree 并发和两个 revision Beta 并行。定位：`scripts/dev-session/services.mjs:653-665`、`dev.mjs:404-412`、`electron/scripts/bundle.mjs:11-78`、`scripts/dev-session/registry.mjs:158-216`。修复方向：每个 Session 构建到独立输出目录并从该快照启动；最低限度也需跨 Session 构建锁加原子产物快照，但不能让运行身份依赖之后可被覆盖的共享 dist。

4. **CDP 健康检查没有证明 endpoint 属于目标实例。** status 文件只是 Electron 对配置端口的自报；`startDedicatedElectron` 和 `inspectElectronHandshake` 对两类 endpoint 仅要求 `/json/version` 返回任意 JSON。Desktop Chromium response 没有 instance/session identity，Terminal Browser Proxy 的 version 固定为 `Runweave/CDP-Proxy`，也不包含 instance/revision/PID。若端口检查与实际 bind 间发生竞争，或旧/其他 Runweave 占用端口，错误 endpoint 仍可能通过并被 `dev:open` 返回。定位：`scripts/dev-session/services.mjs:240-264,699-717,982-1021`、`electron/src/terminal-browser-cdp-proxy-handler.ts:39-48`、`docs/plans/2026-07-11-runweave-beta-instance-cdp-routing.md:114-119,188-195`。修复方向：让 endpoint 暴露不可伪造的 instance/session/revision identity，并将 status PID、监听进程和实际 target marker 交叉验证后再写 ready/open 结果。

## P2 一般问题

1. **Beta instanceId 校验复用了 48 字符 Dev Session ID 规则。** 子计划要求 `^[a-z0-9][a-z0-9-]{0,31}$`，当前 `explicitInstance` 调用 `assertDevSessionId`，实测 33 和 48 字符均被接受，49 字符才失败。定位：`scripts/dev-session/planner.mjs:391-393`、`scripts/dev-session/contracts.mjs:25`、`docs/plans/2026-07-11-runweave-beta-instance-cdp-routing.md:44-51`。修复方向：定义独立 instanceId validator，并在创建任何 Session/App/userData 文件前校验。

## 已修复项

- Electron Dev profile 已能启动隔离 userData，并解析 Desktop/Terminal Browser 两类 endpoint。
- `runStop` 已在写 stopping 和发送信号前执行 dedicated service handshake。
- 公共 `createBackendEnv` 已恢复旧入口 App Server URL/token/discovery 兼容，Dev Session 清洗局部化。
- 跨 profile service override 已在 Planner 阶段明确拒绝，不再成功后静默写回 disabled。

## 验证证据

- `pnpm dev:session:verify`、新增脚本 ESLint、`pnpm typecheck`、`pnpm lint`、`git diff --check -- . ':(exclude)docs/review'`：全部通过。
- `pnpm runweave:update:test-cases`：18 项通过。
- `pnpm runweave:beta:verify`：通过，但输出仍是固定 `/Applications/Runweave Beta.app`，sourceRoot 指向另一 worktree，证明未与 Dev Session round 3 Beta 实例统一。
- Round 3 smoke manifest/status：Beta 命令为开发 Electron，`app.path=null`、Electron version `33.4.11`，无实例 App/update/rollback 资源。
- instanceId 复现：长度 32、33、48 均接受，49 才以退出码 2 拒绝。

## 验证边界

本轮为代码复审，没有执行 Playwright/Computer Use 行为验收。真实页面、桌面和多实例并发验收应在上述 P1 修复并通过下一轮 code review 后由 `behavior_verify` worker 执行。
