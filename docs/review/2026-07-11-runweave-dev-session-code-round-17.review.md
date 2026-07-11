# Runweave Dev Session Round 17 代码复审

## 结论

`case_24` 通过。本轮未发现仍未修复的 P0/P1。Round 16 暴露的最终 ownership sourceRevision 漂移已按根因修复：Beta update/App Server 控制链和 packaged Electron/Backend 运行链现在都携带当前源码 revision，既有 lock、health、descriptor 严格比较与 fail-closed cleanup 未被放宽。

## 复审依据

- **Round 15 修复已由真实路径确认。** dvs16 desktop status 已包含 executable、processSignature、startedAt 和正确实例身份，Beta App 与实例 App Server runtime 均安装成功，不再出现 staging appDir/readiness 问题。
- **漂移字段已直接确认。** dvs16 update state 的 `gitHead` 为 `24bfb10b73411717984609692250fb33b1b1b369`，App Server health/lock 已有正确 `devSessionId=dvs16-000-beta` 与 service instance，但两者均缺少 `sourceRevision`，和握手错误精确对应。
- **App Server 传播链完整。** `scripts/runweave-beta-operations.mjs:53-83` 在 Beta update env 中写入通用 `RUNWEAVE_SOURCE_REVISION`；runweave-update、实例 control CLI 与 detached App Server 均默认继承该 env。App Server config 会读取该值，并同时写入 lock 与 `/healthz`。
- **Backend 传播链完整。** `electron/src/desktop-config.ts:31-48` 将编译期 `desktopSourceRevision` 注入 Electron 进程环境；`buildPackagedBackendBaseEnv()`、`buildPackagedBackendEnv()` 和 backend child spawn 都保留该环境，Backend `/health` 已按现有合约暴露 `RUNWEAVE_SOURCE_REVISION`。
- **严格 ownership 未降级。** `scripts/dev-session/services.mjs` 仍分别要求 Backend health、App Server lock/health 的 sourceRevision 与 service descriptor 完全相等；本轮没有增加 fallback、忽略字段或仅凭端口/PID通过的分支。
- **静态门禁通过。** 本轮独立执行目标脚本 ESLint、Node 语法检查、diff check、`pnpm typecheck`、`pnpm lint` 和 `pnpm dev:session:verify`，均以 0 退出；Dev Session verify 的 10 项检查全部通过。

## Findings

### P0/P1

无。

### 已修复

- **P1 resolved — Beta App Server 与 packaged Backend 未继承通用 sourceRevision。** 两条运行链均已绑定当前 git revision，且最终 ownership 校验保持严格。定位：`scripts/runweave-beta-operations.mjs:53-83`、`electron/src/desktop-config.ts:31-48`。
- **P1 resolved — builder 共享 dist 覆盖实例 main bundle。** Round 16 已真实确认 packaged main 写出完整 compiled identity，Round 15 修复生效。证据：`~/Library/Application Support/Runweave Beta/instances/dvs16-000-beta/user-data/beta-desktop-status.json`。

## 残余验证风险

本轮未重新执行 Beta full-app；下一轮 behavior_verify 仍需用全新实例确认 Backend `/health`、App Server lock 与 `/healthz` 的 sourceRevision 均等于 Session revision，并完成最终 ownership handshake。这是行为验收边界，不是当前代码复审发现的 P0/P1。
