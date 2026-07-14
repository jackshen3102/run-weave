# Agent Team C5 Authoritative-State Code Review

## 结论

`case_25` 不通过，仍有 1 条阻断 P1。上一版 UI/scrollback 文案判断已完全撤销，`captureReadCount=0` 成立；panel/session/pane、provider、terminalState、thread lifecycle 的多数 fail-closed 检查也成立。但当前所谓 generation boundary 使用 `panel.lastActivityAt`，它不能可靠表示当前 pane process/provider generation，普通 Node 仍可继承旧 Codex 状态并被误认。

本审查只读，未修改、stage 或 commit 源码，未执行 behavior 验收。

## 固定边界

- base / HEAD: `90c3b1102a45d0e47702461c194d58c597a2846a`
- working-tree tree: `d02c37e7ed80989636c15714ee530bd29ef68edb`
- diff SHA-256: `909e609c77f8b7104e06c8cbd0266ca4e6d3ffa393e14e75b398fdb4410ed868`
- changed paths: `agent-readiness.ts`、`service-serial-dispatch.ts`、`service-support.ts`
- size: 122 additions / 36 deletions
- `git diff --check`: 通过

## P1 阻断

### Node wrapper 的 generation boundary 可继承旧 Codex 状态

`hasReadyCodexPaneState` 用 `panel.lastActivityAt` 作为 `paneGenerationStartedAt`，并要求 `lastThreadUpdatedAt >= lastActivityAt`。但真实 panel reconciliation 的 `resolveEffectivePanelActiveCommand` 对任意 `pane_current_command=node` + 既有 `activeCommand=codex` 都保留 `codex`。当普通 Node 在同 pane 接管时，如果 cwd/status 等没有其它变化：

- `activeCommand` 继续是 `codex`；
- `terminalState=agent_idle/codex` 可继续保留；
- completed `lastThreadProvider/status/updatedAt` 可继续保留；
- workspace 不一定写 panel，`lastActivityAt` 不推进到新 process generation。

因此普通 Node 与合法 Codex node-wrapper 在当前检查输入上不可区分。独立调用生产 readiness 方法时，metadata 为 `node/pane_current_command`，panel 继承 completed Codex idle lifecycle 且 `lastThreadUpdatedAt > lastActivityAt`，结果为 `true`；显式把 `lastActivityAt` 推进到 lifecycle 之后才变为 false。该反例同时说明现有 `ordinaryNode=false` / `staleGeneration=false` 证据没有覆盖真实“旧状态被 node-wrapper masking 保留”的 transition。

影响：serial dispatch 仍可能把 worker prompt 注入普通 Node 进程，违反普通 Node、旧 generation 和 stale completion 必须 fail closed 的 invariant。

修复方向：generation 必须来自当前 pane 的真实 provider/process lifecycle token，并在 owner/process transition 时无条件推进或使旧 lifecycle 失效；不能复用会被 `shouldKeepNodeWrappedActiveCommand` 掩盖的 `lastActivityAt`。provider/thread lifecycle 必须与该 generation 同源绑定，缺失或 generation 不一致时 fail closed。

定位：`backend/src/agent-team/agent-readiness.ts:391-438`、`backend/src/terminal/application/panel-metadata.ts:213-247`、`backend/src/terminal/application/panel-workspace.ts:100-190`。

稳定 invariant：`agent-team.codex-node-wrapper-authoritative-readiness`。

## 已验证部分

- UI/scrollback detector 已从 Codex readiness 移除；受控 probe `captureReadCount=0`。
- panelId、terminalSessionId、tmuxPaneId、provider、terminalState、thread id/status 的结构检查均 fail closed。
- 跨 pane、显式更新后的旧 generation、缺状态/缺 lifecycle/错误 provider 负例通过。
- TraeX 仍沿用原有 `hasTraeReadyPrompt` 与 startup-output boundary；`pnpm agent-team:verify-review-checkpoints` 全部通过。
- failure-state P1 保持 resolved：readiness 失败进入 `need_human/null/null`、workers frozen，repair attempts 不增加。

## 验证

- `pnpm agent-team:verify-review-checkpoints`：通过。
- `pnpm --filter @runweave/backend typecheck`：通过。
- `pnpm --filter @runweave/backend lint`：通过。
- 受控 production-method counterexample：`inheritedCompletedCodexState=true`、`explicitNewerGeneration=false`、`crossPane=false`、`captureReadCount=0`。
- `resolveEffectivePanelActiveCommand(node, existingCodex)` → `codex`，证明普通 Node transition 可被 wrapper masking。
- `dvs-d952ef` 证据和清理状态已核查；`dvs-8854aa` failure-state 证据仍有效。

## 非阻断既有项

P2 `recheck-watchdog-clock-lifecycle` 继续作为 informational，本增量未处理。
