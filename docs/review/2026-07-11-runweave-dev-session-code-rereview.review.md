# Runweave Dev Session 代码复审（Round 2）

## 结论

`case_24` 仍不通过。上一轮 4 个具体触发点已有实质修复，但当前 live diff 仍有 4 个 P1：两个计划内 profile 尚未实现、stop 未执行完整身份复核、公共 Backend env 清洗破坏旧入口兼容、显式 service override 可把未实现服务包装成 executable 计划后被运行时静默丢弃。

## 仍存在的 P1

1. **Electron/Beta 仍未实现，fail-fast 不能替代计划交付。** Planner 现在为 `electron`/`beta` 返回 `executable=false`，真实 start 也会在写 manifest 前失败；这修复了“伪装可启动”的表现，但 `services.mjs` 仍无条件拒绝这两个 profile，Electron 两类 CDP 与 Beta adapter 均没有实现。原计划阶段 1、3、4 和完成定义明确要求五个 profile、Desktop/Terminal Browser surface 与 Beta 多实例闭环，因此整体实现仍不完整。定位：`scripts/dev-session/planner.mjs:29-31,378-387`、`scripts/dev-session/services.mjs:586-596`、`docs/plans/2026-07-11-runweave-dev-session.md:292-331,408-415`。修复方向：实现 Electron/Beta adapter、status/open/stop 与两类 CDP identity；在真实能力落地前保持 fail-fast，但不能把该项标为已完成。

2. **`dev:stop` 绕过完整 handshake，DVS-017 仍会误杀或错误成功。** 新增的 `inspectBackendHandshake` / `inspectAppServerHandshake` 已用于 status/open，但 `runStop` 在任何 inspect 前先写 `stopping`，随后 `stopSessionServices` 只比较 `ps` signature。若 lock `startedAt`、service identity、health identity 或 endpoint 已漂移而原 wrapper PID/command 仍相同，status/open 会判 stale，stop 却仍发送信号并返回成功。这违反“stop 只停止通过完整身份复核的 dedicated 资源”和 DVS-017 要求的 stop 非零。定位：`scripts/dev-session/cli.mjs:265-293`、`scripts/dev-session/services.mjs:682-729`、`docs/testing/runweave-dev-session-test-cases.md:184-189`。修复方向：进入 stopping 前先对所有 dedicated 服务执行与 status/open 相同的 lock + process + health handshake；任一不匹配时保留/写 stale 并拒绝发送信号。

3. **为 Dev Session 隔离修改公共 `createBackendEnv`，破坏旧入口显式 App Server 连接。** `DEV_CHILD_ENV_KEYS_TO_REMOVE` 新增清除 `RUNWEAVE_APP_SERVER_URL/TOKEN/DISCOVERY/HOME/STATE_DIR/CLOUD_SYNC_DIR`，该 helper 同时被 `pnpm dev`、`pnpm dev:electron`、`pnpm app:dev` 使用。对照 `HEAD`，旧入口原本会保留显式 URL/token；当前纯函数复现得到 `legacyExplicitAppServerPreserved=false`。因此依赖自定义 App Server 的旧开发入口会静默回退默认 discovery，违反阶段 1“CLI 行为不变”和 DVS-019。定位：`dev.mjs:11-45,77-90,320-334`、`electron-dev.mjs:42-46`、`app-dev.mjs` 的 `startBackend` 调用、`docs/plans/2026-07-11-runweave-dev-session.md:292-302`。修复方向：保持公共 helper 的旧 env 语义；只在 Dev Session adapter 内构造显式清洗后的 base env，随后设置 `RUNWEAVE_APP_SERVER_DISCOVERY=explicit|disabled`。

4. **`executable` 未考虑 service override，未实现服务仍可被静默丢弃。** `buildDevSessionPlan` 允许把 profile 默认 disabled 的服务提升为 dedicated，但 `executable` 只看 profile。复现 `profile=frontend + electron=dedicated` 得到 `executable=true`、计划内 Electron dedicated；真实 `startSessionServices` 却固定返回 Electron disabled。显式最高优先级输入与最终 manifest 相反，调用方会收到成功但目标服务未启动。定位：`scripts/dev-session/planner.mjs:270-290,315-387`、`scripts/dev-session/services.mjs:663-673`。修复方向：根据最终 services/surface 计算 executable/unsupportedServices，并对当前 adapter 不支持的提升在启动前明确拒绝；不得静默改回 disabled。

## 上一轮已修复项

- 当前 live diff 的自动 profile 已从不可执行 electron 收敛为可执行 app-server。
- shared Backend/App Server 在 start、status、open 路径已复用 lock/health/process/capability handshake。
- Backend/App Server ownership 下界降级已被 Planner 拒绝，Dev Session 专用 Backend 也已显式使用 discovery mode。
- stale/failed 同名 Session 已在新 manifest 写入前拒绝复用，旧 manifest 保持不变。

## 验证证据

- `pnpm --silent dev:session --dry-run --json`：`profile=app-server`、`executable=true`。
- `pnpm dev:session:verify`：通过，包含 ownership boundary 与 stale session preservation。
- `pnpm typecheck`、`pnpm lint`、新增脚本 ESLint、`git diff --check -- . ':(exclude)docs/review'`：全部通过。
- 公共 helper 复现：向 `createBackendEnv` 传入显式 App Server URL/token/discovery 后，输出三项均被清除；`HEAD:dev.mjs` 的清除列表不包含这些字段。
- Planner 复现：`frontend + --service electron=dedicated` 返回 `executable=true`，而 `startSessionServices` 的成功返回固定写 `electron: disabled`。

## 验证边界

本轮为代码复审，没有执行 Playwright/Computer Use 行为验收。行为验证应在上述 P1 修复并通过下一轮 code review 后由 `behavior_verify` worker 执行。
