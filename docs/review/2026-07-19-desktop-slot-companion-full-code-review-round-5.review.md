# Desktop Slot Companion 完整 staged diff 代码审查（Round 5）

## 结论

未通过。完整 staged diff 仍存在 1 个未修复 P1：新的 Completion authorization 在 acknowledgement 发出前同时清除了 Electron main 与 renderer 的 deadline timer；一旦 Backend acknowledgement 请求停滞或响应丢失，Companion `openSlot` 将永久 pending，不能按 DSC-011 在超时后返回 `timed_out`。未发现 P0。

上一轮“客户端 abort 无法撤销已提交 acknowledgement”的具体竞态已经被授权门槛消除，但同一 timeout 不变量没有闭合，而是从“超时后仍提交”变成了“授权后不再超时”。此前已关闭的 3 个 P1 继续保持关闭。另有 2 个非阻断 P2 仍存在。

## Findings

### P1：Completion authorization 永久取消 open request 超时

`electron/src/main.ts:140-151` 在 `attention:authorize-completion` 成功时清除 `pending.timer` 并设为 `null`；`frontend/src/App.tsx:439-448` 在发送 acknowledgement PATCH 前又清除 renderer 的 `deadlineTimer`。之后没有新的 bounded timer，`updateTerminalSession` 仍可无限等待网络或 Backend 持久化响应。

因此，只要 renderer 在 deadline 前取得 authorization，但 acknowledgement 请求随后不返回，`pendingRequests` 不会被 timeout 删除，Companion 调用也不会 resolve。重复同一 requestId 只会复用同一个永久 pending promise。若 Backend 已提交 revision 但响应丢失，Attention 轮询还可能退役提醒，而原 invoke 仍悬挂。

受控状态机 harness 读取当前源码的两个 timer-clear 合同，并让授权后的 acknowledgement 永不完成；连续 3 次均在两倍 deadline 后得到 `still_pending_after_deadline`。这直接违反 DSC-011 步骤 4 的“主 renderer 超时后 invoke 以 timed_out 结束”。

修复方向：不能用永久取消 deadline 来换取提交不可撤销性。Completion acknowledgement 需要一个 Backend 可原子校验的一次性 open request/deadline，或由 Electron/Backend 共同提供有界且可判定的提交结果；无论授权位于何处，Companion invoke 都必须在固定上限内结束。

### P2：Companion 全局 CSS 仍污染主窗口

`frontend/src/components/desktop-companion/desktop-companion.css:1-2` 仍使用全局 `:root` / `body` `!important` 规则；该 CSS 由主 App 静态导入，主窗口 renderer 同样会覆盖背景与 overflow。

### P2：Terminal event 即时刷新仍未实现

`frontend/src/features/attention/use-attention-snapshot.ts:24-44` 仍只有 4 秒轮询，没有计划承诺的 Terminal events WebSocket invalidate，结构化状态变化最多延迟约 4 秒。

## 已关闭的 P1

1. `slot_open_success_after_target_surface`：当前顺序为 route → 等待目标 Session → Panel → Agent Team → Completion ack → result。
2. `companion_route_before_renderer_bootstrap`：打包态直接以 `/desktop-companion` pathname 加载 packaged index。
3. `panel_fallback_is_user_visible`：Panel fallback message 渲染为 Companion 的可见 `role="status"` 提示。

## 审查范围与证据

- `scope=full`
- `baseCommit=0a92b516f788dcc01d44faa78ff730ab77f56d05`
- `targetCommit=null`
- `targetTree=cca7eeca8ef31e4c99ffde19aef32e8443c3e2eb`
- `git write-tree` 精确等于 targetTree；26 个 staged 路径与 reviewTarget 完全一致。
- 计划与测试计划 SHA-256 均与 prompt 匹配。
- `git diff --cached --check`：通过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm testplan:validate docs/testing/platform/desktop-slot-companion.testplan.yaml`：通过，12 个 required cases。
- authorized acknowledgement hang review harness：连续 3 次 `still_pending_after_deadline`，`reproduced=true`。

本轮为代码审查，未执行 macOS 真实桌面行为验收；阻断项由受控 review harness 与 staged source 的 timeout 状态机共同确认。
