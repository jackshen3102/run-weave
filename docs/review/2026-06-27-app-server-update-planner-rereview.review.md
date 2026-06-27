# app-server update planner 复审

## 检查范围

- 当前工作区 `HEAD` vs live worktree。
- 重点覆盖 `pnpm runweave:update` planner、App Server runtime 安装/重启、旧 lock 兼容迁移、Electron app-server CLI 接入、toolkit 更新技能文档，以及相关验证脚本。

## 发现

未发现新的 **P0/P1/P2** 问题。

上一轮关注的两个风险已在当前 diff 中处理并验证：

- 旧格式 app-server lock 现在会被 `readAppServerLock()` 兼容读取为 `releaseId: null` 的 lock，`rw app-server restart` 能先停掉旧 owner，再启动新 release。定位：`packages/shared/src/app-server-node.ts:268`、`scripts/verify-app-server-cli-start.mjs:102`。
- `--no-restart` 与 `app-server action=update` 现在会被拒绝，避免用户以为不会重启任何本地服务。定位：`scripts/runweave-update-core.mjs:343`、`scripts/runweave-update-test-cases.mjs:236`、`docs/architecture/app-server-event-center.md:282`。

## 残余风险

- 本轮没有执行真实桌面 UI 验收；当前请求是代码评审，且没有新增浏览器页面行为。若后续进入实际桌面更新流程，应使用 `computer-use`，涉及浏览器页面再使用 `$playwright-cli`。
- 一次实际路径验证误用了默认 `runtimeHome`，已安装本机 Desktop Runtime release；该操作未改变 tracked 工作区。后续类似验证应显式传入临时 `--runtime-home`。
- 当前本机仍有一个全局 app-server 进程运行在 `~/.runweave/app-server/runtime/releases/local-2026-06-27-11-09-47/...`；它不是本轮临时 home 验证进程，本轮没有停止它。

## 已执行验证

- `pnpm runweave:update:test-cases`
- `pnpm app-server:verify-cli-start`
- `pnpm --filter @runweave/shared typecheck`
- `pnpm --filter @runweave/cli typecheck`
- `pnpm --filter @runweave/electron typecheck`
- `pnpm --filter @runweave/cli lint`
- `pnpm --filter @runweave/electron lint`
- `node ./scripts/runweave-update.mjs --dry-run --state-path <tmp> --app-server-home <tmp> --no-restart --mode=runtime --app-server=update`，期望失败并实际失败。
- `node ./scripts/runweave-update.mjs --dry-run --state-path <tmp> --app-server-home <tmp> --app-server=skip --no-restart --mode=runtime`，通过。
- `git diff --check`

以上验证均符合预期。验证生成的 `.runtime-artifacts/`、`packages/runweave-cli/dist/`、`app-server/dist/`、`electron/dist/`、`frontend/dist/` 是 ignored 产物，tracked 工作区只新增本评审报告。
