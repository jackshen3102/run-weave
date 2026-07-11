# Runweave Dev Session Loop Round 13 代码复审

## 结论

`case_24` 通过。本轮未发现仍未修复的 P0/P1。Round 12 的 Beta App Server readiness 假阴性已按根因修复：Electron 只把正整数 shared App Server PID 写入 desktop status；Beta resolver 对旧状态中的 `0`、缺失或其他无效 PID 回退到目标实例/shared lock PID，再检查 PID 存活与显式 `/healthz`。

## 复审依据

- **生产端不再把空 env 变成 PID 0。** `electron/src/packaged-backend-controller.ts:69-71,107-115` 虽继续使用 `Number()` 解析 env，但只有 `Number.isInteger(pid) && pid > 0` 时才序列化，否则写 `null`。
- **旧状态兼容回退。** `scripts/runweave-beta-state.mjs:378-411` 先解析 desktop status 指定的 lockPath，再仅信任正整数 desktop PID；`0`/无效值回退到该 lock 的 PID。
- **Endpoint 来源保持显式。** App Server baseUrl 优先使用 desktop status 的显式 URL，否则只从 host=`127.0.0.1` 且合法 port 的目标 lock 生成 loopback URL。
- **Readiness 没有放宽最终 ownership。** `buildBetaStatus()` 只提供聚合 readiness；`startDedicatedBeta()` 随后仍读取 Backend/App Server lock 和 health，并通过 `inspectBackendHandshake()` / `inspectAppServerHandshake()` 严格比较 process signature、lock identity、devSessionId、sourceRevision、protocol 和 capabilities。
- **Shared/dedicated 语义不串线。** Shared App Server 显式传入 PID/URL/lockPath；dedicated Beta 未设置 shared PID 时由实例 lock fallback。两者最终都使用各自 lock/health 做身份校验。
- **Stable 与 stop/rollback 未受影响。** 本轮只改变 desktop status PID 序列化和 Beta status PID 选择，没有修改 Stable 路径、process ownership、停止或恢复逻辑。

## Findings

### P0/P1

无。

### 已修复

- **P1 resolved — 空 shared App Server PID 被序列化为 0，阻断实例 lock PID fallback。** 生产端写 null，resolver 对旧 0 状态回退 lock PID。
- **P1 resolved — 阶段 5 所需 `dev:legacy` 入口不存在。** 新入口与原 `dev` 精确复用 `node ./dev.mjs`。
- **P1 resolved — stale Session status/stop 缺少 cleanup 与恢复指引。** 结构化 recovery 和 identity-safe cleanup 保持有效。

## 验证证据

- **独立 PID fallback fixture。** Desktop status `appServer.pid=0`，实例 lock PID 为当前 live process，真实 loopback `/healthz` 返回 200；`buildBetaStatus()` 返回 `resolvedPid=lockPid`、`healthy=true`。
- Fixture 输出：`{"desktopPidFixture":0,"lockPid":88006,"resolvedPid":88006,"healthy":true,"baseUrl":"http://127.0.0.1:56455"}`。
- `pnpm dev:session:verify`：21 项 checks 全部通过。
- `pnpm runweave:update:test-cases`：18 项全部通过。
- `pnpm runweave:beta:verify`：通过，isolated paths 与 status contract 正常。
- `pnpm typecheck`、`pnpm lint`、目标 ESLint、Node syntax、目标 Prettier、`git diff --check -- . ':(exclude)docs/review'`：全部通过。

## 残余验证边界

本轮是代码复审，没有替代后续 `behavior_verify` 的真实 Beta 构建、安装、App Server readiness、Playwright attach、双实例与 rollback 验收。该运行时复验应由 backend 按 DVS-020 继续执行，不构成当前未修复的 P0/P1。
