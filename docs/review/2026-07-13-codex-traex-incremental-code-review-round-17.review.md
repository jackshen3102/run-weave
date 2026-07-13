# Codex / TraeX capability parity 增量代码复审（Round 17）

## 结论

`case_14` **FAIL**。本轮以 index tree `cd3c622b77609ee8e670aa2957be2e9b1846dd40` 为唯一审查对象，完整阅读相对 `882dfadeec1b7da9c37353f69296e76019f35ed0` 的 2 个 staged path，并沿共享 readiness evaluator 到 Agent Team 与普通 Terminal 的两个消费者复验。Round 16 的真实 TraeX ready prompt 漏识别已经修复，但当前实现引入 1 个仍开放的 P1：旧的 `TRAE CLI Next + Explain this codebase` 画面没有启动轮次/最新失败约束，会在 pane 已回到 shell 或后续启动失败时继续被识别为 ready，Agent Team 因而可能跳过启动并把任务直接派发到 shell。

## Review checkpoint

- scope: `incremental`
- base commit / HEAD: `882dfadeec1b7da9c37353f69296e76019f35ed0`
- target tree / index: `cd3c622b77609ee8e670aa2957be2e9b1846dd40`
- requestedAt: `2026-07-13T09:06:02.972Z`
- staged paths: `packages/shared/src/terminal-agent-readiness.ts`、`scripts/verify-agent-team-review-checkpoints.mjs`
- diff 规模: 20 insertions、1 deletion
- `git diff --cached --check`: 通过
- prompt、run package、HEAD、index tree 与 staged path 完全一致

## 已修复问题

Round 16 的真实 Dev Session 画面使用 `TRAE CLI Next` banner 与 `❯ Explain this codebase` 可输入建议；旧正则只接受 `Write tests for @filename` 或 `Context N% left`，因此 Agent Team readiness 等待 15 秒后返回 409，任务标记从未派发。

当前 target 把 `Explain this codebase` 加入同一 banner 后 6000 字符窗口。对 Round 16 原始 pane capture 独立比较得到：

```json
{ "baseReady": false, "targetReady": true }
```

单独的 `Explain this codebase` 仍返回 false，后出现交互提示时也保持阻断。因此“真实默认 ready 画面漏识别”本身已解决。

## Remaining finding

### P1：旧 ready 画面会覆盖当前 shell / 启动失败状态并提前放行任务

`packages/shared/src/terminal-agent-readiness.ts:14-19,81-95` 的 composite ready pattern 只要求 scrollback 中某处存在 banner 与建议语句；它不证明该画面属于当前启动，也不比较 ready marker 与更晚的 shell/startup failure。更严重的是，`hasTraeStartupFailure()` 先要求 `!hasTraeReadyPrompt()`，因此旧 ready 一旦命中，后续明确的 `zsh: command not found: traex` 也被压成“无启动失败”。

使用 Round 16 原始 ready pane 后追加真实 shell failure，当前 staged target 返回：

```json
{
  "realReady": true,
  "noBannerReady": false,
  "staleThenFailedReady": true,
  "staleThenFailedStartupFailure": false,
  "laterInteractiveReady": false
}
```

影响不是 evaluator 层的理论误报。`backend/src/agent-team/agent-readiness.ts:49-70,264-290` 在发送 agent start command 之前先调用该 evaluator；独立 consumer harness 以 `activeCommand=null`、shell session 和“旧 ready + 后续 command-not-found”scrollback 调用 `ensureAgentReady()`，结果函数直接返回、写入一次 `agent_idle`，启动路径完全没有进入：

```text
round17 stale-ready consumer: FALSE READY (ensureAgentReady returned, idleTransitions=1, start path not entered)
```

随后编排层会认为 worker 已 ready 并继续派发 intent，内容可能作为 shell 命令执行，直接违反 AGT-TRAE-010 的“启动失败不得派发”和 AGT-TRAE-011 的“阻塞提示/非 ready 状态不得放行”。同一 evaluator 还被 `backend/src/terminal/terminal-state-service.ts:147-186,298-304` 复用，在 metadata 尚未收敛时可把普通 Terminal 错投影为 `agent_idle/traex`。

修复方向：不要把 banner 到建议语句的整段 composite match 起点当作 readiness 时序。应以最新一次 Trae 启动/banner 为 epoch，取得实际 ready marker 的位置，并要求它晚于该 epoch 内所有 interactive prompt、startup failure 和返回 shell 的决定性输出；或同时用 live pane current command / 本次启动 capture 边界证明 owner。专项 fixture 至少补充“旧 ready → shell / command-not-found”“旧 ready → 新 banner 尚无 marker”“ready 后交互阻塞”三个负向序列。

## 已执行检查

- Round 16 原始 pane Before / After 对比：`baseReady=false`、`targetReady=true`。
- 独立 evaluator 时序矩阵：复现 `staleThenFailedReady=true`、`staleThenFailedStartupFailure=false`。
- 独立 Agent Team consumer harness：复现未启动 TraeX即返回 ready并写入 idle。
- `pnpm agent-team:verify-review-checkpoints`: 23 项通过；新增两项只覆盖 fresh ready 与无 banner 文本，未覆盖 stale/failure 顺序。
- `pnpm toolkit:verify-hooks`: 通过。
- `pnpm app-server:verify-state-sync`: 通过。
- `pnpm typecheck`: 通过。
- `pnpm lint`: 通过。
- `pnpm runweave:update:test-cases`: 18/18 通过。

静态门禁通过不能覆盖已执行复现的状态时序错误。由于仍有 P1，本轮不应进入 behavior verification。

本轮只新增此 review 文档与指定 pane outbox；未修改源码、测试、Git index 或 HEAD。
