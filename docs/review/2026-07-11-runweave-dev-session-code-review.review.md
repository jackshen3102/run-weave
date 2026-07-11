# Runweave Dev Session 代码复审

## 结论

`case_24` 不通过。当前 live worktree 未发现 P0，但仍有 4 个 P1 阻断问题。静态门禁全部通过，不足以证明 Dev Session 的 profile、ownership、identity 与恢复契约成立。

## P1 阻断问题

1. **当前改动会自动选择一个必然无法启动的 Electron profile。** `packages/shared/src/runtime-monitor.ts` 被 Planner 固定归为 `electron`，所以当前 worktree 的 `pnpm dev:session --dry-run --json` 选择 `electron`；但 `startSessionServices` 对 `electron`/`beta` 无条件抛出 “adapter is not available”。显式降为 `fullstack` 又因影响闭包返回退出码 4，而 `beta` 的 requirements 不含 `frontend/backend`，也不能作为 Electron 的上位 profile。结果是新增主入口在实现它自己的当前 diff 上没有可成功启动的 profile。定位：`scripts/dev-session/planner.mjs:15-27,74-82,145-158`、`scripts/dev-session/services.mjs:434-445`。修复方向：补齐 Electron/Beta adapter 和两类 CDP surface；同时把 profile capability/依赖建模为真实可组合闭包，确保 Beta 能覆盖需要的 Frontend/Backend 能力，且在 adapter 未实现前不要把不可执行计划报告为可启动计划。

2. **shared Backend/App Server 没有完成可恢复的身份握手，`status/open` 会继续把失效依赖报告为 ready。** `resolveSharedBackend` 只要求 health `status=ok` 和 lock PID 存活，没有校验 `health.serviceInstanceId === backend:<lock.backendId>`、PID 启动身份、capability、revision 或 namespace；随后 `inspectSessionServices` 直接跳过所有 `shared-declared` 服务。默认 Frontend profile 因而可能在启动时接受错实例，并在 shared 服务被替换/漂移后仍由 `dev:status`/`dev:open` 返回 ready。定位：`scripts/dev-session/services.mjs:138-219,550-599`。修复方向：把 lock、health、PID/start signature、service identity、capability、revision、namespace 做成同一套 handshake，并在 status/open 时对 dedicated 与 shared 都重新验证；任何漂移都进入 stale 并拒绝 open。

3. **`--service` 可以绕过影响闭包，`disabled` 还会回退 ambient App Server。** Planner 只拒绝“required service 被设为 disabled”，所以 Backend 已改时 `backend=shared-declared` 仍被接受；`appServer=disabled` 也可被 fullstack 接受。运行时 Backend 继承 `process.env`，且未显式提供 App Server 时，现有 discovery 会继续读取环境或默认 lock，导致 manifest 写着 disabled、真实 Backend 却连接 ambient App Server。定位：`scripts/dev-session/planner.mjs:213-272`、`scripts/dev-session/services.mjs:326-375,451-501`、`dev.mjs:15-37,71-80`、`packages/shared/src/app-server/discovery.ts:14-31,179-190`。修复方向：对 override 执行与 changed-path/state/capability 一致的下界校验；disabled 模式必须显式清空 App Server env，并让 Backend 禁止默认 discovery。

4. **同名 stale/failed Session 会覆盖旧 manifest，遗失仍存活资源的 ownership。** `runStart` 只拒绝 `starting/ready/stopping`，对 `stale/failed` 直接写入新的 planned manifest。stale Session 可能只丢失一个服务而仍有其他 dedicated 进程存活；覆盖后这些 PID、签名和路径不再可恢复，后续 stop 无法清理，且同一 Session 会再启动一套资源。定位：`scripts/dev-session/cli.mjs:168-200`。修复方向：任何已有非 stopped manifest 默认 fail closed；先通过显式 repair/cleanup 流程复核并处理旧 owned 资源，完成后才允许复用 session ID。

## 验证证据

- `pnpm dev:session:verify`：通过，输出 planner、manifest permissions、candidate resolution、stale lock recovery、newer schema fail-closed、path/endpoint safety。
- `pnpm typecheck`：通过，9 个 workspace project 完成。
- `pnpm lint`：通过。
- `pnpm exec eslint scripts/dev-session/*.mjs scripts/verify-dev-session.mjs`：通过。
- `git diff --check`：通过。
- `pnpm --silent dev:session --dry-run --json`：当前 worktree 选择 `profile=electron`、`requiredProfile=electron`。
- `node ./scripts/dev-session/cli.mjs start --dry-run --profile fullstack --json`：退出码 4，缺少 `electron`、`desktopCdp`。
- 纯 Planner 复现：Backend 改动下 `backend=shared-declared` 返回成功；fullstack 下 `appServer=disabled` 返回成功。

## 验证边界

本轮是代码复审，没有执行 Playwright/Computer Use 行为验收；浏览器与桌面真实用例应在上述 P1 修复后由 `behavior_verify` worker 执行。
