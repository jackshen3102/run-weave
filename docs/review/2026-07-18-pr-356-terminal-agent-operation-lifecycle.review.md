# PR #356 `fix terminal agent operation lifecycle` 代码评审

## 结论

PR 试图解决的两个生命周期竞态都是真问题，但以当前仓库状态看不应继续合并：PR 已落后 `main` 9 个提交且处于 `CONFLICTING / DIRTY`，两处生产修复都已由 PR #361 以相同或更完整的形式进入 `main`。

若只评价 PR #356 在原始基线上的效果：

- “准备期间瞬时非 Agent 命令清掉 operation generation”可以解决。
- “activeCommand 已清空后的可信 Stop hook 被误拒”只能覆盖部分状态，不能保证解决。

建议关闭 PR #356，并标记为 superseded by PR #361，而不是继续 rebase 或解决冲突。

## 它要解决什么问题

1. `prepareTerminalAgent` 已登记 panel preparation 和 operation generation 后，会调用 `resolvePanelTarget`。该过程可能触发 tmux workspace reconciliation；如果这时 pane 暂时上报 `tmux`、`export` 等非 Agent 命令，`observeActiveCommand` 会清掉 operation generation。后续 `assertPreparationTargetCurrent` 因 identity 已丢失而取消本来仍有效的启动。
2. Agent 已完成、tmux `activeCommand` 已清空时，App Server 仍可能收到当前 thread 的可信 Stop/idle 生命周期事件。旧逻辑把 Stop 排除在 terminal-state fallback 之外，可能返回 `inactive_agent`，使完成状态无法落盘。

## 发现

### P1 阻断：PR 已被 PR #361 完整替代且当前不可合并

PR #356 的 `backend/src/terminal/manager-agent-activity-runtime.ts:114-121` 已原样进入 `main`。它在 preparation 活跃时保留 operation generation，这是正确的第一处修复。

PR #356 的 `backend/src/terminal/agent-hook-processor.ts:259-267` 则被 PR #361 的更强规则替代：最新 `main` 在 inactive-agent 拒绝条件中直接增加 `!currentThreadIdentityMatched`，使可信 operation/thread identity 成为独立权威，不再依赖 activeCommand、grace 或 terminalState 是否仍携带 agent。

GitHub 当前状态为 Draft、`mergeable=CONFLICTING`、`mergeStateStatus=DIRTY`；分支相对最新 `main` 为落后 9 个提交、仅领先 1 个提交。

修复方向：关闭 PR #356，并关联已合并的 PR #361；不要继续 rebase 产生空洞或重复修复。

### P1 严重：Stop hook 修复仍错误依赖 terminalState.agent

`backend/src/terminal/agent-hook-processor.ts:259-267` 仅在 `currentTargetState.agent === effectiveAgent && currentThreadIdentityMatched` 时接受 Stop fallback。

但 PR 描述的竞态本身就可能同时把 panel 归并为 `shell_idle / agent=null`。此时 thread identity 即使可信，新增 fallback 仍为 false，Stop hook 仍会被判为 `inactive_agent`。因此该修改不能保证覆盖它声称修复的全部时序。

修复方向：采用当前 `main` 已有的规则——在 identity 已匹配时直接跳过 inactive-agent 活跃性拒绝；operation/thread identity 负责“是不是当前操作”，activeCommand/grace/state 只负责无 identity 时的兼容判断。

### P2 一般：验证没有隔离 Stop fallback 的新增分支

`scripts/verify-agent-team-review-checkpoints/bootstrap-lifecycle-core.mjs:452-510` 的可信 idle 事件检查看似相关，但 fixture 在此前仍保持 `panel.activeCommand = "codex"` 和 Agent terminal state。此时 `currentCommandMatches` 已经为 true，即使删除 PR 对 `canFallbackToCurrentStateAgent` 的修改，该检查仍可通过。

第一处 generation 修复由 `bootstrap-lifecycle-core.mjs:78-128` 的 `activeCommand="export"` 重用 panel 场景间接覆盖；第二处 Stop fallback 缺少 `activeCommand=null`、`terminalState.agent=null`、thread identity 匹配的定向断言。

GitHub 的唯一 `quality` check 已通过，但仓库 CI 只执行 lint/typecheck；PR body 声称运行的 `pnpm agent-team:verify-review-checkpoints` 没有独立 CI job 或日志证据。本次只读评审未重跑 PR head。

修复方向：若未来再改此链路，增加一个明确隔离 identity-authoritative Stop 行为的 review-checkpoint fixture，并让 CI 或可追溯日志执行该验证。

## 正向判断

- `manager-agent-activity-runtime.ts:114-121` 的 preparation guard 路径短、状态所有权清晰，和 `begin/end/releasePanelAgentPreparation` 的生命周期一致。
- harness 对异步 `beginPanelAgentPreparation` / `endPanelAgentPreparation` 增加 `await` 是必要适配。
- 10 秒受控 timer 只拦截 Agent startup delay，避免误接管同值的无关 timer，方向正确；但通过硬编码源码文件和行号定位较脆弱，后续更适合显式注入 clock/delay。

## 核对范围与证据

- PR #356 metadata、diff、changed files、checks、comments、reviews、review threads。
- PR head `8fe0be2968a49ff97eedd1fc08f1ce375277c280` 与 base `4d5798f7e6397aa64553bf7046e2a970f8fd3cde`。
- 最新 `main`、PR #361 merge commit `86885f5e05cb2ea9aca55a51412a1fb4fb18a6b8`、PR #363 后续演进。
- 当前 GitHub 状态：Draft、OPEN、CONFLICTING、CI quality SUCCESS、无评论和评审。
