# Codex / TraeX capability parity 增量代码复审（Round 20）

## 结论

`case_14` **FAIL**。本轮以 index tree `d3439c6b698c56c4cbc200123ab8e2dd0f2365d6` 为唯一审查对象，完整阅读相对 `882dfadeec1b7da9c37353f69296e76019f35ed0` 的 3 个 staged path，并独立重跑 readiness、Agent Team consumer 与仓库门禁。Round 19 的“owner 已切换但 fresh 输出尚未出现时复用旧 ready”已修复；但当前 freshness 实现把两次独立的 120 行 tmux capture 当作单调追加日志，以 banner 总数增长作为新启动凭据。独立 tmux 滚动窗口 harness 证明：旧 banner 被窗口淘汰、当前窗口只保留新的完整 ready UI 时，两侧 banner 数仍同为 1，合法启动被拒绝并最终超时。保留 1 个开放 P1。

## Review checkpoint

- scope: `incremental`
- base commit / HEAD: `882dfadeec1b7da9c37353f69296e76019f35ed0`
- target tree / index: `d3439c6b698c56c4cbc200123ab8e2dd0f2365d6`
- requestedAt: `2026-07-13T09:49:03.107Z`
- staged paths: `backend/src/agent-team/agent-readiness.ts`、`packages/shared/src/terminal-agent-readiness.ts`、`scripts/verify-agent-team-review-checkpoints.mjs`
- diff 规模: 310 insertions、14 deletions
- `git diff --cached --check`: 通过
- prompt、run package、HEAD、index tree 与 staged path 完全一致

## 已修复边界

- 真实 `TRAE CLI Next + Explain this codebase` ready 保持可识别；无 banner 的 suggestion 不会误报。
- 最后 banner epoch、startup failure、new banner 无 marker 与更晚 interactive prompt 的顺序判定保持正确。
- Agent Team 每次 ready 判断先验证 live owner；null、shell 与跨 provider owner 不会消费历史 ready。
- 正向 ready 已接入 `traeStartupBaseline`：未变化的旧 scrollback 返回 false，只有 append-only fixture 中出现新增 banner 才返回 true，关闭了 Round 19 的提前派发路径。

独立 readiness 矩阵得到：`oldReadyRecognized=true`、`unchangedBaselineAccepted=false`、`freshEpochAccepted=true`、`laterFailureReady=false`、`laterFailureDetected=true`、`laterFailureSince=true`、`newEpochWithoutReady=false`、`laterInteractiveReady=false`。现有 Agent Team consumer fixture 也验证了一次启动、一次 starting、fresh 输出后一次 idle。

## Remaining finding

### P1：按 banner 总数比较无法识别滚动 tmux 快照中的合法 fresh ready

`backend/src/agent-team/agent-readiness.ts:91-100` 在启动前保存一次 scrollback，后续 `:339-348` 对 tmux pane 每次独立执行 `capturePane(..., 120)`；这些值是有界快照，不保证当前文本以前一个 baseline 为前缀。`packages/shared/src/terminal-agent-readiness.ts:89-103` 却要求当前快照中的 `TRAE CLI Next` 总数严格大于 baseline 总数。

独立 tmux fixture 在不使用 alternate screen 的情况下，先输出一个旧的完整 ready epoch 和 80 行后续内容，取得 120 行 baseline；再输出 70 行新启动内容与新的完整 ready epoch，使旧 epoch 正常滑出 120 行窗口。当前 target 返回：

```json
{
  "baselineLines": 89,
  "currentLines": 144,
  "baselineBanners": 1,
  "currentBanners": 1,
  "baselineReady": true,
  "currentReady": true,
  "accepted": false
}
```

当前快照明确包含新的 `TRAE CLI Next + Explain this codebase`，live owner 也可正确变为 TraeX，但 banner 数没有增长，因此 `hasTraeReadyPromptSince()` 永远拒绝这次合法启动，`waitForAgentUi()` 最终在 15 秒后抛出 409 timeout，阻断 Agent Team 任务派发。alternate-screen fixture 也得到同类结果，但上述复现已证明问题不依赖 alternate screen。

现有 `verifyTraeReadinessOwner()` 仅通过 `session.scrollback = old + new` 构造 append-only 字符串，并断言 banner 数从 1 增加到 2；它没有覆盖生产代码的 120 行滚动 capture 语义。修复需要使用不会依赖快照内容保留的 launch generation / pane event boundary，或在当前启动 owner 生效后结合当前 epoch 的完整 ready 与可靠时间边界判定；不能用两个有界窗口的全局 match count 作增量游标。fixture 应加入旧 epoch 被窗口淘汰而新 epoch 完整存在的场景。

## 已执行检查

- `git write-tree`: `d3439c6b698c56c4cbc200123ab8e2dd0f2365d6`；3 个 changed paths 与 prompt 一致。
- 独立 readiness epoch 矩阵：8 个关键状态均符合预期。
- 独立 120 行 tmux 滚动窗口 harness：稳定复现 `baselineBanners=1`、`currentBanners=1`、`currentReady=true`、`accepted=false`。
- `pnpm agent-team:verify-review-checkpoints`: 33 项通过；现有 fresh-ready fixture 仅覆盖 append-only scrollback。
- `pnpm toolkit:verify-hooks`: 通过。
- `pnpm app-server:verify-state-sync`: 通过。
- `pnpm typecheck`: 通过。
- `pnpm lint`: 通过。
- `pnpm runweave:update:test-cases`: 18/18 通过。

补充 readiness 矩阵首次从 workspace 根执行 `pnpm exec tsx` 时因根包未安装 `tsx` 返回 254；随后使用仓库既有的 `pnpm --dir backend exec tsx` 入口独立重跑并通过。这是命令入口问题，不改变上述产品 finding。静态与既有 fixture 门禁通过不能覆盖已执行复现的滚动快照错误。由于仍有 P1，本轮不应进入 behavior verification。

本轮只新增此 review 文档与指定 pane outbox；未修改源码、测试、Git index 或 HEAD。
