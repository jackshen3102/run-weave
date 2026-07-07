# Terminal Browser Scoped CDP 代码评审

## 检查范围

- 当前工作区 live diff：
  - `electron/src/terminal-browser-cdp-proxy.ts`
  - `electron/src/terminal-browser-view.ts`
  - `electron/src/main.ts`
  - `frontend/src/components/terminal/terminal-browser-cdp-endpoint-popover.tsx`
  - `packages/shared/src/terminal-browser-cdp-proxy.ts`
  - `scripts/verify-terminal-browser-scoped-cdp.mjs`
  - `scripts/verify-terminal-browser-cdp-regression.mjs`
  - 相关架构/测试文档
  - 两个根目录 PNG 删除

## 结论

未发现 P0/P1 阻断问题。核心 scoped target 过滤、当前 active tab 排序、接口类型变更在静态审查和基础检查下成立。

但有 2 个 P2 需要处理：一个是新增验收脚本没有覆盖文档承诺的 Playwright 默认 page 路径；另一个是本次 CDP 改动夹带了与需求无关的 PNG 删除。

## 发现

- **P2 一般：R12/MR07 的脚本没有覆盖文档承诺的 Playwright 默认 page 行为。** `docs/testing/terminal-browser-cdp-mcp-test-cases.md:264` 和 `docs/testing/terminal-browser-playwright-mcp-test-cases.md:225` 的验收目标是两个客户端各自 `connectOverCDP(scoped endpoint)` 后直接用 `context.pages()[0].goto(...)` / `browser_navigate`，确认不会共同改写历史第一个 tab；但 `scripts/verify-terminal-browser-scoped-cdp.mjs:118` 到 `scripts/verify-terminal-browser-scoped-cdp.mjs:138` 只用 raw CDP `Target.attachToTarget` + `Page.navigate`，`scripts/verify-terminal-browser-cdp-regression.mjs:466` 到 `scripts/verify-terminal-browser-cdp-regression.mjs:493` 也是 raw CDP。这样脚本能证明 target filter 和 attach 隔离，不能证明 Playwright/MCP 的默认 page 选择真的命中 scoped tab。修复方向：增加一个真实 Playwright `chromium.connectOverCDP(scopedWsUrl)` 场景，直接读取 `browser.contexts()[0].pages()[0]` 并导航两个 scoped 连接；或者把文档表述降级为 raw CDP 协议级覆盖，另列 Playwright/MCP 手工验收。

- **P2 一般：本次 CDP scoped endpoint diff 夹带删除两个 App 截图证据文件。** `runweave-app-login-after-composer-change.png` 和 `runweave-app-mobile-terminal-open-check.png` 是已跟踪文件，本轮 diff 将它们删除；`rg` 未发现当前文档引用，但它们来自历史 App 终端/登录验证提交，和 Terminal Browser CDP scoped endpoint 没有直接需求来源。风险是 CDP PR 会携带无关资产删除，增加审查噪音并丢失历史验证材料。修复方向：从本轮 CDP 改动中恢复这两个 PNG；如果确实要清理，单独提交并说明清理依据。

## 已执行检查

- `git diff --check`：通过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `curl http://127.0.0.1:9224/json/version`：当前运行时返回 `Runweave/CDP-Proxy`。
- `curl 'http://127.0.0.1:9224/json/list?targetId=...'` 和 `curl 'http://127.0.0.1:9224/json/version?targetId=...'`：当前运行时返回 `Not Found`，说明桌面端 9224 尚未加载这份未提交 Electron diff，不能用当前运行时结果作为 scoped endpoint 验收结论。

## 未执行/残余风险

- 未执行 `scripts/verify-terminal-browser-scoped-cdp.mjs` / `scripts/verify-terminal-browser-cdp-regression.mjs`，原因是当前 live 9224 不是加载本 diff 的运行时；直接执行会产生旧运行时假阴性。
- 未执行 Playwright/MCP 真实 browser-level 验收；需要先重启/加载包含本 diff 的 Electron 桌面端，再跑脚本和新增的 Playwright 默认 page 场景。
