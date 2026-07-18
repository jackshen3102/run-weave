# Terminal Browser per-tab displayScale Round 13 代码评审

## 结论

通过。Round 11/12 阻断项 `terminal-browser.screenshot-failure-restores-display-scale` 已修复并由独立 review harness 确认关闭；本轮未发现仍然存在的 P0/P1。

## 审查范围

- Dispatch：`a99007dd-7d56-4970-99b6-59c8c83fc184`
- Code Agent handoff：`1a621310-7599-4fc4-b9db-b74350bf1a76`
- 本轮实现增量：`electron/src/terminal-browser-display-scale.ts`
- 当前文件 SHA-256：`71f5fd3bec99b20799976ccb9693d1e8689d6d5175cf8a6a9566d59f979cdcb1`
- 关联代理文件 SHA-256：`electron/src/terminal-browser-cdp-proxy-session.ts` = `17b79909ade672512ccbafc66ab0d83720b552febd01e489ba6fcadc8fe10b95`

## 已关闭的阻断项

### P1 · terminal-browser.screenshot-failure-restores-display-scale

此前 `captureScreenshotAtDefaultScale()` 在进入 `try/finally` 前等待首次 paint；若该等待因执行上下文销毁等原因失败，恢复 `entry.displayScale` 的逻辑不会执行。当前实现已将首次 `waitForTerminalBrowserPaint(sender)` 移入 `try`，因此成功、截图异常、首次 paint wait 异常及布局查询异常都会进入恢复路径。

独立 harness 直接导入当前实现，以 `entry.displayScale = 0.5` 验证：

- 成功：`scale=1 → paint → capture → scale=0.5 → paint`
- 截图失败：抛出 `capture failed` 前执行 `scale=0.5 → paint`
- 首次 paint wait 失败：抛出 `Execution context was destroyed` 前执行 `scale=0.5 → paint`，且 entry 仍为 `0.5`
- 恢复 paint wait 失败：恢复 metrics 命令 `scale=0.5` 已执行，随后传播 `restore paint failed`
- 布局查询失败：抛出 `layout failed` 前执行 `scale=0.5`

五条断言均通过，确认截图辅助流程不会因已覆盖的失败出口遗留临时默认缩放。

## 独立检查

- `pnpm typecheck`：通过
- `pnpm lint`：通过
- `pnpm architecture:check`：通过（`over600=0`、`runtimeCycles=0`、`typeOnlyCycles=0`、`forbiddenImports=0`、`sharedRootImports=0`）
- `pnpm testplan:validate docs/testing/terminal/terminal-browser-display-scale.testplan.yaml`：通过，共 6 条必需用例
- `git diff --check`：通过
- Code Agent 的 TBZ-005 After 证据尺寸与哈希稳定：viewport 为 `1920x1080` / `f25b0d14870f1ddcccf08ffeae1bcf21fd702f78a1a4988f8e4a2296d8cf9a74`，full 为 `1920x1251` / `90de6a7948e8968883618099ccdfdc0acf692713708b2338565a50b7b7527f14`

## 验证边界

本报告是只读代码评审，没有启动新的 Dev Session。TBZ-005 的真实产品行为仍由独立 `behavior_verify` worker 给出最终结论；这里的产品截图只作为修复 handoff 的交叉证据，不以代码评审替代行为验收。
