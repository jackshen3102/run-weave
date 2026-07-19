# Desktop Slot Companion 完整 staged diff 代码审查（Round 4）

## 结论

未通过。完整 staged diff 仍存在 1 个未修复 P1：Electron 超时后的 renderer abort 只能终止客户端等待，不能撤销已经到达 Backend 的 Completion acknowledgement；因此 Companion 已收到 `timed_out` 后，revision 仍可能被持久化并退役提醒。未发现 P0。

上一轮的 Panel fallback 可见提示 P1 已修复。此前的目标表面打开顺序与打包态 Companion 初始路由 P1 继续保持关闭。另有 2 个非阻断 P2 仍存在。

## Findings

### P1：超时取消不能阻止已到达 Backend 的迟到 Completion acknowledgement

`frontend/src/App.tsx:437-440` 给 acknowledgement PATCH 传入了共享 `AbortSignal`，但该 signal 只控制 renderer 侧 `fetch`。`backend/src/routes/terminal.ts:506-511` 收到请求后无条件调用 `acknowledgeSessionCompletion`，`backend/src/terminal/manager-session-runtime.ts:451-456` 随即更新内存 revision 并持久化；请求没有携带或校验 open requestId/deadline，也没有可回滚的提交门槛。

受控 HTTP harness 在服务端收到请求时提交状态、延迟响应，然后 abort 客户端 fetch，稳定得到 `{"fetchResult":"AbortError","acknowledgedAfterAbort":true}`。这对应主 renderer 在 Electron 10 秒 deadline 前发出 acknowledgement、Backend 已接收或已提交，但响应跨过 deadline 的产品时序：Companion 得到 `timed_out`，renderer 不再报告迟到 result，然而 acknowledgement 已生效，下一次 Attention snapshot 仍会退役 Completion。

该问题违反 DSC-005 的“失败时 revision 与提醒均保留”，以及 DSC-011 的“超时后迟到结果不能二次完成或退役提醒”。修复需要把 open request 的有效性带到 Backend 提交边界（例如一次性 requestId/deadline 条件确认），而不是只取消客户端响应等待。

### P2：Companion 全局 CSS 仍污染主窗口

`frontend/src/components/desktop-companion/desktop-companion.css:1-2` 仍使用全局 `:root` / `body` `!important` 规则；该 CSS 由主 App 静态导入，主窗口 renderer 同样会覆盖背景与 overflow。

### P2：Terminal event 即时刷新仍未实现

`frontend/src/features/attention/use-attention-snapshot.ts:24-44` 仍只有 4 秒轮询，没有计划承诺的 Terminal events WebSocket invalidate，结构化状态变化最多延迟约 4 秒。

## 已关闭的 P1

1. `slot_open_success_after_target_surface`：当前顺序为 route → 等待目标 Session → Panel → Agent Team → Completion ack → result。
2. `companion_route_before_renderer_bootstrap`：打包态直接以 `/desktop-companion` pathname 加载 packaged index，Beta badge guard 在 bootstrap 前成立。
3. `panel_fallback_is_user_visible`：`opened_with_panel_fallback.message` 现保存到 `openNotice` 并渲染为 `role="status"` 的可见提示。

## 审查范围与证据

- `scope=full`
- `baseCommit=0a92b516f788dcc01d44faa78ff730ab77f56d05`
- `targetCommit=null`
- `targetTree=1436e21275a5adb30919cb27e6e22fe6985c08ad`
- `git write-tree` 精确等于 targetTree；26 个 staged 路径与 reviewTarget 完全一致。
- 计划与测试计划 SHA-256 均与 prompt 匹配。
- `git diff --cached --check`：通过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm testplan:validate docs/testing/platform/desktop-slot-companion.testplan.yaml`：通过，12 个 required cases。
- timeout acknowledgement review harness：`fetchResult=AbortError` 且 `acknowledgedAfterAbort=true`。

本轮为代码审查，未执行 macOS 真实桌面行为验收；阻断项由受控 review harness 与 staged source 的提交边界共同确认。
