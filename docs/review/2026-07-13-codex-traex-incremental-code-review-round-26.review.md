# Codex / TraeX capability parity 增量代码复审（Round 26）

## 结论

`case_14` **FAIL**。本轮以 index tree `42fe5cf96e24af2e76b2383722f079ed0939aa86` 为唯一增量对象，完整阅读相对 `c5928164177c8d11dce8f7b66289dc7cfe3104cf` 的 2 个 staged path，并按主 Agent 指定范围回溯 base中的 pane-local watcher/cursor生产链。当前 38 项专项 fixture、typecheck、lint及常规回归门禁均通过，但独立最小 harness确认 3 个开放 P1：generation在poll中失效时旧cursor仍可读取新buffer；被关闭的worker pane watcher不会逐pane回收；新TraeX detector把固定suggestion替换成了固定box drawing与`▰`装饰要求，仍会漏掉语义上已ready的合法布局。由于存在P1，本轮禁止checkpoint。

## Review checkpoint

- scope: `incremental`
- base commit / HEAD: `c5928164177c8d11dce8f7b66289dc7cfe3104cf`
- target tree / index: `42fe5cf96e24af2e76b2383722f079ed0939aa86`
- requestedAt: `2026-07-13T11:26:33.757Z`
- staged paths: `packages/shared/src/terminal-agent-readiness.ts`、`scripts/verify-agent-team-review-checkpoints.mjs`
- diff规模: 70 insertions、23 deletions
- `git diff --cached --check`: 通过
- prompt、run package、HEAD、index tree与staged path完全一致

## Remaining findings

### P1：poll中generation换代后，当前旧cursor读取仍然fail open

`readPaneOutputSince()` 只在调用 `pollPane()` 前比较 `watched.generation` 与 `cursor.generation`（`backend/src/terminal/tmux-output-watcher.ts:219-237`）。但同一次poll可在offset回退、transport超限或hard reset时调用 `invalidatePaneCursor()`，替换generation和output buffer（`backend/src/terminal/tmux-output-watcher.ts:374-395, 476-519`）；poll返回后没有再次校验generation，就直接用旧cursor.sequence读取新buffer。

独立生产类harness建立generation=1/sequence=0的cursor，然后模拟transport被截断且新文件含ready输出。第一次 `readPaneOutputSince()` 内generation变为2，却返回了完整新ready；只有第二次调用才返回`null`：

```json
{
  "before": { "cursorGeneration": 1, "watcherGeneration": 1, "offset": 4096 },
  "after": { "watcherGeneration": 2, "result": "TRAE CLI Next ... ▰ ok" },
  "secondRead": null
}
```

这直接违反“旧cursor在truncate/offset回退/重建时fail closed”。修复方向：poll后再次校验同一个watcher、target和generation；如果poll触发换代，当前读取必须返回`null`。此外 `pollPaneNow()` 当前吞掉stat/read错误，`capturePaneOutputCursor()`仍会返回cursor；另一个harness删除transport使capture poll失败，结果仍得到cursor，随后在send前写入的`PRE_SEND_UNPOLLED_READY`被当作fresh输出读取。capture必须确认flush成功，或者把flush/barrier与send放进同一pane级有序操作，不能在失败或未建立因果边界时返回有效cursor。

### P1：关闭worker pane不会回收pane-local watcher

新增watcher以`terminalSessionId + paneId`分配独立pipe、文件、decoder和buffer，这是正确隔离；但只有`unwatchSession()`和`dispose()`能删除这些对象（`backend/src/terminal/tmux-output-watcher.ts:240-268`）。面板关闭路径执行`killPane()`、mark exited和remove workspace，没有调用pane级unwatch（`backend/src/routes/terminal-panel-routes.ts:201-224`）；workspace reconciliation移除消失panel时也没有通知watcher。

真实tmux harness先对main/worker建立生产watcher，再kill worker pane并主动poll：watcher count从2保持为2，dead `%1` key仍存在，旧cursor仍返回缓存输出；整session调用`unwatchSession()`后才降为0。session recorder隔离本身正确：只记录main marker，不记录worker marker。

```json
{
  "sessionRecorderHasMain": true,
  "sessionRecorderHasWorker": false,
  "beforeKill": { "watcherCount": 2 },
  "afterKill": { "watcherCount": 2 },
  "afterUnwatch": { "watcherCount": 0, "timerActive": false }
}
```

长生命周期terminal反复创建/关闭Agent Team worker会累积poll对象、decoder/buffer和transport文件。修复方向：增加`unwatchPane(terminalSessionId, paneId)`并接入显式panel delete与missing-pane reconciliation；poll发现pane不存在时也应只回收该pane，而不是等待整session退出。fixture需循环split/kill并断言watcher数回到主pane基线。

### P1：TraeX ready仍硬依赖非协议性分隔线与`▰` footer

本轮正确移除了固定suggestion allowlist，但 `TRAE_READY_PROMPT_FOOTER_PATTERN` 仍要求 `❯`之后出现至少3个`─/━`，再在500字符内出现`▰`（`packages/shared/src/terminal-agent-readiness.ts:14-18, 128-142`）。Round 25保留的真实TraeX 0.200.17 pane确实包含这些字符，当前evaluator返回ready；这只能证明一个版本、宽度和YOLO/Full Access布局。

对同一真实pane文本只改变非语义装饰后，当前结果为：

```json
{
  "round25Real": { "ready": true, "failure": false },
  "arbitrarySuggestion": { "ready": true, "failure": false },
  "narrowDivider": { "ready": false, "failure": false },
  "noDecorativeFooter": { "ready": false, "failure": false },
  "alternatePermissionFooter": { "ready": false, "failure": false },
  "noBoxDrawing": { "ready": false, "failure": false }
}
```

本机`traex --help`明确支持default、plan、bypass_permissions、auto四种permission mode以及`--no-alt-screen`，而分隔线宽度、box-drawing字形、footer icon和permission文案都不是readiness协议。当前fixture只生成一种`──────────────── + ▰ Full Access`模板，因此无法发现该漏判。已有banner、按顺序完整metadata、fresh pane-local raw stream、live owner与可输入`❯`共同构成足够强的语义信号；建议ready结束点落在metadata之后的输入prompt，而不要求装饰性分隔线/footer。更晚trust、update/Press enter、Select an option和startup failure仍按实际结束位置覆盖ready。

## 已核对且未发现P1的边界

- session+pane key、pipe target、文件、decoder与buffer确实全链路pane-local；同session另一pane输出不会进入目标cursor。
- session recorder只绑定lifecycle watcher；独立worker pane不会写入session recorder。
- `unwatchSession()`和`dispose()`可清理整session/all panes及poll timer；缺口是pane存活期内的逐pane回收。
- no-target tmux readiness现在解析一次selected pane，并把同一paneTarget用于owner、visible capture、cursor、send和read；现有调用中worker/recheck均显式传panelId，唯一fallback位于mainPanelId缺失路径。独立harness得到`paneId=%selected`，未发现跨pane回退。
- Round 25真实pane上的动态suggestion已不再依赖文案；在当前完整装饰布局下可识别。
- 真实ready后追加trust、update/Press enter或Select an option均得到ready=false/failure=false；追加command-not-found得到ready=false/failure=true，较晚决定性信号顺序保持正确。

## 已执行检查

- `git write-tree`: `42fe5cf96e24af2e76b2383722f079ed0939aa86`；2个changed paths与prompt一致。
- `pnpm agent-team:verify-review-checkpoints`: `ok=true`、38 checks通过；现有fixture未覆盖poll内generation换代、dead pane回收及footer变体。
- Round 25真实pane detector矩阵：当前原始输出和任意suggestion通过；窄分隔线、无decorative footer、替代permission footer、ASCII divider均漏判；更晚trust/update/select/failure顺序通过。
- generation/offset独立harness：第一次旧cursor跨generation返回新ready，第二次才返回null。
- capture失败/发送前窗口harness：capture poll失败仍返回cursor，send前未poll输出随后被读取。
- 真实tmux lifecycle harness：main/worker stream隔离与session recorder归属通过；kill worker后watcher count仍为2，整session unwatch后才为0。
- no-target selected-pane harness：解析`%selected`一次并返回同一paneTarget。
- `pnpm typecheck`、`pnpm lint`、`pnpm toolkit:verify-hooks`、`pnpm app-server:verify-state-sync`：通过。
- `pnpm runweave:update:test-cases`: 18/18通过。
- 收口 `git diff --cached --check` 与 `git write-tree`: 通过；HEAD仍为base，index仍为本轮target。

本轮为纯只读代码复审；除本review文档与指定pane outbox外，未修改源码、测试、Git index或HEAD。由于存在3个P1，未启动Dev Session/Playwright，且不得生成checkpoint。
