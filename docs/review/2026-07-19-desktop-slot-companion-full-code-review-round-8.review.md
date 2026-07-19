# Desktop Slot Companion 完整 staged diff 代码审查（Round 8）

## 结论

通过。未发现未修复的 P0/P1。

本轮新 checkpoint 同时更新了实施计划、原型说明与测试计划，明确把 Completion 定义为两阶段流程：`openSlot` 的有界成功终态只证明目标 Session/Panel/Agent Team 表面已打开；精确 `acknowledgedCompletionRevision` 是后续异步退役副作用，只有 snapshot 观察到已确认 revision 才移除提醒。确认失败或挂起时，既不改写已完成的导航结果，也不隐藏 Completion 提醒。

该合同与当前 Electron/renderer/Attention 投影一致，并新增了 acknowledgement 失败、挂起、目标表面超时和重复 requestId 的可验收步骤。因此 Round 7 的“ack 前返回 opened”不再构成产品合同违反；它不是忽略失败，因为新 testplan 明确保留并验证未确认提醒。

## 非阻断 Findings

### P2：Companion 全局 CSS 污染主窗口

`frontend/src/components/desktop-companion/desktop-companion.css:1-2` 使用全局 `:root` / `body` `!important` 规则；该 CSS 由主 App 静态导入，主窗口 renderer 也会覆盖背景与 overflow。建议把透明背景规则限定到 Companion 路由的 document class，或只在 Companion entry 加载专用样式。

### P2：Terminal event 即时刷新仍未实现

`frontend/src/features/attention/use-attention-snapshot.ts:24-44` 只有 4 秒轮询，没有计划仍承诺的 Terminal events WebSocket invalidate。结构化 Terminal 状态变化最多延迟约 4 秒；建议复用现有 Terminal event listener，仅触发 snapshot invalidate，不建立第二套状态源。

## 已关闭的 P1

1. `slot_open_success_after_target_surface`：更新后的冻结合同将 opened/fallback 明确定义为目标表面打开终态，acknowledgement 为异步退役副作用；失败/挂起时 snapshot 保留提醒，测试计划已覆盖。
2. `slot_open_timeout_cancels_late_ack`：authorization 在原 deadline 内形成唯一 openSlot 终态；目标表面超时不发起 ack，成功后 ack 挂起不阻塞 invoke 且不提前退役。
3. `companion_route_before_renderer_bootstrap`：打包态直接以 `/desktop-companion` pathname 加载 packaged index。
4. `panel_fallback_is_user_visible`：Panel fallback message 渲染为 Companion 的可见 `role="status"` 提示。

## 审查范围与证据

- `scope=full`
- `baseCommit=0a92b516f788dcc01d44faa78ff730ab77f56d05`
- `targetCommit=null`
- `targetTree=56821c375767993c67a54af8df2e031efd68c470`
- `git write-tree` 精确等于 targetTree；29 个 staged 路径与 reviewTarget 完全一致。
- 计划 SHA-256：`0658cc00e52cc12fc28f2c730d85cf7862ce82adf581aa393dace1f78b923901`。
- 测试计划 SHA-256：`462d344eeac6b79a3da817737a15ad40dd34b3f14eb46309e6a92231ad8989ab`。
- 两阶段 Completion review harness：计划、测试、Electron authorization、renderer async ack、错误终态所有权与 snapshot 退役条件六项合同全部成立；连续 3 次 `opened + acknowledged=false + slotVisible=true`，`passed=true`。
- `git diff --cached --check`：通过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm testplan:validate docs/testing/platform/desktop-slot-companion.testplan.yaml`：通过，12 个 required cases。

本轮是代码与验收合同审查，不是 macOS 真实桌面行为验收；运行态 DSC-001 至 DSC-012 仍应由后续 behavior verification 按更新后的 testplan 执行。
