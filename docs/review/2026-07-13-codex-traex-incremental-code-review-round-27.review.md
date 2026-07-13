# Codex / TraeX capability parity 增量代码复审（Round 27）

## 结论

`case_14` **FAIL**。本轮以 index tree `7393edf2244764cfd823ddb1438e534f7cdedd11` 为唯一审查对象，完整阅读相对 `c5928164177c8d11dce8f7b66289dc7cfe3104cf` 的4个staged path，并独立重跑Round 26三个P1复现。generation换代后的二次校验、capture poll错误fail closed、dead pane逐pane回收及TraeX非装饰性ready detector均已修复；但capture仍只读取一次固定fileStat快照。写入在该次read期间、且在cursor返回前已完成的bytes不会进入当前buffer，却会在下一次read被当作fresh startup output。默认1 MiB transport配置下连续5次复现、5次全部泄漏，因此仍保留1个P1并禁止checkpoint。

## Review checkpoint

- scope: `incremental`
- base commit / HEAD: `c5928164177c8d11dce8f7b66289dc7cfe3104cf`
- target tree / index: `7393edf2244764cfd823ddb1438e534f7cdedd11`
- requestedAt: `2026-07-13T11:44:13.734Z`
- staged paths: `backend/src/routes/terminal-panel-routes.ts`、`backend/src/terminal/tmux-output-watcher.ts`、`packages/shared/src/terminal-agent-readiness.ts`、`scripts/verify-agent-team-review-checkpoints.mjs`
- diff规模: 244 insertions、41 deletions
- `git diff --cached --check`: 通过
- prompt、run package、HEAD、index tree与staged path完全一致

## Remaining finding

### P1：capture返回前已到达但未进入初始fileStat快照的输出会越过cursor

`capturePaneOutputCursor()` 在 `pollPane()` 返回后捕获buffer sequence（`backend/src/terminal/tmux-output-watcher.ts:192-222`）。`pollPaneNow()`只在开始时读取一次`stat`，并以固定`end=fileStat.size-1`读取该段；若pipe在read期间继续追加，`truncateTransportIfDrained()`看到latest size与offset不同后仅保留文件等待下次poll，当前poll仍返回true（`backend/src/terminal/tmux-output-watcher.ts:450-494`及transport drain分支）。因此，追加完成时间早于capture Promise完成、语义上位于cursor之前的bytes并未进入buffer；sequence cursor仍被返回，下一次read把这些bytes视为fresh。

独立harness使用生产`TmuxOutputWatcher`与默认1 MiB transport配置，每轮先写900 KiB backlog，再启动capture，并在read期间追加唯一marker。5轮中marker都在capture返回前完成写入，且5轮均在该cursor后的第一次read中出现：

```json
{
  "attempts": [
    { "appendBeforeCapture": true, "leaked": true },
    { "appendBeforeCapture": true, "leaked": true },
    { "appendBeforeCapture": true, "leaked": true },
    { "appendBeforeCapture": true, "leaked": true },
    { "appendBeforeCapture": true, "leaked": true }
  ]
}
```

生产影响是旧进程/旧startup epoch恰在边界建立期间完成ready时，该ready会被归为新启动命令之后的fresh output；随后visible pane和live owner也可能同时满足，Agent Team可提前放行或把`traex`启动命令错误输入已存在的TUI。当前fixture只覆盖静态transport、offset reset与poll错误，没有在capture read期间并发append。

修复方向：capture需要建立真正的pane-stream barrier。最低限度应在同一pane串行区内持续drain到稳定offset后再返回，并对持续写入设置明确上限/返回null；更稳妥的是把boundary barrier与send命令纳入同一有序操作，确保startup cursor的因果点不早于旧输出且不晚于新命令的首个输出。新增fixture必须记录append完成时间早于capture完成，并断言该marker不出现在cursor后的read中。

## Resolved findings核对

### generation与transport错误已fail closed

- `readPaneOutputSince()` 在poll后重新校验current watcher、generation和target；poll中offset回退/transport reset换代后立即返回null。
- `pollPaneNow()`返回boolean；stat/read失败会invalidate generation并返回false，`capturePaneOutputCursor()`不会再生成cursor。
- 真实tmux fixture中的`tmux-pane-generation-is-rechecked-after-poll`和`tmux-pane-capture-fails-closed-on-transport-error`均通过。

### dead worker pane已逐pane回收

- 新增`unwatchPane(sessionId,paneId)`，显式panel delete在kill pane后调用。
- 周期poll先按session执行`listPanes()`，只清理不存在的pane watcher；session recorder仍只属于lifecycle watcher。
- 真实tmux fixture确认kill worker后只剩main watcher，显式unwatch main后watcher map与timer清空。
- 残余非阻断风险：stop path仍保留零字节transport文件，且每500ms按session执行一次`listPanes()`；本轮未观察到P0/P1级正确性影响。

### TraeX detector不再依赖suggestion或装饰footer

- ready现在要求最后startup epoch中的有序model/directory/permissions metadata及之后的`❯`输入prompt，不再要求box-drawing、宽度、`▰`或permission footer文案。
- 对Round 25真实pane直接复算：原始布局、任意suggestion、窄divider、无footer、替代permission footer与ASCII divider全部ready=true。
- 更晚trust、update/Press enter、Select an option均覆盖ready；更晚command-not-found投影startup_failure。

### no-target与双pane归属保持正确

- no-target tmux readiness仍把selected pane解析为一个固定paneTarget，并用于owner、visible capture、cursor、send与read；worker/recheck调用继续显式传panelId。
- session+pane key、pipe文件、decoder、buffer与session recorder隔离没有回退；双pane及alternate-screen fixtures继续通过。

## 已执行检查

- `git write-tree`: `7393edf2244764cfd823ddb1438e534f7cdedd11`；4个changed paths与prompt一致。
- `pnpm agent-team:verify-review-checkpoints`: `ok=true`、45 checks通过，包含generation、poll error、dead pane cleanup及非装饰性detector fixture。
- 默认1 MiB capture并发append独立harness：5/5出现`appendBeforeCapture=true && leaked=true`。
- Round 25真实pane detector矩阵：6种布局全部ready；更晚trust/update/select/failure顺序全部正确。
- `pnpm typecheck`、`pnpm lint`、`pnpm toolkit:verify-hooks`、`pnpm app-server:verify-state-sync`：通过。
- `pnpm runweave:update:test-cases`: 18/18通过。
- 收口`git diff --cached --check`与`git write-tree`: 通过；HEAD仍为base，index仍为本轮target。

本轮为纯只读代码复审；除本review文档与指定pane outbox外，未修改源码、测试、Git index或HEAD。由于仍有1个P1，未生成checkpoint。
