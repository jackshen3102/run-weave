# Codex / TraeX capability parity 最终代码审查（Round 32）

## 结论

`case_14` **PASS**。最终 checkpoint `3522d95fe7801f7079b0104183cf8efec2c92080` 相对任务起点 `798f25a22b2c28e8b9cdd7da9b528e712346b0e7` 的 62 个路径已完成全量只读复审；未发现仍开放的 P0/P1，历轮阻断项在当前树上的专项回归均通过。

## Review checkpoint

- scope：`final`
- base commit：`798f25a22b2c28e8b9cdd7da9b528e712346b0e7`
- final commit：`162fbb61c9a0feec785e68e15a65e665da758206`
- parent commit：`c598453c01e628fa24aca97fd28b1654614c144e`
- target tree / index tree：`3522d95fe7801f7079b0104183cf8efec2c92080`
- requestedAt：`2026-07-13T14:17:36.788Z`
- `git diff --name-only <base> HEAD` 与 prompt / run package 的 62 个路径逐项一致。
- `git diff --check <base> HEAD`、`git diff --cached --name-only`：通过；审查期间无源码、index 或 HEAD 漂移。

## 核心链路复审

### App Server lifecycle 与真实 thread identity

- Hook 的 `commandName` 优先恢复真实 provider，ThreadRef 同时保留 provider、identity/lifecycle 状态和 pane identity。
- fallback 只在同 provider + terminal session + panel 的稳定作用域内被真实 thread 替换；跨 provider fallback 不会与真实记录并存。
- reconciler 仅映射已知 lifecycle：`task_started -> running`、`task_complete/turn_aborted -> idle`；未知类型保持 raw/detail 可追溯且不会生成臆造状态观察。
- Backend 消费 lifecycle observation 前校验当前 owner 的 thread/provider；迟到 observation 不覆盖已经切换的前台 owner。

### Hook、panel 与 provider 归属

- tmux Hook 以当前 `TMUX_PANE` 读取 pane-local `@runweave_panel_id`；读取失败时保留安全退化，Backend 仅允许同 `terminalSessionId` 下唯一 `tmuxPaneId` fallback。
- initial、split、existing pane 都会同步 `@runweave_panel_id`；Electron resource 与 Toolkit 三份 Hook 资源逐字一致。
- 非 tmux PTY 的 provider provenance、TraeX/TraeCLI legacy source 兼容、延迟跨 provider Hook 拒绝和 tmux pane 唯一 fallback 均由当前 Hook fixture 覆盖。

### TraeX readiness 与 pane-local 单调边界

- Agent Team 在 tmux 下使用 `terminalSessionId + paneId + generation + sequence/offset` cursor；每个 pane 有独立 pipe 文件、decoder 和 buffer。
- 原子 OSC marker 先建立可观察边界，再向同一 pane 发送启动命令；capture 返回前并发到达的旧输出不会越过 cursor。
- poll 后会再次核验 watcher identity、generation 和 pane target；truncate、transport error、dead pane/unwatch/dispose 均 fail closed。
- ready detector 依赖 banner + metadata + 输入提示，不依赖固定 suggestion、box drawing 或 permission footer 装饰；更晚的 trust/update/select/failure 会阻止 ready。
- 普通 TraeX panel 的 workspace refresh 从同一 pane 的真实输出把 `agent_starting` 收敛为 `agent_idle`，并通过单 panel 同步保持 session/panel 一致。

## 独立验证

- `pnpm agent-team:verify-review-checkpoints`：PASS，`ok=true`，48 项；包含真实双 pane tmux、alternate-screen、并发 append、原子 boundary、generation、dead pane、detector 与普通 panel 状态收敛。
- `pnpm toolkit:verify-hooks`：PASS；包含 Electron/Toolkit 副本一致、pane-local panel identity、PTY provider、跨 provider guard、resume fallback。
- `pnpm app-server:verify-state-sync`：PASS；包含 fallback 收敛、unknown lifecycle no-op、真实 provider thread projection。
- `pnpm app-server:verify`：PASS。
- `pnpm dev:session:verify`：PASS，22 项。
- `pnpm runweave:update:test-cases`：PASS，18/18。
- `pnpm typecheck`：PASS。
- `pnpm lint`：PASS。

## Findings

- `remainingFindings=[]`。
- 历轮 P1 已解决并在当前 final tree 重跑通过：迟到 lifecycle owner 覆盖、跨 source fallback 双记录、unknown lifecycle 臆造 idle、延迟跨 provider Hook、PTY provider 丢失、Recent Thread 恢复、stale ready/failure 时序、双 pane output 串线、generation/worker watcher/detector 边界、capture 并发窗口及普通 panel/session 状态分叉。

本轮是最终只读代码审查；除本 review 文档与指定 pane-scoped outbox 外，未修改源码、测试、Git index 或 HEAD。Playwright/Dev Session 行为验收属于后续 `behavior_verify`，不以本次代码审查替代。
