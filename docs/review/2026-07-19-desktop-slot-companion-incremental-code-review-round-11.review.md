# Desktop Slot Companion 增量代码审查（Round 11）

## 结论

未通过。`frontend/src/App.tsx` 的 3 行增量仍存在 1 个阻断性 P1：它只在导航前写入目标 `activeSessionId`，没有原子切换目标 Session 所属的 Project context。对于 Companion 的跨 Project/Worktree Slot，Terminal workspace 的 context effect 与 visible-session effect 会使用同一 render 的旧 context 快照相互覆盖，Session/route 在旧目标间振荡；Attention handler 却会在振荡前因 store 瞬时等于目标而返回 `opened`。未发现 P0。

## Finding

### P1：跨 Context Slot 会提前返回 opened，随后 Session/route 振荡回旧目标

增量在 `frontend/src/App.tsx:411-413` 直接调用 `selectActiveSession(intent.terminalSessionId)`。该 action 只写 `activeSessionId`（`frontend/src/features/terminal/workspace-store.ts:278-279`），不写 `activeParentProjectId` 或 `activeProjectId`。

Terminal workspace 随后有两个有顺序的 effect：

1. `frontend/src/components/terminal/terminal-workspace-content.tsx:261-317` 根据 `activeSessionProjectId` 切换 Project context；
2. `:329-360` 使用本次 render 捕获的旧 `visibleSessions`，若目标 Session 不在旧 context 内，又把 `activeSessionId` 改回旧 Session。

同一 parent Project 下两个 context 的结构化 harness 从 `context-a/session-b` 开始，连续四个 render 得到 `context-b/session-a → context-a/session-b → context-b/session-a → context-a/session-b`。与此同时，`waitForTerminalSessionSelection` 在 handler 写入 Session 后立即读取 store 并返回 true，后续 opened/fallback、Completion authorization 或 failed retirement 都能在 React effects 收敛前发生。

因此，跨 Worktree Completion 可能确认 revision 并退役，failed Slot 可能写 failure-seen，而主窗口最终没有稳定停留在目标 Session。该问题重新违反 `slot_open_success_after_target_surface`，影响 DSC-005、DSC-006 和 DSC-007。

修复方向：根据已验证存在的目标 Session 记录，一次性切换 parent Project、context Project 与 Session（复用 `selectProjectContext` 或等价原子 action），再导航并等待目标 route/workspace 稳定；不能只写裸 `activeSessionId`。

## 非阻断 Findings

### P2：Companion 全局 CSS 污染主窗口

`frontend/src/components/desktop-companion/desktop-companion.css:1-2` 仍使用全局 `:root` / `body` `!important` 规则。

### P2：Terminal event 即时刷新仍未实现

`frontend/src/features/attention/use-attention-snapshot.ts:24-44` 仍只有 4 秒轮询，没有计划承诺的 Terminal events WebSocket invalidate。

## 回归点

- `slot_open_timeout_cancels_late_ack`：未回归；deadline/authorization 链未被本增量修改。
- `companion_route_before_renderer_bootstrap`：未回归。
- `panel_fallback_is_user_visible`：未回归。
- `slot_open_success_after_target_surface`：重新打开；当前只证明 store 曾瞬时等于目标，不能证明跨 context 的目标表面稳定。

## 审查范围与证据

- `scope=incremental`
- `baseCommit=fe516828f10022490ac18221c9515f7d239c5dd3`
- `targetCommit=null`
- `targetTree=d6b0a0955a00971b7c1f87869051fe5700251fc8`
- `git write-tree` 精确等于 targetTree；唯一 staged path 为 `frontend/src/App.tsx`。
- 计划与测试计划 SHA-256 均与 prompt 匹配。
- 跨 context selection review harness：五项源码合同成立，四轮状态稳定交替，`reproduced=true`。
- `git diff --cached --check`：通过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm testplan:validate docs/testing/platform/desktop-slot-companion.testplan.yaml`：通过，12 个 required cases。

Code Agent 的真实 After 证据只覆盖同一 fixture context 内两个 Session，不能证明全局 Companion 的跨 Project/Worktree 调用方。该证据有效关闭了原场景，但没有覆盖本次结构化复现的受影响消费者。
