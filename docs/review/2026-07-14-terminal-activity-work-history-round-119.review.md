# Terminal Activity Work History Code Review（Round 119）

## 结论

`case_25` 通过。增量 diff 未发现仍存在的阻断性问题；此前 `behavior_verify` 在必跑用例因环境阻塞而返回 `skipped` 后持续空转的问题已关闭。

## Review checkpoint

- scope：`incremental`
- baseCommit：`edefdf9d01f8252c3d2815aa5fdf21568d748e3b`
- targetTree：`f6404f8effd21972807c6690ede0524b41f41e33`
- changedPaths：`backend/src/agent-team/service-execution.ts`
- planSha256：`7d0ef294770bdbe3e3081ea32ccd2edcdee0bc46dc846051a9aad2319cbb8d42`
- testCaseSha256：`c92e190387c6a929239e61f960018b429d634053934ee61d045841df2d2210de`
- requestedAt：`2026-07-13T23:38:06.869Z`
- `HEAD`、staged tree、文件范围、两份文档哈希和 diff check 均精确匹配。

## 失败链路与消费者核对

- `foldRound` 对 `skipped` 保留原 `status`，同时写入 `lastRunStatus=skipped`；本次新增分支只选择 `pending + skipped`。
- `dispatchSerialWorker` 会把本轮必跑 behavior cases 重置为 `pending`，而未受影响的既有通过项保持 `pass`。因此新条件能识别“必跑但未完成”，不会误伤选择性跳过的通过项。
- 当前结果含真实 `fail` 时 guard 会排除环境阻塞分支，继续进入 repair/bounce 逻辑。
- 环境阻塞分支设置 `status=need_human`、`loop.escalated=true`、写入可定位原因、冻结所有 worker，并清除 active role/dispatch；同时不增加 repair attempt。
- 历史 outbox 与 run logs 显示同一组 pending/skipped cases 曾从 Round 53 重复至 Round 118；新增分支在该真实状态形态下能够终止空转。

## 独立验证

- 临时目录真实 `applyRound` 三分支探针：
  - 必跑 `pending + skipped`：`need_human`、冻结、active 清空、repair cycle 不增加。
  - 当前含真实 `fail`：保持 `running`，失败 case 保持 `fail`，未误升级环境阻塞。
  - 仅跳过既有 `pass`：通过项保持 `pass`，run 可进入 `done`。
- `pnpm agent-team:verify-review-checkpoints`：通过。
- `pnpm --filter @runweave/backend typecheck`：通过。
- `pnpm --filter @runweave/backend lint`：通过。
- `git diff --check edefdf9d01f8252c3d2815aa5fdf21568d748e3b f6404f8effd21972807c6690ede0524b41f41e33`：通过。

## 残余风险

现有持久化 verifier 尚未单列这一新分支；本轮用独立真实 `applyRound` 探针覆盖了正向、失败优先和选择性跳过三个回归点。该覆盖缺口不构成当前阻断项。
