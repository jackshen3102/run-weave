# Terminal Activity Work History Code Review（Round 2）

## 结论

`case_25` 通过。Round 1 的 P1 `codex-thread-timestamp-unit` 已修复；对新的完整 staged checkpoint 复审后，未发现仍开放或新增的 P0/P1。

## Review checkpoint

- scope：`full`
- baseCommit：`d67a1ae9836249082368c17075bcdac25f6030cb`
- targetTree：`d5b58cfcda7f3a5947f77c5e3c34c5bbad9372f8`
- changedPaths：27 个，与本轮 prompt 和 run package 完全一致
- planSha256：`7d0ef294770bdbe3e3081ea32ccd2edcdee0bc46dc846051a9aad2319cbb8d42`
- testCaseSha256：`c92e190387c6a929239e61f960018b429d634053934ee61d045841df2d2210de`
- `HEAD` 等于 baseCommit，`git write-tree` 等于 targetTree，`git diff --cached --check` 通过。

## Resolved finding

### P1 resolved：Codex 数值时间戳按 Unix 秒转换

- invariantKey：`codex-thread-timestamp-unit`
- 定位：`app-server/src/codex-app-server-client.ts:599-604`
- Round 1→2 的真实 tree delta 只有此文件 1 行：number 分支先乘 `1_000`，字符串日期保持原解析路径。
- 独立真实复测：读取 Thread `019f5cc6-59e8-72d3-a175-48503488008b`，返回 `availability=available`；Thread 时间为 `2026-07-13T18:38:50.000Z` 至 `2026-07-13T18:47:33.000Z`，Turn 时间为 `2026-07-13T18:40:34.000Z` 至 `2026-07-13T18:47:33.000Z`，所有日期均为 2026 年。
- 同场景证据复核：`dvs-aa315e` 的同一 Terminal `f6a20cd2`、同一 Thread `019f5d04-16d3-7293-9ff4-2c19df4bbe64` 从 Before 的 1970 错序恢复为 After 的 2026 正确顺序，`chronologyValid=true`、控制台错误数为 0。
- dedicated 资源清理复核：Electron、Backend、App Server 三个记录 PID 均已停止。

## 已执行检查

- 真实 `CodexAppServerClient.readThreadDetail` probe：通过，`allDatesAre2026=true`。
- `pnpm work-history:verify`：通过。
- `pnpm app-server:verify`：通过。
- `pnpm app-server:verify-state-sync`：通过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `git diff --cached --check`：通过。

## 残余风险

本轮结论只关闭代码审查门禁 `case_25`，不替代后续 `behavior_verify` 对 AGT-WH-001 至 AGT-WH-024 的完整行为验收。
