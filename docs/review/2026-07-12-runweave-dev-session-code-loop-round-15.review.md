# Runweave Dev Session Loop Round 15 代码复审

## 结论

`case_24` 通过。本轮未发现仍未修复的 P0/P1。Round 14 的 DVS-020 rollback Backend profile 漂移已按根因修复：恢复后的 Beta Desktop 不再经由丢失 target env 的 LaunchServices `open -n` 启动，而是直接启动目标实例 executable，并同时注入实例路径和 baseline revision；App Server restart 也显式使用同一 baseline revision。

## 复审依据

- `scripts/runweave-beta-operations.mjs:162-185` 的 `openBeta()` 直接启动 `paths.appPath/Contents/MacOS/paths.appName`，默认从实例 state 的已部署 revision 与 `paths` 重建 launch env。
- `scripts/runweave-beta-operations.mjs:48-83` 的 `buildUpdateEnv()` 明确覆盖 `BROWSER_PROFILE_DIR`、userData、instanceId、Desktop/Terminal Browser CDP ports、CLI config、App Server home 和 source revision，避免这些关键字段回退到 Stable terminal 的 ambient/default 值。
- `scripts/runweave-beta-operations.mjs:204-257` 的 `restoreBaseline()` 从 `baseline.source.gitHead` 恢复旧 revision，并将同一 revision用于 App Server restart 与恢复后的 Beta App 启动。
- `scripts/runweave-beta.mjs:416-444` 在 `restoreBaseline()` 完成后将 state 的 `gitHead`、runtime/App Server release、sourceRoot 与 worktree snapshot 一并恢复，并继续通过完整 Desktop/Backend/CDP/App Server readiness，而非放宽健康或身份判断。
- 独立污染环境探针通过：ambient profile/revision 故意设为错误值后，假 Beta executable 实际收到目标实例 profile、userData、instanceId、19335/19336 两个 CDP 端口、App Server home 与 `baseline-review-r15` revision。

## Findings

### P0/P1

无。

### 已修复

- **P1 resolved — rollback 重新启动 Beta 时丢失实例 launch env，Backend 回退到默认 profile。** `openBeta()` 改为直接启动实例 executable；`restoreBaseline()` 为 Desktop/Backend 与 App Server 统一注入 baseline revision 和实例级路径。
- **P1 resolved — 空 shared App Server PID 阻断实例 lock PID fallback。** 正整数 PID 序列化与旧状态 lock fallback 保持有效。
- **P1 resolved — stale Session 缺少结构化恢复与安全 cleanup。** 既有 recovery 与 identity-safe cleanup 路径保持有效。

## 验证证据

- 污染环境启动探针：`{"ok":true,"observed":{"revision":"baseline-review-r15","instanceId":"review-r15","desktopCdpPort":"19335","terminalCdpPort":"19336"}}`，profile/userData/App Server home 均为临时实例目录。
- `pnpm dev:session:verify`：21 项 checks 全部通过。
- `pnpm runweave:update:test-cases`：18 项全部通过。
- `pnpm runweave:beta:verify`：通过，实例隔离路径和 status contract 正常。
- `pnpm typecheck`、`pnpm lint`、目标 ESLint、Node syntax、目标 Prettier、`git diff --check -- . ':(exclude)docs/review'`：全部通过。

## 残余验证边界

本轮是只读代码复审，没有替代后续 `behavior_verify` 对 DVS-020 的真实双 Beta 更新/rollback、Backend readiness、Playwright attach 与 Stable 不变性复验。该运行时复验属于后续验收，不构成当前未修复的 P0/P1。
