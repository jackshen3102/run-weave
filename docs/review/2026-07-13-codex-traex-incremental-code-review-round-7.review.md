# Codex / TraeX capability parity 增量代码复审（Round 7）

## 结论

`case_14` **FAIL**。本轮以 index tree `b29444c0a45c9e53eab67a8a071504e89b8760df` 为唯一审查对象，未沿用 behavior outbox 的 threadId 概括。Round 6 的跨 provider 覆盖已经修复，Hook/panel/thread 主链及现有 staged fixture 均通过；但 invalid raw panel 回退仍未验证 tmux pane 匹配唯一性。同一 terminal session 内存在两个相同 `tmuxPaneId` 的 panel 时，当前代码会选择第一个并写入 thread metadata，仍有 1 个 P1。

## Review checkpoint

- scope: `incremental`
- base commit / HEAD: `fb1e4d13824f2b3c4698641df8b45b19e39f0423`
- base tree: `68921982e8d52206bf53e109468750a5ff8d3a7a`
- target tree / index: `b29444c0a45c9e53eab67a8a071504e89b8760df`
- requestedAt: `2026-07-13T05:46:51.958Z`
- staged paths: 10 个，与 prompt 和 run package 完全一致
- `git diff --cached --check`：通过

工作树中的 `scripts/verify-toolkit-hooks.mjs` 另有一行未暂存断言。为避免污染证据，Hook fixture 从 `b29444c…` 通过 `git archive` 提取到临时目录后执行；该 staged snapshot fixture 通过。

## Remaining finding

### P1：invalid panel fallback 未要求 tmux pane 唯一匹配

`backend/src/terminal/agent-hook-processor.ts:388-404` 使用 `Array.find()` 取得 `byPane`。这只能证明“至少有一个匹配”，不能证明同一 `terminalSessionId` 内匹配唯一。当前 targetTree 的独立 harness 得到：

```json
{
  "unique": { "status": "recorded", "panelId": "panel-a" },
  "duplicate": { "status": "recorded", "panelId": "panel-a" }
}
```

duplicate 场景同时执行 `panel-state(panel-a)`、`panel-last(panel-a)`、`panel-thread(panel-a)`。当持久化数据、启动竞态或 workspace 去重前短暂存在重复 pane 记录时，invalid raw panelId 会被静默归到第一个 panel，可能造成同 session 内跨 panel thread/history 串线。

修复方向：按 `terminalSessionId + tmuxPaneId` 收集匹配项，只有恰好一个时允许 fallback；0 个或多于 1 个都返回 ignored。现有 fixture 应增加 duplicate pane 断言，不能只覆盖单一 match happy path。

## 五条指定链路核对

1. **initial / split / existing pane**：initial/new pane 与 existing pane 都经过 `ensureTmuxPanelWorkspace()` 的 `syncTmuxPanePanelId()`；split pane 在创建后、panel upsert 前显式调用 `setPanePanelId()`。
2. **Hook bridge 当前 pane 读取与退化**：bridge 使用当前 `TMUX_PANE` 和解析出的 tmux socket 读取 `@runweave_panel_id`；缺少上下文、命令失败或超时均返回 null context，不抛错、不清除现有 env。
3. **invalid raw panel fallback**：查询范围被限制在 `listPanels(terminalSessionId)`，0 match 会 ignored，单一 match 正向 harness 通过；但多 match 未 ignored，形成上述 P1。
4. **App Server / Backend identity 一致性**：staged Hook fixture 独立确认 App Server `correlationId/payload.threadId=thread-1`、scope/payload panel=`panel-pane-3`，Backend agent-hook/completion 使用同一 panel、thread 与 `tmuxPaneId=%13`。
5. **双副本一致性**：Electron resource 与 Toolkit 的 bridge blob 均为 `f1b57e68499ce308215698807094e5c28fea7678`，payload blob 均为 `fef1d54524c52056a62cbfd9f23e2b2075c20614`。

## Resolved findings 回归

- Round 6 跨 provider delayed Hook：staged fixture 确认返回 ignored，`codex-current/codex` 不变且 mutation 为 0。
- 迟到 lifecycle observation：当前 harness 保持 `codex-current/codex`，mutation 为 0。
- 跨 source fallback 与 unknown lifecycle no-op：当前 `pnpm app-server:verify-state-sync` 通过。
- pane-local panel identity：staged fixture 确认 stale env 被 `panel-pane-3` 覆盖，并在 App Server 与 Backend 两侧一致消费。

## 已执行检查

- `git write-tree`：`b29444c0a45c9e53eab67a8a071504e89b8760df`。
- staged targetTree Hook fixture：通过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm app-server:verify-state-sync`：通过。
- `pnpm agent-team:verify-review-checkpoints`：通过。
- invalid panel 单一 pane match harness：通过。
- invalid panel duplicate pane match harness：复现上述 P1。

本轮是只读代码复审；未修改源码、测试、Git index 或 HEAD。
