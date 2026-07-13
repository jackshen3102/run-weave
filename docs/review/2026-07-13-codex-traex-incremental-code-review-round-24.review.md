# Codex / TraeX capability parity 增量代码复审（Round 24）

## 结论

`case_14` **PASS**。本轮以 index tree `5872cac83bfdda2d96c7d7ff45d39c473a2ae344` 为唯一审查对象，完整阅读相对 `882dfadeec1b7da9c37353f69296e76019f35ed0` 的 7 个 staged path，并把“同一 tmux session 双 pane 隔离”作为硬门禁。Round 23 的开放 P1 已修复：TraeX 启动边界现在由 `terminalSessionId + paneId + generation + sequence` 唯一标识；每个 pane 使用独立 `pipe-pane` target、传输文件和 output buffer。真实双 pane tmux fixture 连续两次通过，证明另一 pane 的 fresh ready 不会满足当前 pane，而当前 pane 自身的 ready 即使跨 alternate-screen 也不会被默认 pane watcher 漏掉。本轮未发现未修复 P0/P1。

## Review checkpoint

- scope: `incremental`
- base commit / HEAD: `882dfadeec1b7da9c37353f69296e76019f35ed0`
- target tree / index: `5872cac83bfdda2d96c7d7ff45d39c473a2ae344`
- requestedAt: `2026-07-13T10:55:03.504Z`
- staged paths: `backend/src/agent-team/agent-readiness.ts`、`backend/src/terminal/manager-buffer-runtime.ts`、`backend/src/terminal/scrollback-buffer.ts`、`backend/src/terminal/tmux-output-watcher.ts`、`backend/src/terminal/tmux-pane-service.ts`、`packages/shared/src/terminal-agent-readiness.ts`、`scripts/verify-agent-team-review-checkpoints.mjs`
- diff 规模: 1088 insertions、108 deletions
- `git diff --cached --check`: 通过
- prompt、run package、HEAD、index tree 与 staged path 完全一致

## 双 pane 硬门禁核对

### 1. 生产 watcher 已成为 pane-local

- `TmuxPaneOutputCursor` 同时携带 `terminalSessionId`、`paneId`、`generation` 和 `sequence`；watcher map key 为 `terminalSessionId + NUL + paneId`。
- `ensurePaneWatcher()` 为每个 pane 创建独立 output path、decoder、scrollback buffer 和 generation；`pipePaneOutput()` 现在使用 `resolveTmuxTargetName(target)`，当 target 含 paneId 时实际执行 `tmux pipe-pane -t <paneId>`。
- `readPaneOutputSince()` 同时校验 paneId、session/pane target 与 generation。跨 pane cursor、watcher 重建或传输丢失都返回 `null`，不会回退到 session output。
- 普通 session lifecycle watcher仍负责所选 pane的 session scrollback和退出协调；Agent Team目标 pane watcher独立存在，`unwatchSession()` / `dispose()` 会清理该 session的全部 pane pipes。

### 2. Readiness 捕获、发送和读取使用同一 pane

- `ensureAgentReady()` 先解析目标 `paneTarget`，在发送 TraeX 启动命令前调用 `capturePaneOutputCursor(session, paneTarget)`。
- 边界保存原始 `paneTarget`；轮询阶段只调用 `readPaneOutputSince(boundary.target, boundary.cursor)`。边界建立失败或后续丢失均返回 409，而不是采用 session/default pane fallback。
- 可见 UI 与 live owner仍由同一 `paneTarget` 的 `capturePane()` / `readPaneMetadata()` 获取；ready必须同时出现在目标 pane的可见画面和本次 fresh raw stream中。

### 3. 真实双 pane 证据

`pnpm agent-team:verify-review-checkpoints` 内的 `verifyTmuxPaneRawOutputHarness()` 启动真实 tmux server、创建 main/worker 两个 pane，并实例化生产 `TmuxService` 与 `TmuxOutputWatcher`：

- main pane输出 `TRAE CLI Next + Explain this codebase` 后，main cursor包含 ready，worker cursor不包含 ready，且把 worker cursor与main target交叉读取返回 `null`。
- worker pane随后在进入 alternate-screen前输出 marker，并在 alternate-screen内输出 ready；worker raw cursor同时读到前置 marker和ready。`capture-pane` 看不到前置 marker，证明判定依赖的是目标 pane raw stream，而不是会丢历史画面的可见 snapshot。
- 同一 verifier连续独立执行两次，均返回 `ok=true`、36 checks通过；其中 `tmux-pane-output-cursors-created`、`tmux-other-pane-ready-is-isolated`、`tmux-pane-raw-stream-survives-alternate-screen` 均通过。

## Resolved findings

### P1：session-level tmux output cursor没有隔离目标 worker pane

已修复。Round 23 的 watcher只以 terminal session为 key，并以 sessionName作为 `pipe-pane` target，导致目标 worker ready漏读或其他 pane ready串入。当前实现把 pipe、buffer、generation/sequence cursor与读取校验全部提升到 pane-local；真实双 pane fixture证明两种失败方向均已关闭。

### P1：历史 ready、错误 owner或后续决定性状态可能提前放行

保持修复。当前 target仍要求 live pane owner匹配目标 provider，并按最后 startup epoch处理ready、failure和interactive prompt；只有本次 cursor之后的fresh ready才能完成启动。

### P2：startup failure或输出边界丢失可能被静默忽略

保持修复。fresh startup failure返回 `reason=startup_failure`；generation变化、buffer淘汰、target不匹配或watcher丢失均显式返回boundary error，不会重用旧输出。

## 已执行检查

- `git write-tree`: `5872cac83bfdda2d96c7d7ff45d39c473a2ae344`；7 个 changed paths 与 prompt 一致。
- `pnpm agent-team:verify-review-checkpoints`：连续两次通过，每次 `ok=true`、36 checks；包含真实 tmux 双 pane production watcher fixture。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm toolkit:verify-hooks`：通过。
- `pnpm app-server:verify-state-sync`：通过。
- `pnpm runweave:update:test-cases`：18/18 通过。
- 收口 `git diff --cached --check` 与 `git write-tree`：通过，index仍为本轮 target tree。

本轮为纯只读代码评审；未执行 Dev Session / Playwright，因为目标仅涉及 Backend tmux/readiness及其命令行 fixture，没有 UI验收路径。除本 review文档与指定 pane outbox外，未修改源码、测试、Git index或 HEAD。
