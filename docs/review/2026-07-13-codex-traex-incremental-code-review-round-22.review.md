# Codex / TraeX capability parity 增量代码复审（Round 22）

## 结论

`case_14` **FAIL**。本轮以 index tree `82517d5711f5bd0a6454952a0c464650deccf1a1` 为唯一审查对象，完整阅读相对 `882dfadeec1b7da9c37353f69296e76019f35ed0` 的 3 个 staged path，并独立复跑 readiness、Agent Team consumer、真实 tmux 光标重绘与仓库门禁。Round 21 的简单 prompt-rewrite P1 和 failure-rollover P2 已修复；但新的文本边界仍把“current 头部与 baseline 任意片段的最长公共前缀”当作 retained 区域。只要 banner 前的一行发生局部重绘，旧 banner 就会重新落入 fresh suffix 并提前派发；完全滚出 baseline 的合法新 ready 又因无公共片段被永久拒绝。保留 1 个开放 P1。

## Review checkpoint

- scope: `incremental`
- base commit / HEAD: `882dfadeec1b7da9c37353f69296e76019f35ed0`
- target tree / index: `82517d5711f5bd0a6454952a0c464650deccf1a1`
- requestedAt: `2026-07-13T10:16:43.270Z`
- staged paths: `backend/src/agent-team/agent-readiness.ts`、`packages/shared/src/terminal-agent-readiness.ts`、`scripts/verify-agent-team-review-checkpoints.mjs`
- diff 规模: 399 insertions、16 deletions
- `git diff --cached --check`: 通过
- prompt、run package、HEAD、index tree 与 staged path 完全一致

## 已修复边界

- 真实 `TRAE CLI Next + Explain this codebase` ready、最后 startup epoch、交互提示优先级与 live owner guard 均保持正确。
- Round 21 的精确 prompt 改写已修复：只把最后一行 `prompt` 改成 `prompt + traex` 时，baseline 前缀可匹配到 banner 之后，fresh suffix 不再包含旧 banner。
- Round 20 的 120 行部分滚动 fixture保持通过：current 仍保留 baseline 中一段连续内容时，新 ready 可以识别。
- startup failure 已改为复用同一 snapshot suffix；旧 failure 滑出、current 仍保留 baseline 片段且新 failure 进入时能够立即识别。

## Remaining finding

### P1：任意片段的公共前缀不能作为本次 launch 的可靠输出边界

`packages/shared/src/terminal-agent-readiness.ts:174-198` 对每个 `baselineStart` 计算 `current` 头部与 baseline 片段的最长逐行匹配，但不要求该匹配一直延伸到 baseline 末尾，也不证明它就是当前窗口实际保留的历史。随后 `hasTraeReadyPromptSince()` 把匹配长度后的整个 current 当作 fresh。

这产生双向错误：

1. **局部重绘会复用旧 ready。** baseline 为 `stable header / status idle / 旧 ready / prompt`，发送启动命令后仅把第二行改为 `status starting`、最后一行改为 `prompt + traex`，没有新 banner。算法只保留第一行匹配，fresh suffix 因而包含旧 `TRAE CLI Next`，返回 true。
2. **完全滚动会拒绝合法 ready。** current 的 120 行全部来自启动后的新输出、与 baseline 没有任何共同片段，但末尾包含完整新 ready；算法返回空 fresh suffix，返回 false并最终 timeout。

直接函数矩阵返回：

```json
{
  "partialRedrawWithoutFreshBanner": true,
  "completeRolloverWithFreshReady": false
}
```

独立真实 tmux fixture 使用光标定位只更新旧 UI banner 前的 `status idle` 为 `status starting`，未输出任何新 banner；baseline/current banner 数保持不变，当前函数仍返回 `accepted=true`。把同一时序接入 `AgentTeamAgentReadinessService`，只在 `runtime.write()` 内切换 owner并局部重绘，不新增 banner，服务仍返回：

```json
{
  "writes": ["traex\r"],
  "reads": 3,
  "starts": 1,
  "idles": 1,
  "bannerCount": 1,
  "freshBannerAdded": false
}
```

因此 Agent Team 仍可能在 TraeX 尚未 ready 时写 idle并派发任务；相反，超过整个 120 行 capture 的合法启动会被阻断。这不是再增加文本匹配分支能可靠消除的歧义：两个独立 terminal snapshot 没有单调 generation。修复方向应是记录与 `sendAgentStartCommand()` 同一运行时关联的输出 generation / byte offset / pane event boundary，并只接受该边界之后的 ready/failure；若 tmux 侧无法提供该边界，应显式引入 pane-local launch nonce/状态事件，而不是把内容相似度当顺序证明。

现有 fixture 没覆盖这两端：prompt case 只改最后一行；滚动 case只追加 70 行，因此 current 仍从 baseline 中段开始。应加入 banner 前局部 redraw 和 120 行完全无保留 rollover 两条负向/正向 consumer 场景。

## 已执行检查

- `git write-tree`: `82517d5711f5bd0a6454952a0c464650deccf1a1`；3 个 changed paths 与 prompt 一致。
- 独立 Round 21 回归矩阵：简单 prompt rewrite 为 false；部分滚动 fresh ready 与 failure 均通过。
- 独立边界矩阵：banner 前局部 redraw 无 fresh banner仍返回 true；完全滚动后的完整新 ready返回 false。
- 独立真实 tmux 光标重绘：banner 数未增长、只更新旧 UI 行时 `accepted=true`。
- 独立 Agent Team consumer：`freshBannerAdded=false` 时仍发生一次 starting、一次 idle。
- `pnpm agent-team:verify-review-checkpoints`: 36 项通过；fixture未覆盖局部 redraw与完全 rollover。
- `pnpm toolkit:verify-hooks`: 通过。
- `pnpm app-server:verify-state-sync`: 通过。
- `pnpm typecheck`: 通过。
- `pnpm lint`: 通过。
- `pnpm runweave:update:test-cases`: 18/18 通过。

静态与现有 fixture 门禁通过不能覆盖已执行复现的 snapshot 顺序歧义。由于仍有 P1，本轮不应进入 behavior verification。

本轮只新增此 review 文档与指定 pane outbox；未修改源码、测试、Git index 或 HEAD。
