# Runweave Dev Session 代码复审（Round 6）

## 结论

`case_24` 仍不通过。Round 5 的 4 个 P1 均已完成针对性修复：cleanup 不再依赖 CDP readiness，runtime build/install 已绑定实例 release，App Server restart 使用实例 control CLI，迁移 copy 失败也会清理全部目标。但显式 default 迁移的完成态仍有 1 个 P1：它只是原样复制旧单实例 App 与旧 update/status state，没有把 App 身份和状态转换为 default 实例，也没有强制下一次 full-app update。

## P1 阻断问题

1. **`migrate` 标记 completed，但复制出的 default App 仍是旧单实例身份，且后续 update 可能只做 runtime 更新。** 迁移把 `/Applications/Runweave Beta.app` 原样复制成 `/Applications/Runweave Beta default.app`，同时把旧 `beta-desktop-status.json` 和 `update/state.json` 原样复制到新 userData；没有重写 `CFBundleIdentifier/productName`、compiled `instanceId/userData/statusPath` 或状态中的旧路径。旧 bundle 配置身份是 `com.runweave.desktop.beta` / `Runweave Beta`，目标契约却要求 `com.runweave.desktop.beta.default`、`Runweave Beta default` 和实例 userData。更关键的是，复制的旧 state 会让 `hasPreviousState=true`；当 source shell 未升版且没有 native-sensitive diff 时，下一次普通 update 会选择 runtime mode，旧壳身份不会被重建。因此 migrate 可输出 `state=completed`，但 `open default` 仍写旧 userData/status 或被新 ownership check 判 stale，BIC-015 的“迁移后启动 default healthy”不成立。定位：`scripts/runweave-beta.mjs:118-178,194-243`、`electron/electron-builder.beta.yml:1-5`、`scripts/electron-dist-retry.mjs:202-209`、`scripts/runweave-update-core.mjs:344-429`、`scripts/runweave-beta-state.mjs:264-306`、`docs/testing/runweave-beta-instance-cdp-routing-test-cases.md:186-193`。修复方向：迁移提交时生成实例兼容 App，或把迁移结果明确置为“待 full-app conversion”并删除/转换会触发 runtime-only 的旧 update baseline，然后在标记 completed 前强制构建/安装并验证 default bundle id、productName、userData、status instanceId 与 health；失败时回滚新目标并保留旧 App。

## 已修复项

- Beta 安全终止已拆分 process ownership 与 CDP readiness；CDP 失败不再阻塞 cleanup/rollback。
- Runtime frontend/Electron build、artifacts、zip、manifest 和 install 已按实例路径与确定 releaseId 绑定，不再使用 `--latest`。
- App Server install/restart 已复用 `RUNWEAVE_CLI_BUNDLE_OUTFILE` 指向的实例 control CLI。
- 迁移 commit copy 失败时会逆序删除全部 planned targets，包括当前 copy 的部分副本。

## 验证证据

- `pnpm typecheck`：通过，覆盖 9 个 workspace project。
- `pnpm lint`：通过。
- `pnpm dev:session:verify`：10 项 checks 全部通过。
- `pnpm runweave:update:test-cases`：18 项通过。
- 目标脚本 ESLint：通过。
- `pnpm runweave:beta:verify -- --instance default`：静态路径/status contract 校验通过，输出实例专属 runtime build/artifacts/control CLI；本机 default 未运行。
- `git diff --check -- . ':(exclude)docs/review'`：通过。
- 当前自动化没有覆盖 BIC-015 的真实旧 App 迁移、启动 default、更新和回滚链路。

## 验证边界

本轮为 review-only 代码复审，没有执行会改动本机旧 Beta 的真实 migrate/install/start/rollback，也没有用 Computer Use 验收。上述 P1 来自确定的 byte-for-byte copy、旧 bundle identity 与 updater mode 判定控制流；BIC-015 应在修复后通过临时可控旧 Beta fixture 加真实桌面证据验收。
