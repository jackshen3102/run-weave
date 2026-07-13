# Codex / TraeX capability parity 增量代码复审（Round 28）

## 结论

`case_14` **PASS**。本轮以 index tree `bfe069b82018ffdf0004965952a606ebe11defed` 为唯一审查对象，完整阅读相对 `c5928164177c8d11dce8f7b66289dc7cfe3104cf` 的 6 个 staged path，并独立重跑 Round 27 并发 append 复现、Round 26 generation/poll error、dead pane、detector 与双 pane 回归点。当前实现以 pane-local OSC marker 建立可观察边界，在同一有序操作中随后发送 TraeX 启动命令，并返回 marker 结束位置的 sequence + offset cursor；旧输出与新命令输出因而被准确分隔。默认 1 MiB transport、900 KiB backlog 下 5/5 得到 `appendBeforeCapture=true && leaked=false`，未发现开放 P0/P1。

## Review checkpoint

- scope: `incremental`
- base commit / HEAD: `c5928164177c8d11dce8f7b66289dc7cfe3104cf`
- target tree / index: `bfe069b82018ffdf0004965952a606ebe11defed`
- requestedAt: `2026-07-13T12:14:13.938Z`
- staged paths: `backend/src/agent-team/agent-readiness.ts`、`backend/src/routes/terminal-panel-routes.ts`、`backend/src/terminal/tmux-output-watcher.ts`、`backend/src/terminal/tmux-pane-service.ts`、`packages/shared/src/terminal-agent-readiness.ts`、`scripts/verify-agent-team-review-checkpoints.mjs`
- diff 规模: 548 insertions、67 deletions
- `git diff --cached --check`: 通过
- prompt、run package、HEAD、index tree 与 staged path 完全一致

## Resolved findings 核对

### Round 27：capture 返回前的并发输出不再越过 cursor

- `TmuxOutputWatcher.capturePaneOutputCursorAndSendInput()` 先完成旧 transport poll，再向目标 pane tty 写入随机 OSC marker，随后对同一 `TmuxPaneTarget` 发送启动输入（`backend/src/terminal/tmux-output-watcher.ts:195-243`）。
- watcher 在 marker 搜索期间持续 poll，并复验 watcher identity、generation 与完整 pane target；只有找到 marker 后才返回精确到 chunk 内 offset 的 cursor（`backend/src/terminal/tmux-output-watcher.ts:244-281`、`:744-797`）。
- Agent Team 的 tmux TraeX 启动路径调用上述组合操作；Codex 与 PTY 路径仍沿用原发送/边界逻辑（`backend/src/agent-team/agent-readiness.ts:104-121`、`:416-446`）。
- 真实 tmux harness 使用默认 1 MiB transport、每轮 900 KiB backlog，在 capture read 开始后追加唯一旧 marker；5 轮全部确认追加早于 capture 完成，且 cursor 后读取均不包含旧 marker。命令首段输出仍位于 cursor 后，OSC marker 不进入返回输出且在 `capture-pane` 中不可见。

### generation、错误与 pane 生命周期继续 fail closed

- `readPaneOutputSince()` 在 poll 后继续复验 current watcher、generation 与 target；offset/truncate 换代或 poll 失败时旧 cursor 返回 `null`。
- `unwatchPane()`、panel delete 接线和周期 missing-pane reconciliation 保持逐 pane 清理；同 session 的 main lifecycle watcher 不会因 worker pane 删除而被误清理。
- `watchSession`、`unwatchSession`、`dispose`、session recorder 与 poll timer 的现有回归检查均通过。

### detector 与双 pane 隔离继续成立

- TraeX ready 仍只依赖 banner、按序 metadata 与其后的 `❯` 输入点，不依赖固定 suggestion、divider 宽度、box-drawing、`▰` 或 permission footer 文案。
- 对 Round 25 保存的真实 pane 重新计算：真实布局、任意 suggestion、无装饰 footer、替代 permission footer 与 ASCII divider 均为 ready；追加更晚 trust/select 得到 ready=false，追加 command-not-found 得到 failure=true。
- 同 tmux session 的 main/worker watcher继续使用 session+pane key、独立 pipe 文件、decoder 与 buffer；另一 pane 的 ready、alternate-screen output 均不会满足当前 pane。

## 已执行检查

- `pnpm agent-team:verify-review-checkpoints`: `ok=true`、47 checks 通过。
- 并发 append fixture：5/5 `appendBeforeCapture=true`、5/5 `leaked=false`。
- boundary-and-send fixture：启动输出位于 cursor 后；marker 不位于 cursor 后输出且不可见。
- Round 25 真实 pane detector 矩阵：语义 ready 变体通过；更晚交互/失败继续覆盖 ready。
- `pnpm typecheck`: 通过。
- `pnpm lint`: 通过。
- `pnpm toolkit:verify-hooks`: 通过。
- `pnpm app-server:verify-state-sync`: 通过。
- `pnpm runweave:update:test-cases`: 18/18 通过。
- `pnpm dev:session:verify`: `ok=true`、22 checks 通过。
- 收口 `git diff --cached --check`、HEAD 与 `git write-tree`: 通过。

## 残余验证范围

本轮是代码审查，不替代后续 behavior_verify 对真实 TraeX worker、Desktop DOM 与恰好一次任务派发的隔离 Dev Session 验收。当前静态调用链、真实 tmux fixture 与保留的 Round 25 pane 输出未显示 P0/P1 风险。

本轮除本 review 文档与用户指定 pane outbox 外，未修改源码、测试、Git index 或 HEAD。pane outbox 写入后由 backend 正常消费并生成 sequence 7 / review round 28 checkpoint：commit `c598453c01e628fa24aca97fd28b1654614c144e`，parent 为本轮 base，tree 仍精确等于本轮 target；`pendingReview` 已清空。
