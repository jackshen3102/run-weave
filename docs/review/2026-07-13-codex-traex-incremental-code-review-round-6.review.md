# Codex / TraeX capability parity 增量代码复审（Round 6）

## 结论

`case_14` **FAIL**。当前 index tree 精确等于 `e3d6ef7774f74d6818fd3f9ae8560eb308a71223`，本轮 10 个 staged path 已全量阅读；增量修复了 Hook 从 tmux pane 取得真实 panel identity 的主失败链，但独立最小 harness 发现 1 个仍可执行复现的 P1：同一 pane 切换到 Codex 后，迟到的 Trae Hook 会被 pane fallback 接受并错误映射为当前 Codex provider，覆盖 current/last thread metadata。

## Review checkpoint

- scope: `incremental`
- base commit / HEAD: `fb1e4d13824f2b3c4698641df8b45b19e39f0423`
- base tree: `68921982e8d52206bf53e109468750a5ff8d3a7a`
- target tree / index: `e3d6ef7774f74d6818fd3f9ae8560eb308a71223`
- requestedAt: `2026-07-13T05:29:31.883Z`
- staged paths: 10 个，与 prompt 和 run package 完全一致
- `git diff --cached --check`：通过

## Remaining finding

### P1：pane fallback 会把迟到的跨 provider Hook 误记为当前 provider

`backend/src/terminal/agent-hook-processor.ts:117-150,382-391` 新增的 pane fallback 能把 stale `panelId` 纠正到同 session 的实际 pane；但随后 `effectiveAgent` 允许仅凭 Hook 自带的旧 `commandName` 选择当前 `panelAgent`，`currentCommandMatches` 又因两者相等而放行写入。

当前 staged tree 的最小 harness 先验证 happy path：Trae pane 收到 stale panel id 时成功路由到 `panel-actual`。随后把同一 pane 的当前状态切到 `codex-current/codex`，注入迟到的 Trae `UserPromptSubmit(threadId=stale-trae-thread, commandName=traex)`，实际输出为：

```json
{
  "status": "recorded",
  "panelId": "panel-actual",
  "threadId": "stale-trae-thread",
  "provider": "codex"
}
```

执行调用同时包含 `session-thread(stale-trae-thread, codex)`、`panel-thread(panel-actual, stale-trae-thread, codex)` 和 preview 清空。结果会把 Trae thread 误标为 Codex，并覆盖当前 Codex identity，直接破坏 provider 隔离、history、Activity 与后续状态补偿。

修复方向：pane fallback 只能解决 panel 定位，不能跳过当前 provider/thread 所有权校验。当前 pane 的 active provider 与事件 source 不一致时应忽略迟到事件；Hook 自带 `commandName` 可以证明事件来源，但不能用于把该事件映射成不同的当前 `panelAgent`。应把此跨 provider 场景加入仓库脚本回归验证。

## 已验证的修复与回归点

- tmux pane 现在保存 `@runweave_panel_id`，workspace/split 会同步该值；Hook bridge 从实际 pane 读取 panel id，并覆盖继承到新终端的 stale `RUNWEAVE_TERMINAL_PANEL_ID`。
- `pnpm toolkit:verify-hooks` 验证 stale env `stale-panel` 被 pane-local `panel-pane-3` 替换，App Server、agent-hook 与 completion 三条消费者同时收到正确 panel、thread 与 command；Electron 与 Toolkit 两份 Hook 资源逐字一致。
- 上一轮“迟到 lifecycle observation 覆盖当前 provider/thread”的保护仍有效：当前 harness 保持 `codex-current/codex`，前台 mutation 调用数为 0。
- 跨 source fallback 收敛与 unknown lifecycle no-op 由当前 `pnpm app-server:verify-state-sync` 再次通过，未出现回归。

## 已执行检查

- `git write-tree`：`e3d6ef7774f74d6818fd3f9ae8560eb308a71223`。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm toolkit:verify-hooks`：通过。
- `pnpm app-server:verify-state-sync`：通过。
- `pnpm agent-team:verify-review-checkpoints`：通过。
- pane fallback happy-path harness：通过。
- stale lifecycle owner harness：通过。
- provider-switch delayed Hook harness：复现上述 P1。

本轮是只读代码复审；未修改源码、测试、Git index 或 HEAD。
