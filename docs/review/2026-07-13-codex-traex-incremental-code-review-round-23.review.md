# Codex / TraeX capability parity 增量代码复审（Round 23）

## 结论

`case_14` **FAIL**。本轮以 index tree `02f45833ac42f8efa54923b97f473f79c9bb2fb7` 为唯一审查对象，完整阅读相对 `882dfadeec1b7da9c37353f69296e76019f35ed0` 的 6 个 staged path，并独立复跑 output cursor、Agent Team consumer、双 pane tmux pipe 与仓库门禁。Round 22 的文本 snapshot 顺序歧义已在 PTY/session stream 上消除；但新 cursor 是 terminal-session 级，而 Agent Team readiness 是 pane 级。现有 `TmuxOutputWatcher` 的 `pipe-pane -t <sessionName>` 只绑定建立 watcher 时的一个 pane，worker pane 的真实输出不会进入 session cursor，合法 ready最终 15 秒超时；若被监听 pane恰好输出 TraeX ready，还可能污染另一 worker pane的 freshness。保留 1 个开放 P1。

## Review checkpoint

- scope: `incremental`
- base commit / HEAD: `882dfadeec1b7da9c37353f69296e76019f35ed0`
- target tree / index: `02f45833ac42f8efa54923b97f473f79c9bb2fb7`
- requestedAt: `2026-07-13T10:32:33.368Z`
- staged paths: `backend/src/agent-team/agent-readiness.ts`、`backend/src/terminal/manager-buffer-runtime.ts`、`backend/src/terminal/scrollback-buffer.ts`、`backend/src/terminal/tmux-output-watcher.ts`、`packages/shared/src/terminal-agent-readiness.ts`、`scripts/verify-agent-team-review-checkpoints.mjs`
- diff 规模: 503 insertions、21 deletions
- `git diff --cached --check`: 通过
- prompt、run package、HEAD、index tree 与 staged path 完全一致

## 已修复边界

- 真实 `TRAE CLI Next + Explain this codebase` ready、最后 startup epoch、交互提示优先级与 live owner guard 保持正确。
- `ScrollbackBuffer` 为每个新 chunk分配单调 sequence；启动前 cursor只读取之后的 chunk。独立矩阵得到 `cursor=1`、`fresh="fresh"`，边界被容量淘汰后返回 `null`，不会回退到无关输出。
- PTY consumer 已覆盖 banner前状态重绘、prompt改写与完整 120 行 scrollback替换：startup output只有 prompt echo时不 idle，新的 ready chunk进入 cursor后才 idle。
- startup failure复用同一 output cursor；旧 failure不会复用，本次新增 failure会立即返回 `reason=startup_failure`。

## Remaining finding

### P1：session-level tmux output cursor没有隔离目标 worker pane

Agent Team所有 worker readiness调用都传入具体 `panelId`，`resolvePaneTarget()` 得到对应 `paneId`，启动命令、owner读取和当前 scrollback capture也都使用该 pane。但 `captureTraeStartupOutputCursor()` 与 `readTraeStartupOutput()` 在 `backend/src/agent-team/agent-readiness.ts:355-400` 丢弃了 `paneTarget`，只调用 `flushSessionOutput(session.id)`、`captureOutputCursor(session.id)` 和 `readOutputSince(session.id, cursor)`。

底层并不是多 pane聚合流：

- `TmuxOutputWatcher` 以 `terminalSessionId` 为唯一 key，一个 session只保存一个 `WatchedTmuxSession`；再次 `watchSession()` 会在 session/socket未变时直接返回（`backend/src/terminal/tmux-output-watcher.ts:132-140`）。
- watcher建立时调用 `pipePaneOutput(TmuxTarget, filePath)`；`TmuxService` 实际执行 `tmux pipe-pane -t <sessionName>`（`backend/src/terminal/tmux-pane-service.ts:402-415`）。tmux 的 session target只解析当时的 active pane，pipe随后固定附着在该 pane，不随 `panelId` 或 active pane变化。
- `flushSessionOutput()` 也只按 session读取这一个 watcher（`backend/src/terminal/tmux-output-watcher.ts:187-197`）。

独立双 pane tmux harness 先在 main pane建立与生产代码相同的 session-target pipe，再创建 worker pane并分别输出 marker，结果为：

```json
{
  "mainPane": "%0",
  "workerPane": "%1",
  "workerMarkerCount": 0,
  "mainMarkerCount": 2
}
```

即 worker pane输出完全不进入 watcher文件，而 main pane输出正常进入。生产影响有两种：

1. worker pane真实显示完整 fresh TraeX UI，pane-local scrollback和owner都正确，但 `traeStartupOutput`始终为空，`hasStartedAgentUi()`拒绝并最终 timeout，直接阻断 Agent Team worker创建/重检。
2. session被监听 pane在同一 cursor之后输出另一份 TraeX ready时，目标 pane若仍有旧 ready且owner已切换，session stream可能错误满足目标 pane的freshness，形成跨 pane提前派发。

现有专项 fixture没有覆盖该路径：两个 readiness session都声明 `runtimeKind="pty"`，并直接 mock session级 `captureOutputCursor/readOutputSince`；它们无法验证 tmux split pane的pipe归属。

修复必须把 output boundary提升为 pane-local：cursor/stream key至少包含 `terminalSessionId + paneId`，每个受管 pane建立独立 pipe/decoder/buffer，`captureTraeStartupOutputCursor()` 和 `readTraeStartupOutput()`显式接收同一个 `paneTarget`。不能简单把所有 pane写进同一 session buffer，否则仍有跨 pane污染。fixture应创建真实或等价的双 pane watcher，断言目标 worker输出可见、其他 pane输出不可见。

## 已执行检查

- `git write-tree`: `02f45833ac42f8efa54923b97f473f79c9bb2fb7`；6 个 changed paths 与 prompt 一致。
- 独立 output cursor矩阵：只返回 boundary后的 chunk；boundary被trim后返回 `null`。
- 独立 PTY readiness/failure consumer：局部重绘不提前idle，fresh ready/failure按 cursor正确收敛。
- 独立双 pane tmux pipe：worker marker 0、main marker 2，稳定复现 P1。
- `pnpm agent-team:verify-review-checkpoints`: 32 项通过；readiness fixture均为 PTY/session级 mock。
- `pnpm toolkit:verify-hooks`: 通过。
- `pnpm app-server:verify-state-sync`: 通过。
- `pnpm typecheck`: 通过。
- `pnpm lint`: 通过。
- `pnpm runweave:update:test-cases`: 18/18 通过。

静态与 PTY fixture门禁通过不能覆盖已执行复现的 tmux pane归属错误。由于仍有 P1，本轮不应进入 behavior verification。

本轮只新增此 review文档与指定 pane outbox；未修改源码、测试、Git index或 HEAD。
