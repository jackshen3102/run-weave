# Codex / TraeX capability parity 增量代码复审（Round 19）

## 结论

`case_14` **FAIL**。本轮以 index tree `92c4e910873654642ef6c8d1652b9cf1bb20e1dd` 为唯一审查对象，完整阅读相对 `882dfadeec1b7da9c37353f69296e76019f35ed0` 的 3 个 staged path，并独立复跑 Round 17/18 的真实 pane序列及 Agent Team consumer。Round 19 的 live owner guard 已修复“shell owner +旧 ready 在启动前直接放行”，但仍有 1 个开放 P1：发送 `traex` 后 shell preexec会先把 owner切到 TraeX，新 TUI banner/marker尚未输出时，wait loop仍可复用 baseline中的旧 ready并提前派发任务。

## Review checkpoint

- scope: `incremental`
- base commit / HEAD: `882dfadeec1b7da9c37353f69296e76019f35ed0`
- target tree / index: `92c4e910873654642ef6c8d1652b9cf1bb20e1dd`
- requestedAt: `2026-07-13T09:35:43.067Z`
- staged paths: `backend/src/agent-team/agent-readiness.ts`、`packages/shared/src/terminal-agent-readiness.ts`、`scripts/verify-agent-team-review-checkpoints.mjs`
- diff 规模: 263 insertions、10 deletions
- `git diff --cached --check`: 通过
- prompt、run package、HEAD、index tree 与 staged path 完全一致

## 已修复边界

- 真实 `TRAE CLI Next + Explain this codebase` ready保持可识别。
- 最后 banner epoch、startup failure、new banner无 marker与更晚 interactive prompt的顺序判定保持正确。
- Agent Team每次 ready判断先验证 live owner：tmux读取 pane-local `@runweave_command` / pane metadata，PTY读取 session `activeCommand`；null、shell与跨 provider owner不会消费历史 ready。
- Round 18 的“启动前 graceful shell短路”已修复：owner为空时不读 scrollback、不写 idle，而是进入单次 `traex` 启动。

独立 fresh-ready consumer矩阵得到：`ownerNull=false`、`ownerCodex=false`、`ownerTraex=true`、`ownerTraecli=true`，并在模拟 fresh TUI立即出现时精确写入一次 `traex\r`、一次 starting、一次 idle。

## Remaining finding

### P1：新启动 owner 已切换但 fresh marker尚未出现时仍复用旧 ready

`backend/src/agent-team/agent-readiness.ts:90-100` 在发送命令前保存 `traeStartupBaseline`，但该 baseline只在 `:169-178` 传给 `hasTraeStartupFailureSince()`；`isAgentUiReady()` 的正向 ready判断仍调用全量 `hasTraeReadyPrompt(scrollback)`，没有“since baseline”约束。

真实顺序是 shell preexec先设置 `@runweave_command=traex` / PTY `activeCommand=traex`，随后 TraeX进程才绘制新 banner与 ready marker。因此 live owner guard可以在 fresh UI之前变为 true。使用 Round 16真实 ready画面作为旧 scrollback，consumer harness只在收到启动输入时切换 `activeCommand=traex`，刻意不增加任何 banner/marker；当前 target仍返回：

```json
{
  "writes": ["traex\r"],
  "reads": 3,
  "starts": 1,
  "idles": 1,
  "activeCommand": "traex",
  "scrollbackUnchanged": true
}
```

即 `ensureAgentReady()` 在新 UI没有产生一个字符时就写入 idle并返回。任务随后可能进入仍在启动的进程或 shell输入缓冲，直接违反 AGT-TRAE-009 的“真实 ready之后才派发一次”。

现有 `verifyTraeReadinessOwner()` 没有覆盖这个间隙：它在 mock `runtime.write()` 内同时把 owner改为 `traex`、把 scrollback直接替换成 fresh ready，等价于假设 preexec owner变化与完整 TUI绘制原子完成。31 项 verifier因此可以全过，但不能证明真实启动顺序。

修复方向：新启动路径的正向 ready也必须相对 `traeStartupBaseline`证明出现了新的 banner/ready marker，例如增加 `hasTraeReadyPromptSince()` 或记录本次 launch generation/capture boundary；owner匹配是必要条件但不是 fresh marker的替代。consumer fixture必须把“owner切换”和“fresh banner/marker出现”拆成两个阶段，并断言第一阶段不能返回 ready。

## 已执行检查

- Round 17/18 failure、new epoch、interactive、graceful-shell initial owner矩阵：已修复分支均通过。
- 独立 Agent Team fresh-ready consumer：一次启动后在 fresh marker出现时通过。
- 独立 startup-gap consumer：复现 `scrollbackUnchanged=true` 时仍写 idle并返回。
- `pnpm agent-team:verify-review-checkpoints`: 31 项通过；fixture未拆分 owner与fresh output时序。
- `pnpm toolkit:verify-hooks`: 通过。
- `pnpm app-server:verify-state-sync`: 通过。
- `pnpm typecheck`: 通过。
- `pnpm lint`: 通过。
- `pnpm runweave:update:test-cases`: 18/18 通过。

静态与既有 fixture门禁通过不能覆盖已执行复现的启动时序错误。由于仍有 P1，本轮不应进入 behavior verification。

本轮只新增此 review文档与指定 pane outbox；未修改源码、测试、Git index或 HEAD。
