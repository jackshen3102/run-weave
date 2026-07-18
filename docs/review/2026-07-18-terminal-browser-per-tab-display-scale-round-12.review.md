# Terminal Browser per-tab displayScale 第 12 轮代码审查

## 结论

AGT-REVIEW-GATE 不通过。同一 open P1 `terminal-browser.screenshot-failure-restores-display-scale` 在当前 dispatch 下仍可由真实实现 harness 稳定确认；本轮没有新的 Code Agent 修复交接。

现场事实：当前 code pane outbox 仍是 dispatch `9111bff6-9fbb-45e5-8d1e-ab14f2ce2295`，只包含 `behavior_verify:TBZ-005` 的旧修复交接；run 日志显示 Round 12 来自 Agent intervention 直接重派 `code_review`。`electron/src/terminal-browser-display-scale.ts` 与 `electron/src/terminal-browser-cdp-proxy-session.ts` SHA-256 仍分别为 `42af99e4e66c9cf809e1c8dc075bc811c1df20b3581a07968a18bec90fa2f4cf`、`17b79909ade672512ccbafc66ab0d83720b552febd01e489ba6fcadc8fe10b95`，与 Round 11 finding 时一致。

## 阻断发现

- **P1 — 首次截图 paint wait 失败仍会跳过 displayScale 恢复。** 当前 `captureTerminalBrowserScreenshot` 仍先切到逻辑 100% metrics，再在进入 `try/finally` 前执行首次 `waitForTerminalBrowserPaint`。本轮重新调用当前导出函数并让首次 `Runtime.evaluate` 抛出 `Execution context was destroyed`，得到 `set scale=1 → Runtime.evaluate(error)`，`restored=false`，没有任何 `scale=0.5` 恢复命令；`entry.displayScale` 仍为 0.5。定位：`electron/src/terminal-browser-display-scale.ts:289-311`；冻结规则：`docs/plans/2026-07-18-terminal-browser-per-tab-display-scale.md:120-128`；产品 Case：`docs/testing/terminal/terminal-browser-display-scale.testplan.yaml:80-92`。修复方向不变：把首次 paint wait 与 capture 一并纳入 metrics 已切换后的 `try/finally`，并以同一 harness 证明成功、capture 失败、首次 wait 失败三条路径都恢复原 factor。

## 独立检查

- `node --no-warnings --experimental-strip-types --input-type=module -e '<review-harness-tbz-005-initial-paint-failure-restoration>'`：exit 0；`error=Execution context was destroyed`、`entryDisplayScale=0.5`、`calls=[set scale=1, Runtime.evaluate]`、`restored=false`。
- code pane outbox 核对：仍为 `dispatchId=9111bff6-9fbb-45e5-8d1e-ab14f2ce2295`，没有 `code_review:terminal-browser.screenshot-failure-restores-display-scale` 的 fixVerification。
- `pnpm typecheck`：exit 0。
- `pnpm lint`：exit 0。
- `pnpm architecture:check`：exit 0，`over600=0`、`runtimeCycles=0`、`forbiddenImports=0`、`sharedRootImports=0`。
- `pnpm testplan:validate docs/testing/terminal/terminal-browser-display-scale.testplan.yaml`：exit 0，6 条 required case。
- `git diff --check`：exit 0。

## 验证边界

本 finding 继续使用同一 stable invariant 与 review harness；本轮结论来自当前源码的重新执行，不是复用旧 outbox verdict。由于没有修复增量，不能把静态门禁通过或旧 TBZ-005 happy-path PNG 证据提升为 review pass。Reviewer 未修改实现代码，也未启动 Dev Session。
