# Desktop Slot Companion 完整 staged diff 代码审查（Round 3）

## 结论

未通过。上一轮 2 个 P1 已修复并由静态合同复验通过，但完整 staged diff 仍存在 2 个新的未修复 P1；上一轮 2 个 P2 仍未处理。未发现 P0。

## Findings

### P1：Electron main 超时后不会取消 renderer，迟到 Completion ack 仍可退役提醒

`electron/src/main.ts:140-145` 在 10 秒时把 request 固化为 `timed_out` 并丢弃迟到 result；但 renderer 只给 Session 选择等待分配了 8 秒（`frontend/src/App.tsx:58`、`:390`），其后的 Panel focus、Agent Team split/open 和 Completion ack（`:394-410`）没有共享 deadline、AbortSignal 或取消检查。`frontend/src/services/http.ts:52-63` 的请求也没有默认超时。

因此，只要 Session 在接近第 8 秒才选中、后续请求跨过第 10 秒，Companion 会收到 `timed_out`，而 renderer 仍可在之后写入 `acknowledgedCompletionRevision`；迟到 result 虽被 main 丢弃，Completion 提醒仍会因 Backend revision 已确认而退役。

这直接违反 DSC-005 的“失败时 revision 与提醒均保留”，也违反 DSC-011 的“超时后迟到结果不能二次完成或退役提醒”。

修复方向：为一次 open intent 建立单一 deadline/cancellation 所有权。Electron main 超时必须通知或取消 renderer；renderer 的 Session wait、Panel、split 与 ack 都必须受同一 AbortSignal/剩余预算约束，并在写 ack 前再次确认请求仍 pending。

### P1：Panel fallback message 没有任何可见 UI 消费者

`frontend/src/App.tsx:411-415` 返回 `opened_with_panel_fallback` 和 message，但 `frontend/src/components/desktop-companion/desktop-companion.tsx:68-75` 只把该状态当作失败提醒可退役的成功信号，既不读取 `result.message`，也没有 toast、notice 或状态区域；主窗口同样没有展示降级提示。

因此失效 panelId 会静默降级到 Session，无法满足 DSC-005 明确要求的“显示 Panel 降级提示”。

修复方向：在主窗口已选中的目标 Session 表面展示可见且可访问的降级提示，或让 Companion 保存并渲染 result message；提示必须发生在成功结果语义内，不能影响 Completion 的合法精确确认。

### P2：Companion 全局 CSS 仍污染主窗口

`frontend/src/components/desktop-companion/desktop-companion.css:1-3` 仍使用全局 `:root` / `body` `!important` 规则；组件由 App 静态导入，主窗口 renderer 的背景与 overflow 仍会被覆盖。

### P2：Terminal event 即时刷新仍未实现

`frontend/src/features/attention/use-attention-snapshot.ts:24-44` 仍只有 4 秒轮询，没有计划在 `docs/plans/2026-07-18-desktop-slot-companion.md:283-287` 承诺的 Terminal events WebSocket invalidate。

## 已关闭的上一轮 P1

1. `slot_open_success_after_target_surface`：已修复。当前顺序为 route → 等待目标 Session → Panel → Agent Team → Completion ack → result；静态顺序 harness 通过。
2. `companion_route_before_renderer_bootstrap`：已修复。打包态直接加载 `runweave://app/desktop-companion`，resolver 返回 `index.html` 且 pathname 在 renderer bootstrap 前就是 `/desktop-companion`。

## 审查范围与证据

- `scope=full`
- `baseCommit=0a92b516f788dcc01d44faa78ff730ab77f56d05`
- `targetCommit=null`
- `targetTree=5081b444f76bf4a207ffd086a39f4276d2873cbe`
- `git write-tree` 精确等于 targetTree；25 个 staged 路径与 reviewTarget 完全一致。
- 计划与测试计划 SHA-256 均与 prompt 匹配。
- `git diff --cached --check`：通过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm testplan:validate docs/testing/platform/desktop-slot-companion.testplan.yaml`：通过，12 个 required cases。
- route resolver harness：`pathname=/desktop-companion` 且解析到 packaged `index.html`。
- open order harness：`navigate < wait < focus < sidecar < ack < report`。
- timeout harness：Session wait 预算 8000ms、main 总超时 10000ms、ack 前无 cancellation/deadline。
- fallback harness：result status 在 App 生成、Companion 仅用于 retirement，`result.message` 无 UI 消费者。

本轮为代码审查，未执行 macOS 真实桌面行为验收；以上 open P1 均由 staged source 的确定性控制流和静态合同确认。
