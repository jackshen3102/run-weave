# Desktop Slot Companion 完整 staged diff 代码审查（Round 7）

## 结论

未通过。完整 staged diff 仍存在 1 个未修复 P1：Completion authorization 现在直接把 `opened` 缓存并 resolve 给 Companion，renderer 随后才写 `acknowledgedCompletionRevision`；acknowledgement 失败或永久挂起时，调用方已经收到成功，错误又被 `completionOpenResolved` 分支静默丢弃。未发现 P0。

Round 5 的“authorization 后 open promise 永久 pending”已消除，但本轮实现重新违反冻结计划规定的 `acknowledgement → report result` 顺序。此前的 Companion 初始路由与 Panel fallback 可见提示 P1 继续保持关闭。另有 2 个非阻断 P2 仍存在。

## Findings

### P1：Completion acknowledgement 前已返回并缓存 opened 成功

冻结计划 `docs/plans/2026-07-18-desktop-slot-companion.md:404-424` 明确把“可选确认 completionRevision”放在“report/返回 opened”之前；这保证成功结果代表目标表面已打开且本次精确 revision 已确认。

当前 `frontend/src/App.tsx:439-454` 先把 `openedResult` 传给 `authorizeAttentionCompletion`，Electron `electron/src/main.ts:118-155` 立即通过 `completePendingRequest` 清除 timer、删除 pending、缓存 opened 并 resolve Companion invoke；renderer 在授权返回后才调用 acknowledgement PATCH。若 PATCH 失败，`frontend/src/App.tsx:456-463` 因 `completionOpenResolved=true` 直接丢弃错误，不再返回失败。

受控 review harness 读取当前源码顺序，并让 acknowledgement 失败；连续 3 次均得到 `openResult=opened`、`acknowledged=false`、`failureReported=false`。这违反 DSC-005 的“随后精确 revision 被确认，提醒退役”，也使 DSC-011 的 open result/timeout 去重缓存代表一个尚未完成的工作流。

修复方向：不要把“允许开始 ack”伪装成最终 opened。成功终态必须位于 acknowledgement 成功之后；若仍需严格 10 秒边界，应把 deadline/requestId 带到 Backend 的原子 acknowledgement 提交边界，而不是在提交前缓存成功。

### P2：Companion 全局 CSS 仍污染主窗口

`frontend/src/components/desktop-companion/desktop-companion.css:1-2` 仍使用全局 `:root` / `body` `!important` 规则；该 CSS 由主 App 静态导入，主窗口 renderer 同样会覆盖背景与 overflow。

### P2：Terminal event 即时刷新仍未实现

`frontend/src/features/attention/use-attention-snapshot.ts:24-44` 仍只有 4 秒轮询，没有计划承诺的 Terminal events WebSocket invalidate，结构化状态变化最多延迟约 4 秒。

## 已关闭的 P1

1. `slot_open_timeout_cancels_late_ack`：authorization 后不再留下永久 pending open promise；但本轮以提前提交 opened 引入了上述独立成功顺序缺陷。
2. `companion_route_before_renderer_bootstrap`：打包态直接以 `/desktop-companion` pathname 加载 packaged index。
3. `panel_fallback_is_user_visible`：Panel fallback message 渲染为 Companion 的可见 `role="status"` 提示。

## 审查范围与证据

- `scope=full`
- `baseCommit=0a92b516f788dcc01d44faa78ff730ab77f56d05`
- `targetCommit=null`
- `targetTree=23ac1525f15aafa42b3ec53d758522c5f0f31c5d`
- `git write-tree` 精确等于 targetTree；26 个 staged 路径与 reviewTarget 完全一致。
- 计划与测试计划 SHA-256 均与 prompt 匹配。
- `git diff --cached --check`：通过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm testplan:validate docs/testing/platform/desktop-slot-companion.testplan.yaml`：通过，12 个 required cases。
- completion result-before-ack review harness：连续 3 次 `opened + acknowledged=false + failureReported=false`，`reproduced=true`。

本轮为代码审查，未执行 macOS 真实桌面行为验收；阻断项由受控 review harness、冻结计划与 staged source 的确定性顺序共同确认。
