# Desktop Slot Companion 最终代码审查（Round 10）

## 结论

通过。最终 base→target 完整 diff 未发现未修复的 P0/P1。

`targetCommit=fe516828f10022490ac18221c9515f7d239c5dd3` 的 tree 精确为 `56821c375767993c67a54af8df2e031efd68c470`，与 Round 8 已审通过的产品树完全相同。29 个 changedPaths、计划 SHA 与测试计划 SHA 均和本次 final reviewTarget 一致。

Completion 两阶段合同在最终提交中保持闭合：`openSlot` 只表示目标 Session/Panel/Agent Team 表面在 deadline 内成功打开；精确 revision acknowledgement 是后续异步退役副作用。确认失败或挂起不会改写已完成的导航结果，也不会在 snapshot 未确认 revision 时隐藏提醒。目标表面在成功报告前超时则不发起 acknowledgement，重复 requestId 只形成一个打开终态和至多一次确认副作用。

## 非阻断 Findings

### P2：Companion 全局 CSS 污染主窗口

`frontend/src/components/desktop-companion/desktop-companion.css:1-2` 使用全局 `:root` / `body` `!important` 规则；该 CSS 由主 App 静态导入，主窗口 renderer 也会覆盖背景与 overflow。建议后续把透明背景规则限定到 Companion 路由 document class。

### P2：Terminal event 即时刷新仍未实现

`frontend/src/features/attention/use-attention-snapshot.ts:24-44` 只有 4 秒轮询，没有计划承诺的 Terminal events WebSocket invalidate；结构化 Terminal 状态变化最多延迟约 4 秒。建议后续复用现有 Terminal event listener 触发 snapshot invalidate。

## 已关闭的 P1

1. `slot_open_success_after_target_surface`：更新后的合同明确 opened/fallback 只代表目标表面打开；ack 是异步退役副作用，失败/挂起时提醒保留。
2. `slot_open_timeout_cancels_late_ack`：authorization 在 deadline 内形成唯一 openSlot 终态；目标表面超时不发起 ack，成功后 ack 挂起不阻塞 invoke。
3. `companion_route_before_renderer_bootstrap`：打包态直接以 `/desktop-companion` pathname 加载 packaged index。
4. `panel_fallback_is_user_visible`：Panel fallback message 渲染为 Companion 的可见 `role="status"` 提示。

## 最终范围与证据

- `scope=final`
- `baseCommit=0a92b516f788dcc01d44faa78ff730ab77f56d05`
- `targetCommit=fe516828f10022490ac18221c9515f7d239c5dd3`
- `targetTree=56821c375767993c67a54af8df2e031efd68c470`
- base→target 的 29 个路径与 reviewTarget 完全一致，`git diff --check` 通过。
- target commit 内计划 SHA-256：`0658cc00e52cc12fc28f2c730d85cf7862ce82adf581aa393dace1f78b923901`。
- target commit 内测试计划 SHA-256：`462d344eeac6b79a3da817737a15ad40dd34b3f14eb46309e6a92231ad8989ab`。
- 最终两阶段 Completion contract harness：六项合同全部成立，`passed=true`。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm testplan:validate docs/testing/platform/desktop-slot-companion.testplan.yaml`：通过，12 个 required cases。
- 工作树另有 `scripts/dev-session/agent-team-fixture-cleanup.mjs` 未提交改动，不属于 target commit 或 reviewTarget，本次未修改、未纳入结论。

本轮是最终代码审查，不替代 DSC-001 至 DSC-012 的 macOS 真实桌面 behavior verification。
