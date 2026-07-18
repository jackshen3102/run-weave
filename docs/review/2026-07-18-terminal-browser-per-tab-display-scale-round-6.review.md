# Terminal Browser per-tab displayScale 第 6 轮代码审查

## 结论

AGT-REVIEW-GATE 通过。本轮针对 TBZ-004 的单文件修复重新独立审查，未发现 open P0/P1。50% displayScale 下 Playwright 鼠标坐标被 Chromium 再次按 scale 反向换算的问题，现由 scoped CDP 代理在发送 `Input.dispatchMouseEvent` 前按目标 Tab 的 `displayScale` 映射 `x/y`；调用方继续使用未缩放 CSS 坐标。

本轮 Code Agent 声明的唯一修改文件是 `electron/src/terminal-browser-cdp-proxy-session.ts`，当前 SHA-256 为 `68a144add11e9dddd60d77dd70334ae05f345eb0487eeb313a6c14bd8a23f939`。审查边界为该 TBZ-004 repair 增量及其直接调用链；工作区内并行存在的 Agent Team control-plane 改动不属于本 repair。

## 已关闭发现

- **P1 resolved — 50% displayScale 下鼠标 CSS 坐标被二次反向缩放。** 新 helper 只处理 `Input.dispatchMouseEvent`，将有限数值 `x/y` 乘以当前 target entry 的 `displayScale`；100% 保持原参数，mouseWheel 的 `deltaX/deltaY`、键盘和其它命令不改写。helper 位于 frame/context 参数重写之后、Electron debugger `sendCommand` 之前，entry 由当前 session 已绑定的 `targetId` 获取，因此 A/B Tab 使用各自状态。定位：`electron/src/terminal-browser-cdp-proxy-session.ts:50-66,223-305`；产品合同：`docs/testing/terminal/terminal-browser-display-scale.testplan.yaml:64-76`。

## 独立结构复核

- 通过 TypeScript AST 从当前源码提取并执行 `rewriteMouseCoordinatesForDisplayScale`：50% 将 `(162, 280.875)` 映射为 `(81, 140.4375)`；80% wheel 落点 `(200, 300)` 映射为 `(160, 240)`，同时 `deltaX=12`、`deltaY=180` 保持；200% 映射为 `(324, 561.75)`；100% 与键盘命令返回原对象；输入对象未被原地修改。
- `sendCommand` 先通过 session map 取得当前 target，再取该 target 的 entry；所有实际发送统一经过 `sendToElectron`，仅当 method 为 `Input.dispatchMouseEvent` 时应用当前 entry factor。不同 target 的 session 不共享 entry，不会把 A 的 50% 应用于 B 的 100%。
- displayScale setter、automation metrics 与 screenshot 分支仍沿用同一 sender；新 helper 对 `Emulation.*`、`Page.captureScreenshot` 等 method 不生效，因此未改变既有 metrics/screenshot 组合逻辑。

## 独立检查

- `node --no-warnings --input-type=module -e '<AST-extracted rewriteMouseCoordinatesForDisplayScale harness>'`：exit 0；覆盖 50%、80%、100%、200%、wheel delta、键盘命令、非有限单轴和原参数不可变性。
- `pnpm typecheck`：exit 0。
- `pnpm lint`：exit 0。
- `pnpm testplan:validate docs/testing/terminal/terminal-browser-display-scale.testplan.yaml`：exit 0，6 条 required case。
- `git diff --check`：exit 0。
- `pnpm architecture:check`：exit 1；唯一新增 ratchet 失败为本轮 repair 范围外的 `scripts/verify-agent-team-fixture-lifecycle.mjs` 达 625 行。当前 repair 文件为 532 行，Code Agent outbox 的 `changedFiles` 仅包含该 repair 文件，因此此项记录为 out-of-scope P2，不据此否定 TBZ-004 代码修复。

## 验证边界

本 reviewer 未启动 Dev Session，也未独立执行 Playwright/Electron 行为验收。Code Agent outbox 提供了同一 `scenarioId=TBZ-004-display-scale-50-pointer-intercept`、`validationSessionId=dvs-5a6790-r5` 的 Before/After 交接证据，但本轮只将其作为修复可复验性来源，不把 worker 自证提升为独立 behavior pass。TBZ-004 仍应由 backend 后续重新触发 `behavior_verify`；本结论只表示代码审查门禁无 open P0/P1。

## 非阻断发现

- **P2 out_of_scope — 全仓 architecture ratchet 被并行 Agent Team verifier 改动触发。** `scripts/verify-agent-team-fixture-lifecycle.mjs` 当前 625 行，导致 `pnpm architecture:check` exit 1。该文件不在本轮 Code Agent `changedFiles` 中，也不属于 Terminal Browser displayScale 产品 Case；应由对应 control-plane 工作流拆分或申请独立裁决，不在本 repair 中修改。
