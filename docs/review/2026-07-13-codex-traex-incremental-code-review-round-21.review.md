# Codex / TraeX capability parity 增量代码复审（Round 21）

## 结论

`case_14` **FAIL**。本轮以 index tree `04fce66722fb951b3542c616c7c53b8eee58c29e` 为唯一审查对象，完整阅读相对 `882dfadeec1b7da9c37353f69296e76019f35ed0` 的 3 个 staged path，并独立复跑 readiness、Agent Team consumer、真实 tmux capture 与仓库门禁。Round 20 的“旧 epoch 滑出 120 行窗口后合法 fresh ready 被拒绝”已修复；但无重叠 fallback 会把任何发生变化的 current snapshot 整体当作 fresh。真实终端在发送 `traex` 后会把末尾 prompt 行原地改写为 `prompt + traex`，即使尚未产生新 banner，也会因此复用旧 ready 并提前派发。保留 1 个开放 P1；另有 1 个失败原因延迟识别的 P2。

## Review checkpoint

- scope: `incremental`
- base commit / HEAD: `882dfadeec1b7da9c37353f69296e76019f35ed0`
- target tree / index: `04fce66722fb951b3542c616c7c53b8eee58c29e`
- requestedAt: `2026-07-13T10:04:13.195Z`
- staged paths: `backend/src/agent-team/agent-readiness.ts`、`packages/shared/src/terminal-agent-readiness.ts`、`scripts/verify-agent-team-review-checkpoints.mjs`
- diff 规模: 358 insertions、15 deletions
- `git diff --cached --check`: 通过
- prompt、run package、HEAD、index tree 与 staged path 完全一致

## 已修复边界

- 真实 `TRAE CLI Next + Explain this codebase` ready 保持可识别；无 banner suggestion 不会误报。
- 最后 banner epoch、startup failure、new banner 无 marker 与更晚 interactive prompt 的顺序判定保持正确。
- live owner guard 保持有效：null、shell 与跨 provider owner 不会消费历史 ready。
- Round 20 滚动窗口假阴性已修复：旧 ready epoch 被 120 行窗口淘汰、当前只保留新的完整 ready epoch 时，`hasTraeReadyPromptSince()` 返回 true，现有 consumer 在第五次读取后只写一次 idle。

## Remaining findings

### P1：snapshot 无重叠时把 prompt 改写误当作 fresh banner

`packages/shared/src/terminal-agent-readiness.ts:181-198` 尝试寻找 baseline 后缀与 current 前缀的最长逐行重叠；如果找不到，且两个 snapshot 不完全相等，就返回整个 current。随后 `hasTraeReadyPromptSince()` 只要在这段“fresh”文本里找到任意 `TRAE CLI Next` 即返回 true。

真实终端输入不是纯 append：baseline 最后一行通常是带光标的 shell prompt；发送 `traex\r` 后，同一行先变成 `prompt + traex`，shell preexec / pane metadata 又可在新 TUI 绘制前把 owner 切为 TraeX。此时 baseline 与 current 仅末行不同，但算法找不到“baseline 后缀 = current 前缀”的重叠，遂把包含旧 banner 的整个 current 当作 fresh。

直接函数矩阵返回：

```json
{
  "unchanged": false,
  "promptRewriteWithoutFreshBanner": true,
  "rolledFreshReady": true
}
```

独立真实 tmux capture 也得到 `baselineBanners=1`、`currentBanners=1`、唯一变化为 `bash-3.2$` → `bash-3.2$ traex`、`accepted=true`。进一步把该时序接入 `AgentTeamAgentReadinessService`，只在 `runtime.write()` 内切换 owner 并改写 prompt，不增加任何 banner/TUI 输出，服务仍返回：

```json
{
  "writes": ["traex\r"],
  "reads": 3,
  "starts": 1,
  "idles": 1,
  "activeCommand": "traex",
  "bannerCount": 1,
  "freshOutputAdded": false
}
```

这会在 TraeX 尚未 ready 时写入 idle并派发任务，重新打开 Round 19 的阻断路径。修复不能把“无文本重叠”本身视为启动后证据；应使用可靠的 launch generation、输出 byte/event offset 或其他与本次发送动作绑定的边界，并明确保证 prompt echo / resize / reflow 不能使旧 epoch 变 fresh。

现有 fixture 没覆盖该顺序：`runtime.write()` 只切换 owner、不改写 scrollback，前几次读取因此与 baseline 完全相等；第四次读取才直接替换为滚动后的完整新 ready。应加入“owner 已切换 + prompt 行已改写 + 新 banner 尚未出现”的中间态，并断言不能 idle。

### P2：滚动窗口中的新 startup failure 仍可能被旧 failure 计数抵消

`packages/shared/src/terminal-agent-readiness.ts:109-123` 仍以整个 current/baseline snapshot 的 failure match 数量作增量判断。旧 failure 滑出窗口、新 failure 进入窗口时，两侧数量都为 1；尽管 `hasTraeStartupFailure(current)=true`，`hasTraeStartupFailureSince(current, baseline)` 仍返回 false。独立矩阵得到：

```json
{
  "currentIsFailure": true,
  "baselineFailures": 1,
  "currentFailures": 1,
  "newFailureDetectedSince": false
}
```

ready 路径仍会拒绝该 failure 状态，所以不会错误派发任务；但 `waitForAgentUi()` 不会立即抛出带 `reason=startup_failure` 的 409，而会继续轮询到 15 秒通用 timeout，延迟并降低诊断精度。失败 freshness 应与 ready 使用同一个可靠启动边界，而不是全窗口计数。

## 已执行检查

- `git write-tree`: `04fce66722fb951b3542c616c7c53b8eee58c29e`；3 个 changed paths 与 prompt 一致。
- 独立 readiness 函数矩阵：未变化 snapshot 为 false，滚动后的 fresh ready 为 true，但 prompt-only 改写错误返回 true。
- 独立真实 tmux prompt-rewrite capture：单一旧 banner、无新 TUI 输出时 `accepted=true`。
- 独立 Agent Team consumer：无 fresh 输出仍发生一次 starting、一次 idle，稳定复现 P1。
- 独立 failure rollover 矩阵：current 明确为 startup failure，但 since 判定为 false。
- `pnpm agent-team:verify-review-checkpoints`: 34 项通过；fixture 未覆盖 prompt 行原地改写。
- `pnpm toolkit:verify-hooks`: 通过。
- `pnpm app-server:verify-state-sync`: 通过。
- `pnpm typecheck`: 通过。
- `pnpm lint`: 通过。
- `pnpm runweave:update:test-cases`: 18/18 通过。

补充 consumer harness 首次以 top-level await 运行时因 `tsx --eval` 的 CJS 输出限制失败；改为 async IIFE 后在同一 target 上成功重跑并复现上述结果。这是 harness 调用方式问题，不改变产品结论。静态与现有 fixture 门禁通过不能覆盖已执行复现的 prompt-rewrite 时序错误。由于仍有 P1，本轮不应进入 behavior verification。

本轮只新增此 review 文档与指定 pane outbox；未修改源码、测试、Git index 或 HEAD。
