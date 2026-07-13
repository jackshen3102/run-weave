# Codex / TraeX capability parity 增量代码复审（Round 12）

## 结论

`case_14` **FAIL**。本轮以 index tree `3a84ed781c937ec6d5d611dfea884a2017c1b1bb` 为唯一审查对象，完整阅读相对 `7999fb9f5320f2582d184860b9ac3e3e1d34fba3` 的 3 个 staged path，并独立复跑 Hook fixture、质量门禁与非 tmux PTY 最小 harness。发现 1 个仍开放的 P1：新增 dispatch 短路在 PTY runtime 中把 Codex/Trae/Claude 的可信 provider 提示全部抹成 `unknown`，bridge 又无法从不存在的 tmux pane 恢复，导致 Backend agent-hook 与 query/response Activity 链路被跳过。

## Review checkpoint

- scope: `incremental`
- base commit / HEAD: `7999fb9f5320f2582d184860b9ac3e3e1d34fba3`
- target tree / index: `3a84ed781c937ec6d5d611dfea884a2017c1b1bb`
- requestedAt: `2026-07-13T07:31:22.491Z`
- staged paths: 3 个，与 prompt 和 run package 完全一致
- `git diff --cached --check`: 通过

## Remaining finding

### P1：外置 Hook root 会让非 tmux PTY 的 provider 永久退化为 unknown

`runweave-hook-dispatch.cjs:23-25` 现在只要存在 `RUNWEAVE_TOOLKIT_PLUGIN_ROOT` 就在检查 `CODEX_PLUGIN_ROOT` / `CLAUDE_PLUGIN_ROOT` 与实际 plugin path 之前返回 `unknown`。该 root 会由 `runtime-launcher.ts:276-280` 同样注入普通 PTY terminal；显式 `runtimePreference="pty"` 是共享 API 的合法值，`auto` 在 tmux 不可用或启动失败时也会落到该分支。

bridge 只有在 `TMUX` / `TMUX_PANE` 存在时才能读取 pane command；PTY 中 `commandName=null`，因此 `source` 保持 `unknown`、`stateHookEvent=null`，`runweave-hook-bridge.cjs:448-485` 的 Backend agent-hook 分支完全不执行。当前 targetTree 的独立 Codex PTY harness 得到：App Server 仅 1 条 `source=unknown/stateHookEvent=null` 事件，Backend 请求数为 0。`UserPromptSubmit` query、Stop response、Terminal thread metadata 与 Activity query/response 因而丢失。

现有新增 fixture 全部带 `TMUX` 和 fake pane command，所以能从 `unknown` 恢复为 `trae`/`claude`，没有覆盖这一公开 fallback runtime。仓库架构约束明确规定 fallback PTY 除不具备恢复能力外，功能和数据语义应保持一致。

修复方向：不要仅凭通用 root 是否存在就删除 provider provenance。应在 provider-specific hook 注册/启动边界显式传入可信 source，或为 bridge 提供同时适用于 tmux 与 PTY 的可信当前命令来源；同时增加 Codex、TraeX、Claude 的非 tmux fixture，覆盖单一 provider hint、冲突环境变量和显式 source 优先级。不能用 cwd/mtime 或任意继承环境猜测 provider。

定位：

- `electron/resources/hooks/runweave-hook-dispatch.cjs:17-45`
- `plugins/toolkit/hooks/runweave-hook-dispatch.cjs:17-45`
- `electron/resources/hooks/runweave-hook-bridge.cjs:134-174,350-367,448-485`
- `backend/src/terminal/runtime-launcher.ts:272-280`
- `backend/src/routes/terminal.ts:267-355`
- `packages/shared/src/terminal/session.ts:4-12`

## 已确认修复与回归点

- tmux-backed TraeX 在同时继承 `CLAUDE_PLUGIN_ROOT` 时，当前 fixture 能通过 pane command 把 `unknown` 恢复为 `trae`，Stop response 与 UserPromptSubmit query 均进入 Backend。
- 显式 `RUNWEAVE_HOOK_SOURCE` 优先级仍在 root 短路之前，没有被本轮覆盖。
- Electron resource 与 Toolkit 两份 dispatch 逐字一致。
- Round 10 的同源 Hook root、pane-local panel 覆盖、App Server state-sync 与 review checkpoint 仍通过；当前 P1 只发生在没有 tmux pane context 的 PTY 消费分支。

## 已执行检查

- 当前 targetTree 独立 PTY harness：**失败复现**，`appSource=unknown`、`stateHookEvent=null`、`backendEventCount=0`。
- `pnpm toolkit:verify-hooks`: 通过，但仅覆盖 tmux root 冲突分支。
- `pnpm typecheck`: 通过。
- `pnpm lint`: 通过。
- `pnpm app-server:verify-state-sync`: 通过。
- `pnpm agent-team:verify-review-checkpoints`: 21 项通过。
- 两份 staged dispatch blob 一致：`f47ae1b3b87813b04e4cfa354f12b864b3f4db81`。

本轮只新增此 review 文档与 pane outbox；未修改源码、测试、Git index 或 HEAD。
