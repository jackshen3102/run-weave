# Runweave Dev Session 代码复审（Round 9）

## 结论

`case_24` 通过。本轮重新读取 Round 8 行为失败证据和 Round 9 最新修复后，未发现未修复的 P0/P1。Electron profile 的失败原因是 Desktop CDP 已监听、Terminal Browser proxy 已就绪，但 BrowserWindow page target 尚未出现在 `/json/list` 时 adapter 做了一次性判断并触发 cleanup；当前实现已改为带 Electron 进程存活保护的 30 秒有界 target readiness 等待。

## 修复复核

- **失败时序与修复对象一致。** 行为日志先出现 `DevTools listening` 和 `[cdp-proxy] listening`，约 0.9 秒后 status 才写入 stopped；该顺序支持“adapter 误判后 cleanup”，而不是 Electron 在握手前自行崩溃。证据：`.runweave/outbox/atr_99d90559_dvs-000-el-stable-electron.log`、`.runweave/outbox/atr_99d90559_dvs-000-el-desktop-status.json`。
- **等待有界且能感知进程退出。** `waitForJson` 最长等待 30 秒，每 200ms 重试，单次 fetch 750ms 超时；Electron PID 失活会立即抛错，不会无界挂起或把已退出进程判 ready。定位：`scripts/dev-session/services.mjs:23-24,77-109`。
- **Page target 仍绑定当前 Session Frontend。** 新等待只接受 `type=page` 且 URL 以本 Session `frontend.url` 开头的 target，不会因为任意 Chrome page 存在而通过。定位：`scripts/dev-session/services.mjs:816-827`。
- **Endpoint ownership 没有被放宽。** target ready 后仍要求 Desktop 与 Terminal Browser 两个监听 PID 都包含 `status.app.pid`；Terminal Browser `/json/version` 仍校验 surface、instanceId、devSessionId、revision 和 PID。定位：`scripts/dev-session/services.mjs:803-845`。
- **失败清理仍由既有 cleanup 栈负责。** Electron spawn 后立即登记，等待超时、进程退出或 listener drift 都会进入外层逆序 cleanup，不会遗留进程。定位：`scripts/dev-session/services.mjs:783-791,1270-1277`。

## 已修复项

- Electron profile 在 BrowserWindow target ready 前一次性检查 `/json/list` 并误触发 cleanup。

## 验证证据

- `pnpm typecheck`：通过，覆盖 9 个 workspace project。
- `pnpm lint`：通过。
- `pnpm dev:session:verify`：10 项 checks 全部通过。
- `pnpm exec eslint scripts/dev-session/*.mjs scripts/verify-dev-session.mjs`：通过。
- `git diff --check -- . ':(exclude)docs/review'`：通过。

## 残余验证边界

本轮是 code review，没有自行重启 Electron profile。Round 9 修复需要由 backend 重新触发 `behavior_verify`，从 DVS-000 Electron profile 继续取得真实 CDP/页面证据；这不构成本轮代码评审的未修复 P0/P1。
