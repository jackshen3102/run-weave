# Terminal Browser per-tab displayScale 第 11 轮代码审查

## 结论

AGT-REVIEW-GATE 不通过。本轮独立复审确认 1 个 open P1：`Page.captureScreenshot` 在临时切换到逻辑 100% metrics 后，第一次 compositor paint wait 位于 `try/finally` 外；该 wait 一旦失败，原 displayScale 的恢复命令不会执行，实际页面 metrics 与主进程权威状态发生分叉。

本轮 Code Agent 的 happy path 修复方向成立：`Page.getLayoutMetrics` 与 `Page.captureScreenshot` 都进入 per-entry metrics queue，交接的 After PNG 显示 100%、80%、50%、reset 的 viewport/full-page 尺寸与 SHA-256 一致。但异常恢复仍违反冻结计划“截图失败也必须恢复”，因此不能通过代码门禁。

审查边界为本轮 `electron/src/terminal-browser-display-scale.ts` 与 `electron/src/terminal-browser-cdp-proxy-session.ts` 增量；当前 SHA-256 分别为 `42af99e4e66c9cf809e1c8dc075bc811c1df20b3581a07968a18bec90fa2f4cf`、`17b79909ade672512ccbafc66ab0d83720b552febd01e489ba6fcadc8fe10b95`。

## 阻断发现

- **P1 — 首次截图 paint wait 失败会永久跳过 displayScale 恢复。** `captureTerminalBrowserScreenshot` 先执行 `sendEffectiveDisplayMetrics(..., 1)`，随后在进入 `try/finally` 前调用 `waitForTerminalBrowserPaint`。独立 review harness 使用当前导出的真实函数，让首次 `Runtime.evaluate` 抛出 `Execution context was destroyed`：调用序列只有 `Emulation.setDeviceMetricsOverride(scale=1)`、`Runtime.evaluate`，没有 `scale=0.5` 恢复；与此同时 `entry.displayScale` 仍为 0.5。结果是菜单/状态继续报告 50%，实际 renderer metrics 已留在 100%，后续鼠标坐标补偿还会按 0.5 执行。定位：`electron/src/terminal-browser-display-scale.ts:289-311`；冻结规则：`docs/plans/2026-07-18-terminal-browser-per-tab-display-scale.md:120-128`；产品 Case：`docs/testing/terminal/terminal-browser-display-scale.testplan.yaml:80-92`。修复方向：把首次 paint wait 与 capture 一并放入 metrics 已切换后的 `try/finally` 保护区，确保任何 wait/capture 失败都尝试恢复 `entry.displayScale`；修复后原样重跑本 harness，并覆盖首次 wait 失败、capture 失败、成功三条命令序列。

## 已修复路径

- **P1 resolved — 80%/50% 截图内容与 100% 基准不一致。** Code Agent 的同场景 After 证据文件已存在；独立读取显示所有 viewport PNG 均为 1920×1080 且 SHA-256 为 `f25b0d14870f1ddcccf08ffeae1bcf21fd702f78a1a4988f8e4a2296d8cf9a74`，所有 full-page PNG 均为 1920×1251 且 SHA-256 为 `90de6a7948e8968883618099ccdfdc0acf692713708b2338565a50b7b7527f14`。该 happy path 关闭不消除上述异常恢复 P1。

## 独立复核

- `node --no-warnings --experimental-strip-types --input-type=module -e '<review-harness-tbz-005-screenshot-restore-on-initial-paint-failure>'`：exit 0，直接调用当前 `captureTerminalBrowserScreenshot` 与 `getTerminalBrowserAutomationLayoutMetrics`。
  - 成功截图：`set scale=1 → Runtime.evaluate → capture → set scale=0.5 → Runtime.evaluate`。
  - capture 失败：仍执行 `set scale=0.5 → Runtime.evaluate` 恢复。
  - 首次 paint wait 失败：只有 `set scale=1 → Runtime.evaluate(error)`，没有恢复；`entry.displayScale=0.5`。
  - layout metrics 失败：正确执行 `set scale=1 → getLayoutMetrics(error) → set scale=0.5` 恢复。
- `file` 与 `shasum -a 256 .runweave/evidence/9111bff6-9fbb-45e5-8d1e-ab14f2ce2295/after/tbz005-*.png`：确认 Code Agent happy path 的两组尺寸和哈希一致。
- `pnpm typecheck`：exit 0。
- `pnpm lint`：exit 0。
- `pnpm architecture:check`：exit 0，`over600=0`、`runtimeCycles=0`、`forbiddenImports=0`、`sharedRootImports=0`。
- `pnpm testplan:validate docs/testing/terminal/terminal-browser-display-scale.testplan.yaml`：exit 0，6 条 required case。
- `git diff --check`：exit 0。

## 验证边界

本 finding 是 structural/review_harness confirmed：它直接执行当前实现并观察真实 sender 命令序列，不把静态推断或环境阻塞提交为 open P1。本 reviewer 未启动 Dev Session，也未把 Code Agent 的 After 自证提升为独立 behavior pass；修复完成后仍需由 backend 重新触发 code_review，再由 behavior_verify 复验 TBZ-005。
