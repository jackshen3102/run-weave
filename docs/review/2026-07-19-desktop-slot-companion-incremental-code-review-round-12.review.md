# Desktop Slot Companion 增量代码审查（Round 12）

## 结论

通过。`frontend/src/App.tsx` 的本轮增量已修复上轮 `slot_open_success_after_target_surface` P1：目标 Session 的 Backend 记录现在同时决定 parent Project、context Project 与 Session，三者通过一个 Zustand action 原子写入；成功链路还要求目标 pathname 与该三元组连续稳定 100ms，避免 React workspace effects 收敛前提前返回 `opened`。未发现新的 P0/P1。

仍有两项不阻断本轮门禁的既有 P2：Companion CSS 的全局选择器会影响主 renderer；Attention 仍以 4 秒轮询刷新，尚未接入 Terminal events 即时失效。这两项不在唯一 changed path `frontend/src/App.tsx` 内，本轮未修复也未恶化。

## 上轮 P1 修复验证

### `slot_open_success_after_target_surface`：已修复

- `frontend/src/App.tsx:416-429` 先从已认证 Backend 返回的 Session 列表找到目标记录，再用 `targetSession.projectId` 计算 parent Project，并调用一次 `selectProjectContext(parent, context, session)`；没有信任 Slot payload 中的 `projectId` 来切换 workspace。
- `frontend/src/features/terminal/workspace-store.ts:171-180` 的 action 在单次 `set` 中同步 `activeParentProjectId`、`activeProjectId`、`activeSessionId`，消除了上轮 Session-only 写入与两个 workspace effects 之间的振荡。
- `frontend/src/App.tsx:67-103` 同时检查目标 pathname、parent Project、context Project 与 Session。任一字段失配都会清空 `stableSince`，只有连续 100ms 匹配才完成等待。
- 独立 `attention-open-cross-context-selection` harness 从 `context-a/session-a` 打开 `context-b/session-b`，连续四轮按真实 effects 顺序演算后均保持 `context-b/session-b`。加入第 50ms 的瞬时失配后，成功点从第一段窗口推迟到第二段完整稳定期的第 175ms，证明不会沿用失配前的稳定时间。

## 失败链路与消费者

- Connection 身份或 token 不可用时，仍在读取 Session 和修改 workspace 前返回 `connection_unavailable`。
- Session 不存在时，`frontend/src/App.tsx:419-422` 在任何 context 写入或导航前返回 `session_not_found`。
- deadline 或 Electron cancel 会 abort 稳定等待；等待返回 false 后不会进入 Panel、Agent Team、Completion authorization 或普通成功报告。
- Panel fallback、Agent Team 二路窗、Completion authorization 与普通 `opened` 报告均位于稳定等待之后。Companion 只有收到 `opened` / `opened_with_panel_fallback` 才写 failure-seen，因此 DSC-005、DSC-006、DSC-007 的退役消费者不再读取上轮的瞬时选择。
- Completion authorization 后的 acknowledgement 仍是异步副作用；authorization 已经形成 openSlot 的唯一成功终态，ack 失败或挂起不会把 invoke 重新变成成功或二次完成。

## 非阻断 Findings

### P2：Companion 全局 CSS 污染主窗口

`frontend/src/components/desktop-companion/desktop-companion.css:1-2` 仍使用全局 `:root` / `body` 规则。本轮唯一增量文件未触及该问题。

### P2：Terminal event 即时刷新仍未实现

`frontend/src/features/attention/use-attention-snapshot.ts:24-49` 仍只使用 4 秒轮询，没有以 Terminal events 触发即时 snapshot 刷新。本轮未触及该链路。

## 既有 resolved findings 回归检查

- `slot_open_timeout_cancels_late_ack`：未回归；deadline abort 仍阻止迟到成功，Completion authorization 与 acknowledgement 的边界未变。
- `companion_route_before_renderer_bootstrap`：未回归；本轮未修改 Companion Window 或 renderer bootstrap。
- `panel_fallback_is_user_visible`：未回归；fallback result 与 Companion `openNotice` 消费者未修改。
- `slot_open_success_after_target_surface`：本轮关闭；原子三元组与稳定窗口共同覆盖上轮跨 Context 状态机。

## 审查范围与证据

- `scope=incremental`
- `baseCommit=fe516828f10022490ac18221c9515f7d239c5dd3`
- `targetCommit=null`
- `targetTree=b60852a70c70983b0021a66b271e24661450eb36`
- `changedPaths=frontend/src/App.tsx`
- 审查起点 HEAD 为 baseCommit，`git write-tree` 精确等于 targetTree，唯一 staged path 与 prompt 一致。最终校验期间 Agent Team 将同一棵树提交为 `67f4f485301be7f8b87a89f5254060a91c785029`；该提交的 parent 正是 baseCommit、tree 仍为 targetTree，且相对 base 的唯一 changed path 仍是 `frontend/src/App.tsx`，因此审查内容没有漂移。outbox 仍按 prompt 原样回显 `targetCommit=null`。
- 计划和测试计划 SHA-256 均与 prompt 一致。
- 独立结构 harness：六项源码合同、四轮跨 Context 状态机、稳定窗口重置场景全部通过。
- `git diff --cached --check`：通过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm testplan:validate docs/testing/platform/desktop-slot-companion.testplan.yaml`：通过，12 个 required cases。

本轮是增量代码审查，没有执行 macOS 打包态桌面验收；该运行时验收仍由 DSC-001 至 DSC-012 的行为验证阶段负责，不改变本次代码门禁结论。
