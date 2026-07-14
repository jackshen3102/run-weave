# Terminal Activity Work History Code Review（Round 1）

## 结论

`case_25` 不通过。完整 staged diff 存在 1 个未修复 P1：Codex App Server 返回的数值时间戳是 Unix 秒，当前归一化按 JavaScript 毫秒时间戳处理，导致真实 Thread/Turn 时间全部落到 1970 年。该错误会直接破坏 Terminal Journal 的时间展示和排序，属于本次 Work History 核心路径的阻断性正确性问题。

## Review checkpoint

- scope：`full`
- baseCommit：`d67a1ae9836249082368c17075bcdac25f6030cb`
- targetTree：`b5de1a8a024a5579ad590d877bec959545e589bd`
- changedPaths：27 个，与本轮 prompt 完全一致
- planSha256：`7d0ef294770bdbe3e3081ea32ccd2edcdee0bc46dc846051a9aad2319cbb8d42`
- testCaseSha256：`c92e190387c6a929239e61f960018b429d634053934ee61d045841df2d2210de`
- `HEAD` 等于 baseCommit，`git write-tree` 等于 targetTree，`git diff --cached --check` 通过。

## Remaining finding

### P1：Codex 秒级时间戳被当成毫秒，真实 Journal 时间落到 1970 年

- 定位：`app-server/src/codex-app-server-client.ts:459-460`、`:486-489`、`:599-604`
- 原因：`normalizeDate` 对 number 直接执行 `new Date(value)`。Codex 0.144.1 的 `thread/read(includeTurns=true)` 返回 Unix 秒；JavaScript 将 number 解释为毫秒。
- 真实证据：对本 run 的 Thread `019f5cc6-59e8-72d3-a175-48503488008b` 调用新增 `readThreadDetail`，返回 `availability=available`，但 `createdAt=1970-01-21T15:32:47.930Z`、`updatedAt=1970-01-21T15:32:48.453Z`，Turn 的 `startedAt/completedAt` 同样为 1970 年；该 Thread 的真实活动时间是 2026-07-13。
- 影响：`buildTerminalJournal` 直接按这些 ISO 时间排序，Thread/Turn 会被排到 Terminal 创建之前，并向用户展示错误时间；AGT-WH-004 的稳定异构排序及核心历史语义不成立。
- 修复方向：按 Codex 协议把有限数值时间戳从 Unix 秒转换为毫秒后再生成 ISO；字符串时间保持现有 ISO 解析。同时让验证脚本覆盖真实协议形态的秒级 Thread/Turn 时间戳，并断言年份和相对排序。
- invariantKey：`codex-thread-timestamp-unit`
- verificationMode：`runtime`

## 已执行检查

- `pnpm work-history:verify`：通过；覆盖档案身份、显式 ThreadRef、Facts 快照分页、降级、并发上限和 Round 归属。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm build`：通过。
- `git diff --cached --check`：通过。
- 真实 Codex detail probe：失败语义已复现，证明现有 verifier 的 fixture 未覆盖实际数值时间戳单位。

## 残余风险

本轮是只读代码审查，没有替代 `behavior_verify` 执行 AGT-WH-001 至 AGT-WH-024 的完整 Dev Session/Playwright 行为验收。P1 修复后应至少重新运行真实 Codex Thread detail，并确认 Thread/Turn 时间位于真实 2026 时间轴，再进入页面级验收。
