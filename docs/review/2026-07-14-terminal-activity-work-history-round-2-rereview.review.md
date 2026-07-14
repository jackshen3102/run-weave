# Terminal Activity Work History Code Review（Round 2 重新派发）

## 结论

`case_25` 通过。对 `targetTree=d5b58cfcda7f3a5947f77c5e3c34c5bbad9372f8` 的完整 staged diff 重新核验后，未发现开放或新增的 P0/P1；Round 1 的 `codex-thread-timestamp-unit` 保持已修复状态。

## Review checkpoint

- scope：`full`
- baseCommit：`d67a1ae9836249082368c17075bcdac25f6030cb`
- targetTree：`d5b58cfcda7f3a5947f77c5e3c34c5bbad9372f8`
- changedPaths：27 个，与本轮 prompt/run package 完全一致
- planSha256：`7d0ef294770bdbe3e3081ea32ccd2edcdee0bc46dc846051a9aad2319cbb8d42`
- testCaseSha256：`c92e190387c6a929239e61f960018b429d634053934ee61d045841df2d2210de`
- requestedAt：`2026-07-13T22:26:53.034Z`
- `HEAD` 等于 baseCommit，`git write-tree` 等于 targetTree，`git diff --cached --check` 通过。

## Resolved finding

### P1 resolved：Codex 数值时间戳按 Unix 秒转换

- invariantKey：`codex-thread-timestamp-unit`
- 定位：`app-server/src/codex-app-server-client.ts:599-604`
- Round 1 失败树到当前树只有该文件 1 行变化：number 分支乘 `1_000`，字符串日期路径不变。
- 独立真实复测 Thread `019f5cc6-59e8-72d3-a175-48503488008b`：`availability=available`；Thread 时间为 `2026-07-13T18:38:50.000Z` 至 `2026-07-13T22:27:48.000Z`，三个 Turn 的已记录时间均为 2026，`allDatesAre2026=true`。
- 当前数据包含 completed 与 interrupted Turn，均未再出现 1970 时间。

## 已执行检查

- 真实 `CodexAppServerClient.readThreadDetail` probe：通过。
- `pnpm work-history:verify`：通过。
- `pnpm app-server:verify`：通过。
- `pnpm app-server:verify-state-sync`：通过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `git diff --cached --check`：通过。

## 残余风险

本结论只关闭代码审查门禁 `case_25`，不替代后续 `behavior_verify` 对 AGT-WH-001 至 AGT-WH-024 的完整行为验收。
