# Terminal Browser per-tab displayScale 第 4 轮代码审查

## 结论

AGT-REVIEW-GATE 通过。本轮基于当前 dispatch、刷新后的实施计划与测试计划重新审查，未发现 open P0/P1。Round 1 的 `terminal-browser.display-scale-last-success-wins` P1 在本轮重新执行同一结构化 harness 后仍保持关闭。

本轮 code worker 因原 `dvs-a14110` 已停止且 code role 无权创建 Agent Team fixture 而未修改源码；这份失败 outbox 只说明旧运行时场景无法由该 worker 合法重放，不构成当前源码缺陷的复现。随后验收合同已刷新：不再承诺 `browserContext.newCDPSession(page)` 产生的 nested target session，而是明确要求独立 scoped raw CDP root connection 通过 root `Target.attachToTarget` 取得每个 target 唯一的 primary session。

审查边界为 `HEAD 11677eb` 加当前 Terminal Browser displayScale 工作区 patch。当前计划 SHA-256 为 `1aca775e8508009a685584595c401fac2a37c44d90e17c8e2ec31adff2d9f42e`，测试计划 SHA-256 为 `1511c61d4e6b2edc46d708e52233cfac1559446dd2f6f52cf153a34d59854ff0`。工作区内 Agent Team control-plane 等无关改动不属于本审查范围，未修改、未恢复，也未据此扩大结论。

## 当前合同与实现核对

- 刷新后的计划明确把 root `Target.attachToTarget(targetId)` 作为 Agent displayScale 唯一支持入口，同一连接内重复 attach 必须返回同一个 primary session；不增加 browser-session 内 nested `Target.attachToTarget`。定位：`docs/plans/2026-07-18-terminal-browser-per-tab-display-scale.md:10-16,18-31,38-46,84-102`。
- root attach 先要求 `targetId`，再按当前 connection 的 `scopedGroupId` 选择 target；跨 group target 无法附着。选中后交给 connection-local `CdpSessionManager.attachDebugger`。定位：`electron/src/terminal-browser-cdp-proxy-messages.ts:180-223`。
- `CdpSessionManager` 对同一 target 的重复 attach 直接返回既有 `proxySessionId`；A、B target 分别保有不同映射，detach/connection cleanup 会释放该 connection 的 attachment。定位：`electron/src/terminal-browser-cdp-proxy-session.ts:124-203,277-293`。
- `Runweave.getDisplayScale`、`setDisplayScale`、`resetDisplayScale` 只根据请求 `sessionId` 反查 target，并再次检查 scoped group。get/reset 禁止任何参数；set 只接受单一合法 `factor`，因此额外 `targetId`、85%、未知/跨组 session 都不能修改页面。定位：`electron/src/terminal-browser-cdp-proxy-session-messages.ts:181-260`。
- root 缺少 target session 会返回 `requires a sessionId`；browser-level session 调用 displayScale 会返回 `requires a target sessionId`。这与 TBZ-002 的负向合同一致。定位：`electron/src/terminal-browser-cdp-proxy-messages.ts:370-389`、`electron/src/terminal-browser-cdp-proxy-session-messages.ts:29-126`。

## 已关闭发现复核

- **P1 resolved — 后发成功 reset 会被先发缩放请求覆盖。** 本轮重新运行同一真实 setter harness：先发 set(80%) 停在 debugger sender 时，后发 reset(100%) 在 50ms 观察窗内保持 pending；释放首请求后按 `setDeviceMetricsOverride(scale=0.8)`、`clearDeviceMetricsOverride` 顺序执行，返回值依次为 0.8、1，最终 `entry.displayScale=1`。相邻回归同时确认同值无在途请求不发 debugger 命令、85% 被拒绝、普通顺序 set/reset 最终为 1。当前修复文件 SHA-256 仍为 `085dc0ba65479b69fc91b530328e3d62174dcdf340be8fb6140736585de22f81`。

## 独立检查

- `node --no-warnings --experimental-strip-types --input-type=module -e '<review-harness-tbz-002-display-scale-last-success-wins-round-4>'`：exit 0；`resetSettledBeforeRelease=false`、`firstResult.factor=0.8`、`resetResult.factor=1`、`finalFactor=1`，命令顺序为 set 0.8 后 clear。
- `node --no-warnings --experimental-strip-types --input-type=module -e '<displayScale-adjacent-regression-round-4>'`：exit 0；同值无命令，0.85 抛出 `Invalid terminal browser display scale`，顺序 set/reset 最终为 1。
- `pnpm typecheck`：exit 0。
- `pnpm lint`：exit 0。
- `pnpm architecture:check`：exit 0，`over600=0`、`runtimeCycles=0`、`forbiddenImports=0`、`sharedRootImports=0`。
- `pnpm testplan:validate docs/testing/terminal/terminal-browser-display-scale.testplan.yaml`：exit 0，6 条 required case。
- `git diff --check`：exit 0。

## 验证边界

本 reviewer 未启动 Dev Session，也未执行 Playwright/Electron 真实产品验收：当前分配 Case 只有 `AGT-REVIEW-GATE`，TBZ-001～TBZ-006 在刷新后仍为 pending，应由后续 `behavior_verify` 使用当前 raw-root 合同独立执行。因此本轮结论只表示代码审查门禁无 open P0/P1，不把历史 behavior evidence、静态检查或 code worker 的环境阻塞提升为当前行为通过。
