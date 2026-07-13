# Codex / TraeX capability parity 增量代码复审（Round 13）

## 结论

`case_14` **PASS**。本轮以 index tree `86b0a0c8da099bd6e2d1d8418d652f9c1cf0c465` 为唯一审查对象，完整阅读相对 `7999fb9f5320f2582d184860b9ac3e3e1d34fba3` 的 4 个 staged path，并独立复跑 Round 12 的非 tmux PTY 失败 harness、provider 冲突矩阵、完整 Hook fixture及既有消费者门禁。Round 12 的 PTY provider P1 已修复，未发现仍开放的 P0/P1。

## Review checkpoint

- scope: `incremental`
- base commit / HEAD: `7999fb9f5320f2582d184860b9ac3e3e1d34fba3`
- target tree / index: `86b0a0c8da099bd6e2d1d8418d652f9c1cf0c465`
- requestedAt: `2026-07-13T07:44:52.576Z`
- staged paths: 4 个，与 prompt 和 run package 完全一致
- `git diff --cached --check`: 通过

## 增量审查结论

- dispatch 的 provider 优先级现在是：显式 `RUNWEAVE_HOOK_SOURCE` → 实际执行的 plugin root path → provider env hints。通用 `RUNWEAVE_TOOLKIT_PLUGIN_ROOT` 不再直接清空 provenance。
- `CODEX_PLUGIN_ROOT` 在非 tmux PTY 中恢复为 Codex；TraeX 兼容层使用的 `CLAUDE_PLUGIN_ROOT` 若实际位于 `.trae/` 路径则恢复为 Trae；真实 `.claude/` 路径保持 Claude。
- 多个 env hints 指向不同 provider 时返回 `unknown`，不会任意选择；tmux-backed terminal 可继续由 bridge 使用当前 pane command 收敛，PTY 则安全跳过 provider-specific Backend hook。
- 显式 source 始终最高优先级，可在可信 provider-specific 注册边界覆盖冲突提示。
- Electron resource 与 Toolkit 两份 dispatch 逐字一致；Hook resource 仍被 update planner 识别为 app-sensitive，需要 full App/Beta 更新。

## Round 12 P1 复验

Round 12 的同一 Codex PTY harness 当前得到：`appSource=codex`、`stateHookEvent=UserPromptSubmit`、`backendEventCount=1`、`backendAgent=codex`、query 正确且 `tmuxPaneId` 不存在。原结果 `source=unknown/stateHookEvent=null/backendEventCount=0` 已不再出现。

独立 provider 矩阵结果：

- TraeX PTY：`.trae` provider root → `source=trae`，Backend query 事件 1 条。
- Codex + Trae 冲突 hints：`source=unknown`，Backend 事件 0 条，安全 fail-closed。
- 同一冲突下显式 `RUNWEAVE_HOOK_SOURCE=codex`：`source=codex`，Backend query 事件 1 条。

仓库 Hook fixture 还覆盖了 Codex query、TraeX query/response、Claude provider、无 tmux pane、冲突 fail-closed 与显式 source 覆盖；tmux 的 stale panel、pane-local identity、延迟跨 provider guard 和 pane fallback 唯一性均保持通过。

## 已执行检查

- Round 12 同一非 tmux Codex harness：通过。
- 独立 Trae/conflict/explicit PTY provider 矩阵：通过。
- `pnpm toolkit:verify-hooks`: 通过。
- `pnpm typecheck`: 通过。
- `pnpm lint`: 通过。
- `pnpm app-server:verify-state-sync`: 通过。
- `pnpm agent-team:verify-review-checkpoints`: 21 项通过。
- `pnpm runweave:update:test-cases`: 18/18 通过。
- 两份 staged dispatch blob 一致：`80ef584b1e1f0d5c755a177e09805b6fd9ed9557`。

残余边界：provider env hints 冲突且没有显式 source、实际 plugin path 或 tmux pane command 时会保持 `unknown`；这是当前设计的安全退化，不会错误串到另一 provider。

本轮只新增此 review 文档与 pane outbox；未修改源码、测试、Git index 或 HEAD。
