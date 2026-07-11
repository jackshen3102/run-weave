# Runweave Dev Session 代码复审（Round 7）

## 结论

`case_24` 通过。本轮未发现仍未修复的 P0/P1。Round 6 唯一剩余的 default 迁移身份问题已闭环：旧 App、旧 desktop status 和旧 update state 只进入 migration backup，不提交到新实例；迁移随后强制执行 instance-aware full-app + App Server update，并在标记 completed 前完成运行时健康与 bundle/instance identity 校验。

## 阻断问题复核

- **旧壳不再进入 default 实例。** 旧 `/Applications/Runweave Beta.app` 使用 `commit=false`，只备份；新 `/Applications/Runweave Beta default.app` 必须由 updater 重新构建安装。定位：`scripts/runweave-beta.mjs:153-160,220-249`。
- **旧 identity state 不再污染 updater。** `beta-desktop-status.json` 与 `update` 目录使用 `commit=false`，因此新实例不会继承旧 PID/path，也不会因旧 `hasPreviousState` 误选 runtime-only。可复用的 profile、CLI、runtime 与 App Server 数据仍按迁移计划复制。定位：`scripts/runweave-beta.mjs:161-199,241-249`。
- **迁移强制完成实例壳转换。** migration 内部固定调用 `update(..., ["--mode","app","--app-server","update"], {throwOnFailure:true})`；更新流程会等待 Desktop、Backend、双 CDP 和 App Server 健康后返回。定位：`scripts/runweave-beta.mjs:245-249,302-413`、`scripts/runweave-beta-operations.mjs:239-272`。
- **完成态有身份门禁。** completed 前校验 `CFBundleIdentifier`、`CFBundleName`、state mode、instanceId、App path、userData path 与 desktop health；任何不一致进入 rolled-back。定位：`scripts/runweave-beta.mjs:250-299`。
- **失败恢复保留旧安装与备份。** 转换失败会安全停止新 App/App Server，删除新实例 App/userData/App Server/build/control/runtime artifacts，journal 写 rolled-back；旧源与 migration backup 均不删除。定位：`scripts/runweave-beta.mjs:266-287`。

## 已修复项

- Default 迁移原样复制旧 Bundle 和旧 update/status state，完成态不满足实例 ownership。
- CDP readiness 失败阻塞 cleanup/rollback。
- Runtime update 通过共享 `--latest` 选择产物。
- App Server restart 回退到 ignored 的共享 CLI dist。
- 迁移 copy 失败残留部分 target。

## 验证证据

- `pnpm typecheck`：通过，覆盖 9 个 workspace project。
- `pnpm lint`：通过。
- `pnpm dev:session:verify`：10 项 checks 全部通过。
- `pnpm runweave:update:test-cases`：18 项通过。
- 目标脚本 ESLint：通过。
- `pnpm runweave:beta:verify -- --instance default`：静态路径/status contract 校验通过，包含实例专属 build、runtime artifacts、runtime build 与 control CLI。
- `git diff --check -- . ':(exclude)docs/review'`：通过。

## 残余验证边界

本轮是代码复审，没有对本机执行真实旧 Beta migrate/install/start/rollback，也没有使用 Computer Use/Playwright。该行为证据属于后续 `behavior_verify`，不构成本轮代码评审的未修复 P0/P1；BIC-015 仍应按测试文档执行真实迁移与桌面身份验收。
