# Agent Team C5 Live-Foreground Final Code Review

## 结论

`case_25` 不通过，仍有 1 条阻断 P1。当前 6-file patch 已用目标 pane TTY 的 foreground process group、双采样 PGID + leader `lstart`、pane-scoped lifecycle 取代旧 `activeCommand` / `lastActivityAt` / UI / scrollback 判定；`dvs-e6ff44` 覆盖的真实 `%47`、普通 `node -e` takeover、采样中 PGID 切换、跨 pane、stale completion、缺 process/lifecycle 均符合预期。但实现仍把 `ps args` 首 token 当作“实际 Codex executable”，该值可由普通 Node 的 `process.title` 改写，导致普通 Node + 继承旧 Codex lifecycle 仍能返回 ready。

本审查只读，未修改、stage 或 commit 源码，未执行 behavior 验收。

## 固定边界

- base / HEAD: `90c3b1102a45d0e47702461c194d58c597a2846a`
- working-tree tree: `ac232fd14641e5def5458b9ba4309826d0384b4f`
- diff SHA-256: `fb310e088033805364ed4562d0245acd7866f1946603860678a13d0196ae10d8`
- changed paths: `backend/src/agent-team/agent-readiness.ts`、`service-serial-dispatch.ts`、`service-support.ts`、`backend/src/terminal/tmux-pane-service.ts`、`tmux-service.ts`、`tmux-types.ts`
- size: 252 additions / 36 deletions
- `git diff --check`: 通过

## P1 阻断

### `ps args` 不是 authoritative executable identity

`readPaneForegroundProcessSnapshot` 使用 `/bin/ps -ww -t <tty> -o pid=,pgid=,tpgid=,lstart=,args=`，随后 `isCodexForegroundProcess` 对每个 `args` 调用 `getExecutableCommandName`，只要首 token 为 `codex` 就接受。`args` 是进程可控的 argv/title，并非内核记录的 executable image。

macOS 受控反例中，普通 Node 执行 `process.title = "codex"` 后：

- `ps -ww ... args=` 显示 `codex`；
- `lsof -a -p <pid> -d txt -Fn` 显示真实 executable 为 Node 二进制，而非 Codex；
- 将该生产形态 snapshot 与旧 `agent_idle/codex`、`lastThreadProvider=codex`、`lastThreadStatus=idle` lifecycle 交给生产 `hasReadyCodexPaneState`，两次 snapshot 完全相同后返回 `true`；
- `processSnapshotReads=2`、`captureReadCount=0`。

因此 reviewer 前一轮的普通 Node takeover invariant 尚未真正关闭：PGID/start identity 只能证明同一前台进程组稳定，不能证明组内存在真实 Codex executable。影响仍是 serial dispatch 可能把 prompt 注入伪装标题的普通 Node 进程。

修复应从 OS executable image/path 获取不可由 argv/title 改写的身份，并把该真实 Codex process identity 纳入双采样；`args`/`comm` 只能作为诊断信息，不能作为 authoritative readiness。

定位：`backend/src/terminal/tmux-pane-service.ts:34-64`、`backend/src/agent-team/agent-readiness.ts:624-631`、`backend/src/terminal/completion-source-gate.ts:75-98`。

稳定 invariant：`agent-team.codex-node-wrapper-authoritative-readiness`。

## 已验证部分

- TTY 与 foreground PGID：读取 `#{pane_tty}`，使用 `ps -ww`，只选择 `pid=pgid=tpgid` 的前台 group leader；解析失败、tmux/ps 异常、无 leader 均返回 `null`。
- 双采样：两次均要求存在被当前分类器识别的 Codex process，且 PGID、leader `lstart` 完全相同；PGID/generation switch fail closed。
- pane lifecycle：panelId、terminalSessionId、tmuxPaneId、running status、provider、terminalState、thread id/status 均 pane-scoped 核对；跨 pane、stale completion、缺 process/lifecycle 拒绝。
- readiness 不使用旧 `activeCommand`、`lastActivityAt` 或 Codex UI/scrollback 作为 ready 证据；`dvs-e6ff44` 的 `captureReadCount=0` 成立。
- TraeX 仍沿用原有 live owner + fresh startup-output boundary + `hasTraeReadyPrompt` 路径；现有 verifier 通过。
- failure-state P1 保持 resolved：session/pane/readiness 失败进入 `need_human`，清空 active role/dispatch，冻结 workers，repair attempts 不增加。

## 验证

- `pnpm agent-team:verify-review-checkpoints`：通过。
- `pnpm --filter @runweave/backend typecheck`：通过。
- `pnpm --filter @runweave/backend lint`：通过。
- `git diff --check 90c3b110... -- <6 paths>`：通过。
- 只读 tmux/ps parser probe：确认调用 `/bin/ps -ww -t ttys047 -o pid=,pgid=,tpgid=,lstart=,args=`；合法 node-wrapper group 可完整解析，异常返回 `null`。
- 普通 Node executable-spoof probe：`ps args=codex`，`lsof txt=.../bin/node`。
- 生产 readiness probe：`inheritedStaleLifecycleAccepted=true`、`processSnapshotReads=2`、`captureReadCount=0`。
- `dvs-e6ff44` 与 `dvs-8854aa` 原始 JSON 已核查；前者覆盖的负例仍有效，但没有覆盖 process-title executable spoof。

## 非阻断既有项

P2 `recheck-watchdog-clock-lifecycle` 继续作为 informational，本 C5 增量未处理，也不升级为本轮 P1。
