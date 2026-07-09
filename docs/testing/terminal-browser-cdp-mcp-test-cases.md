# Terminal Browser CDP/MCP 测试用例

本文档用于手工验证 Runweave Terminal Browser 暴露给 Playwright MCP / Playwright CLI 的 CDP Proxy 能力。

## 适用范围

- Runweave Electron 客户端中的 Terminal Browser。
- CDP Proxy endpoint，例如全局 HTTP endpoint `http://127.0.0.1:9224`，或当前 tab 所属 Agent Control Group 的 scoped WebSocket endpoint `ws://127.0.0.1:9224/devtools/browser/runweave-terminal-browser?groupId=...`。
- 通过 Playwright MCP 或 `chromium.connectOverCDP(...)` 连接上述 endpoint 的自动化客户端。

## 前置条件

1. 启动 Electron 客户端。
2. 打开 Terminal 侧边栏的 Browser 面板。
3. 点击 CDP/AI endpoint 按钮，复制当前 tab 的 endpoint，后文统一记为 `<cdp>`。若需要验证全局 endpoint，把 `<cdp>` 替换成 `http://127.0.0.1:<port>`。
4. Browser 面板保持可见，先完成普通截图验证；隐藏或 0 宽高状态下的截图也应可用，见 P10。
5. 记录执行前的 Runweave 主窗口状态、Browser tab 数量和登录状态，安全用例执行后需要确认这些状态没有被破坏。

## 推荐真实 URL

| 用途             | URL                              | 预期                              |
| ---------------- | -------------------------------- | --------------------------------- |
| HTTPS 导航与标题 | `https://www.baidu.com`          | 页面标题包含 `百度一下，你就知道` |
| HTTP 导航        | `http://example.com`             | 页面标题包含 `Example Domain`     |
| 表单/请求页面    | `https://httpbin.org/forms/post` | 表单页面可输入、提交              |
| 长文本/滚动页面  | `https://httpbin.org/html`       | 页面稳定，适合滚动测试            |
| 静态内容         | `https://example.com`            | 页面稳定，适合截图                |

## 快速 Playwright 验证脚本

在 repo 根目录执行。把 `<cdp>` 替换成实际 endpoint。

```bash
pnpm --filter ./frontend exec node --input-type=module <<'NODE'
import { chromium } from "@playwright/test";

const endpoint = "<cdp>";
const browser = await chromium.connectOverCDP(endpoint);
const context = browser.contexts()[0] ?? await browser.newContext();
const page = context.pages()[0] ?? await context.newPage();

await page.goto("https://www.baidu.com", { waitUntil: "domcontentloaded" });
console.log({
  url: page.url(),
  title: await page.title(),
});

await browser.close();
NODE
```

预期：

- 连接成功。
- 不出现 `Target.getTargetInfo requires a sessionId`。
- 输出 URL 为百度页面 URL。
- title 包含 `百度一下，你就知道`。
- Runweave Browser 面板地址栏最终同步为百度 URL。

## 原始 CDP 命令助手

部分安全用例需要直接发送 CDP 命令。可以使用以下 helper，每次替换 `endpoint` 和 `messages`。

```bash
pnpm --filter ./electron exec node --input-type=module <<'NODE'
import WebSocket from "ws";

const endpoint = "<cdp>";
const version = await fetch(`${endpoint}/json/version`).then((res) => res.json());
const ws = new WebSocket(version.webSocketDebuggerUrl);

const messages = [
  { id: 1, method: "Browser.getVersion" },
];

ws.on("open", () => {
  for (const message of messages) {
    ws.send(JSON.stringify(message));
  }
});

ws.on("message", (raw) => {
  console.log(String(raw));
});

setTimeout(() => ws.close(), 2000);
NODE
```

## 基础连接

| ID  | 用例                | 操作                                      | 预期                                                |
| --- | ------------------- | ----------------------------------------- | --------------------------------------------------- |
| C01 | `/json/version`     | 浏览器打开 `<cdp>/json/version`           | 返回 `Runweave/CDP-Proxy` 和 `webSocketDebuggerUrl` |
| C02 | `/json/protocol`    | 浏览器打开 `<cdp>/json/protocol`          | 返回 protocol version `1.3`                         |
| C03 | Playwright MCP 连接 | MCP 使用 `<cdp>` 作为 CDP endpoint        | 连接成功                                            |
| C04 | Playwright CLI 连接 | 运行快速 Playwright 验证脚本              | 能打开百度，title 正确                              |
| C05 | 错误 WS path        | 连接非 `/devtools/browser/...` 的 WS path | 连接被拒绝或断开                                    |
| C06 | 重复连接            | 连续连接、关闭、再连接 3 次               | 每次都成功，无旧连接污染                            |

## Browser / Target 能力

| ID  | 用例                                 | 操作                                                                                                | 预期                                                                        |
| --- | ------------------------------------ | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| T01 | `Browser.getVersion`                 | 发送 `Browser.getVersion`                                                                           | 返回 `Runweave/CDP-Proxy`                                                   |
| T02 | `Target.getTargets`                  | 发送 `Target.getTargets`                                                                            | 只返回 Terminal Browser tab，不暴露 Runweave 主窗口                         |
| T03 | `Target.getTargetInfo` 无 targetId   | 发送 `Target.getTargetInfo`                                                                         | 返回当前或首个 Terminal Browser target                                      |
| T04 | `Target.getTargetInfo` 合法 targetId | 先 `Target.getTargets`，再指定其中一个 targetId                                                     | 返回对应 target                                                             |
| T05 | `Target.getTargetInfo` 非法 targetId | 指定 `targetId: "not-exist"`                                                                        | 返回 CDP error，不崩溃                                                      |
| T06 | discovery                            | 发送 `Target.setDiscoverTargets { "discover": true }`                                               | 推送已有 Terminal Browser 的 `Target.targetCreated`                         |
| T07 | auto attach                          | 发送 `Target.setAutoAttach { "autoAttach": true, "waitForDebuggerOnStart": true, "flatten": true }` | 推送 `Target.attachedToTarget`，sessionId 是 proxy 生成的外侧 sessionId     |
| T08 | 等待调试器恢复                       | 对 attached session 发送 `Runtime.runIfWaitingForDebugger`                                          | 返回结果，不悬挂                                                            |
| T09 | 手动 attach                          | 对合法 target 发送 `Target.attachToTarget`                                                          | 返回可用 sessionId                                                          |
| T10 | 激活 target                          | 发送 `Target.activateTarget`                                                                        | Runweave UI 切换到对应 Browser tab                                          |
| T11 | 创建 about:blank tab                 | 发送 `Target.createTarget { "url": "about:blank" }`                                                 | 新 tab 出现，地址栏为 `about:blank`，没有 `Enter a valid http or https URL` |
| T12 | 创建百度 tab                         | 发送 `Target.createTarget { "url": "https://www.baidu.com" }`                                       | 新 tab 出现并加载百度，地址栏最终同步为百度 URL                             |
| T13 | 创建 HTTP tab                        | 发送 `Target.createTarget { "url": "http://example.com" }`                                          | 新 tab 加载 Example Domain                                                  |
| T14 | AI tab 上限                          | 连续创建 10 个 AI tab 后再创建第 11 个                                                              | 第 11 个返回 `Maximum AI tab limit`                                         |
| T15 | 关闭 target                          | 发送 `Target.closeTarget`                                                                           | UI tab 关闭，并推送 `Target.targetDestroyed` / `Target.detachedFromTarget`  |
| T16 | 关闭非法 target                      | 发送 `Target.closeTarget { "targetId": "not-exist" }`                                               | 不关闭主窗口，不影响其他 tab                                                |
| T17 | group scoped endpoint 隔离           | 手动新建 tab A、tab B，分别复制两个 group scoped endpoint；对 A 连接发送 `Target.getTargets`        | 只返回 group A 的 target，不返回 group B                                    |
| T18 | 全局 endpoint 当前 tab 优先          | UI 选中 tab B 后连接全局 HTTP endpoint 并读取 `context.pages()[0]`                                  | 默认 page 对应 tab B，不再固定落到历史第一个 tab                            |
| T19 | group 派生 tab 继承                  | 使用 tab A 的 group scoped endpoint 发送 `Target.createTarget`                                      | 新 tab 属于 group A；同一连接 `Target.getTargets` 同时返回 tab A 和新 tab   |

## 页面能力

| ID  | 用例                 | 操作                                                                      | 预期                                                        |
| --- | -------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------- |
| P01 | 百度导航             | `page.goto("https://www.baidu.com")`                                      | 页面加载成功，title 包含 `百度一下，你就知道`               |
| P02 | HTTPS 静态站点       | `page.goto("https://example.com")`                                        | title 为 `Example Domain`                                   |
| P03 | HTTP 页面            | `page.goto("http://example.com")`                                         | 页面加载成功，title 包含 `Example Domain`                   |
| P04 | reload               | 百度加载后执行 `page.reload()`                                            | 地址栏仍为百度 URL，页面可用                                |
| P05 | history back/forward | 依次打开百度、example.com，然后 back/forward                              | 页面和地址栏同步变化                                        |
| P06 | hash navigation      | 在 example.com 执行 `page.goto("https://example.com/#section-a")`         | 地址栏包含 `#section-a`                                     |
| P07 | 安全 setContent      | `page.setContent("<h1>Runweave MCP Test</h1>")`                           | 页面显示文本                                                |
| P08 | 危险 setContent      | 发送含 `<a href="javascript:alert(1)">x</a>` 的 `Page.setDocumentContent` | 被拒绝                                                      |
| P09 | 截图                 | 在 `https://example.com` 执行 `page.screenshot()`                         | 截图成功且不是 0 宽高                                       |
| P10 | 隐藏/0 宽高截图      | 隐藏 Browser 面板或缩到 0 宽高后截图                                      | 截图仍成功且不是 0 宽高；若失败，应记录为截图能力缺陷       |
| P11 | frame tree           | 发送 `Page.getFrameTree`                                                  | 返回 frameTree，后续 frameId 相关命令不报 target/frame 错配 |
| P12 | title update         | 导航到百度后观察 Runweave tab 标题                                        | tab 标题最终同步为百度标题或百度 URL                        |

## 输入与交互

| ID  | 用例               | 操作                                                                               | 预期                                                          |
| --- | ------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| I01 | 表单文本输入       | 打开 `https://httpbin.org/forms/post`，向 `input[name="custname"]` 输入 `Runweave` | 输入框出现 `Runweave`                                         |
| I02 | 表单提交点击       | 在 `https://httpbin.org/forms/post` 点击 `Submit order` 按钮                       | 跳转到 `https://httpbin.org/post`，返回内容包含提交的表单数据 |
| I03 | textarea 键盘输入  | 打开 `https://httpbin.org/forms/post`，向 `textarea[name="comments"]` 输入文本     | 文本出现在 textarea 中                                        |
| I04 | 鼠标点击链接       | 打开 `https://example.com`，点击 `Learn more`                                      | 页面跳转到 IANA 相关页面或新 URL                              |
| I05 | 滚动               | 打开 `https://httpbin.org/html` 后滚动                                             | 页面滚动                                                      |
| I06 | 选择文本           | 在 example.com 选择页面文本                                                        | 页面响应，不影响 Runweave 外层 UI                             |
| I07 | `Input.insertText` | 对输入框发送 `Input.insertText`                                                    | 文本插入成功                                                  |
| I08 | 普通 `q` / `w`     | 对页面发送普通按键                                                                 | 允许，不关闭窗口                                              |
| I09 | `Meta+Q`           | 发送 `Input.dispatchKeyEvent`，`key: "q"`，`modifiers: 4`                          | 被拒绝，Electron 不退出                                       |
| I10 | `Meta+W`           | 发送 `Input.dispatchKeyEvent`，`key: "w"`，`modifiers: 4`                          | 被拒绝，Runweave 窗口不关闭                                   |
| I11 | Runtime evaluate   | `page.evaluate(() => document.title)`                                              | 返回当前页面标题                                              |
| I12 | console 事件       | 页面内执行 `console.log("runweave-mcp-test")`                                      | MCP/Playwright 能收到 console 事件                            |

## 安全拦截

S05-S08 属于高风险安全命令。如果代理没有正确拦截，可能改变浏览器安全行为或删除本地浏览数据。默认不要在真实用户 profile 上直接执行这些命令；优先做代码审查和一次性 Electron profile 下的端到端发送命令验证。

| ID  | 用例                            | 操作                                                                                            | 预期                                                 |
| --- | ------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| S01 | 阻止关闭浏览器                  | 发送 `Browser.close`                                                                            | 返回 `Browser.close is blocked by CDP proxy`         |
| S02 | 阻止崩溃                        | 发送 `Browser.crash`                                                                            | 被拦截                                               |
| S03 | 阻止 remote locations           | 发送 `Target.setRemoteLocations`                                                                | 被拦截                                               |
| S04 | 阻止进程枚举                    | 发送 `SystemInfo.getProcessInfo`                                                                | 被拦截                                               |
| S05 | 阻止忽略 HTTPS 错误             | 默认查 `isBlockedCommand("Security.setIgnoreCertificateErrors")`；端到端只在一次性 profile 发送 | 被拦截；真实 profile 不应执行                        |
| S06 | 阻止清 Cookie                   | 默认查 `isBlockedCommand("Network.clearBrowserCookies")`；端到端只在一次性 profile 发送         | 被拦截；真实 profile 不应执行                        |
| S07 | 阻止清缓存                      | 默认查 `isBlockedCommand("Network.clearBrowserCache")`；端到端只在一次性 profile 发送           | 被拦截；真实 profile 不应执行                        |
| S08 | 阻止清 origin 存储              | 默认查 `isBlockedCommand("Storage.clearDataForOrigin")`；端到端只在一次性 profile 发送          | 被拦截；真实 profile 不应执行                        |
| S09 | 阻止 file 导航                  | `page.goto("file:///etc/passwd")`                                                               | 被拒绝                                               |
| S10 | 阻止 chrome 导航                | `page.goto("chrome://settings")`                                                                | 被拒绝                                               |
| S11 | 阻止 devtools 导航              | `page.goto("devtools://devtools/bundled/inspector.html")`                                       | 被拒绝                                               |
| S12 | 阻止 javascript URL             | `page.goto("javascript:alert(1)")`                                                              | 被拒绝                                               |
| S13 | session-level Target 命令不透传 | attached session 内发送 `Target.createTarget` / `Target.closeTarget`                            | 返回受控 no-op 或错误，不创建 Electron BrowserWindow |
| S14 | 非法 sessionId                  | 用不存在的 sessionId 发送 `Page.navigate`                                                       | 返回 `Unknown session`，代理不崩溃                   |
| S15 | 非法 JSON                       | WS 发送非 JSON 文本                                                                             | 忽略或断开，代理不崩溃                               |
| S16 | 缺失 id/method                  | WS 发送 `{ "method": "Browser.getVersion" }` 或 `{ "id": 1 }`                                   | 忽略，代理不崩溃                                     |

## UI 同步与 DevTools 互斥

| ID  | 用例                         | 操作                                                     | 预期                                           |
| --- | ---------------------------- | -------------------------------------------------------- | ---------------------------------------------- |
| U01 | MCP 创建 tab 同步            | `Target.createTarget { "url": "https://www.baidu.com" }` | 前端 tab bar 出现新 tab 并激活                 |
| U02 | MCP 导航地址栏同步           | `page.goto("https://www.baidu.com")`                     | 地址栏最终显示百度 URL，不停留在 `about:blank` |
| U03 | MCP 导航标题同步             | 百度加载完成后观察 tab 标题                              | tab 标题为百度标题或合理 fallback              |
| U04 | about:blank 不报错           | `Target.createTarget { "url": "about:blank" }`           | 不出现 `Enter a valid http or https URL`       |
| U05 | UI 关闭 MCP tab              | 在 Runweave UI 点击关闭 tab                              | MCP 收到 target detach/destroy 事件            |
| U06 | MCP attached 时打开 DevTools | CDP attached 后点击 DevTools 按钮                        | 按钮禁用或主进程拒绝，错误明确                 |
| U07 | DevTools 已打开时 MCP attach | 先打开 DevTools，再用 MCP attach                         | attach 失败，错误包含 DevTools 已打开          |
| U08 | MCP 断开后 DevTools          | 关闭 MCP 连接后点击 DevTools                             | DevTools 可打开                                |
| U09 | endpoint popover 状态        | 打开 CDP endpoint popover                                | endpoint 正确，attached/devtools 状态能刷新    |
| U10 | 复制 endpoint                | 点击复制按钮                                             | 剪贴板内容等于当前 CDP endpoint                |
| U11 | MCP attached 时切设备        | CDP attached 后在 Device 面板选择 iPhone/Pixel 预设      | 设备模式切换成功，MCP 连接保持可用             |

## MCP Tab 操作指示器

本组专门覆盖 Browser tab 上的 `MCP` 可视标志。`cdpProxyAttached` 只表示 CDP debugger 已 attach，不等于 MCP 正在操作，也不等于该 tab 由 MCP 创建。Tab bar 只能在真实 MCP/CDP session command 命中对应 target 后短暂显示 `MCP` 标志和高亮。

| ID   | 用例                          | 操作                                                                                                                                 | 预期                                                                                |
| ---- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| MI01 | 已有 tab 被 auto-attach       | 先在 Browser 面板打开一个普通 tab，例如 GitHub PR 页面；再让 MCP/CDP 客户端连接并 auto-attach                                        | 该已有 tab 不显示常驻 `MCP` badge；只保持普通选中态或普通 tab 样式                  |
| MI02 | 复现截图回归                  | 在已有 GitHub PR tab 处于 `cdpProxyAttached=true` 但未执行页面命令时观察 tab bar                                                     | tab 文案类似 `Pull requests · ...`，右侧不出现 `MCP` 标志                           |
| MI03 | 真实 MCP 操作短暂高亮         | 对某个 attached tab 执行 `page.goto` / `page.click` / 输入等会改变页面或明确操作页面的 session command                               | 只有该 target 对应的 tab 显示绿色高亮和 `MCP` badge                                 |
| MI04 | MCP 操作过期恢复              | MI03 后等待高亮窗口过期                                                                                                              | `MCP` badge 自动消失，tab 恢复普通样式                                              |
| MI05 | 初始化/读取命令不触发操作标志 | 只执行 `Page.enable` / `Runtime.enable` / `Target.setAutoAttach` / `Target.getTargetInfo` / `Page.getFrameTree` / `Runtime.evaluate` | 不显示 `MCP` badge；这些命令只算连接、初始化或读取上下文，不算用户可感知的软件操作  |
| MI06 | 多 tab 精确归属               | 两个 tab 同时 attached；只对第二个 tab 执行 `page.click` 或 `page.goto`                                                              | 只有第二个 tab 显示 `MCP` badge；第一个 attached-only tab 不显示                    |
| MI07 | MCP 创建新 tab                | MCP 调用 `Target.createTarget` 或 `context.newPage()` 创建新 tab，然后执行一次导航                                                   | 新 tab 出现；只有执行真实操作期间短暂显示 `MCP` badge，不因“由 MCP 创建”而永久显示  |
| MI08 | UI 选择态不被操作态覆盖       | 用户当前选中 tab A，MCP 操作 tab B                                                                                                   | tab B 短暂显示操作高亮；tab A 的选中态仍然可辨认；不会误导为 tab A 正在被 MCP 操作  |
| MI09 | close 按钮稳定                | 在 `MCP` badge 显示期间点击 tab close 按钮                                                                                           | 关闭的是该 tab；badge 不改变 close hit area，不导致误点其它 tab                     |
| MI10 | 浏览器重连                    | 断开 MCP/CDP 客户端再重新连接                                                                                                        | 重新连接后的 attached-only tab 仍不显示常驻 `MCP`；只有真实操作后才显示短暂操作标志 |

### 自动化回归覆盖

`frontend/tests/terminal-browser-mcp-indicator.spec.ts` 覆盖以下可自动化规则：

- `MI01` / `MI02`：`cdpProxyAttached=true` 但 `mcpActivityUntil=null` 时不显示 `MCP`。
- `MI03`：`mcpActivityUntil` 未过期时显示且只显示一个 `MCP`。
- `MI04`：过期时间戳会自动移除 `MCP`。
- `MI05`：直接覆盖 Playwright/CDP 初始化与读取命令列表，确认 `Page.enable`、`Runtime.enable`、`Target.setAutoAttach`、`Network.enable`、`Emulation.setEmulatedMedia`、`Runtime.evaluate` 等不会触发 MCP 活动标志。
- `MI06` / `MI08`：用户选中的 tab 与 MCP 操作中的 tab 可以不同，只有操作中的 tab 显示 `MCP`。
- `MI07`：MCP 创建但没有近期活动的 tab 不显示永久 `MCP`。
- `MI09`：`MCP` badge 显示期间 close 按钮仍关闭正确 tab。

执行命令：

```bash
pnpm --filter @runweave/frontend exec playwright test tests/terminal-browser-mcp-indicator.spec.ts
```

### 桌面端人工验收步骤

1. 启动 `pnpm dev:electron`。
2. 打开 Terminal Browser 面板，手动打开一个普通 tab 到 `https://github.com/jackshen3102/run-weave/pulls?q=is%3Apr+is%3Aclosed`。
3. 确认 tab 上没有 `MCP` 标志。
4. 使用 `<cdp>` 连接 CDP proxy，但只做 `Target.setAutoAttach`、Playwright 初始化、`page.title()` 或 `page.evaluate(() => location.href)` 这类读取操作，不执行 `page.goto` / click / type。
5. 确认该 GitHub tab 仍没有 `MCP` 标志，覆盖截图中的回归。
6. 对同一个 page 执行一次真实操作，例如 `await page.goto("https://example.com")` 或点击/输入。
7. 确认该 tab 短暂显示绿色高亮和 `MCP` 标志。
8. 等待 5 秒，确认 `MCP` 标志消失。
9. 新建第二个 tab，对第二个 tab 执行 `page.goto("https://example.com")`。
10. 确认只有第二个 tab 短暂显示 `MCP`，第一个 GitHub tab 不显示。

## 并发与稳定性

`MAX_AI_TABS` 当前上限是 10，且会受当前已有 Terminal Browser target 数影响。R01 只验证反复创建/关闭的稳定性，不验证批量占满上限；每轮必须先关闭本轮创建的 tab，再进入下一轮。批量上限验证使用 T14。

macOS/Electron 主窗口关闭按钮当前是“隐藏到后台/托盘”语义，不等价于退出 App。点击主窗口关闭按钮不应要求 CDP proxy 断开，也不应要求销毁 Terminal Browser target；只有真正退出 App 才应停止 9224 代理。

| ID  | 用例                                | 操作                                                                                                                           | 预期                                                                                                            |
| --- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| R01 | 创建/关闭循环                       | 循环 10 次：创建 1 个百度 tab，确认加载后立即关闭，再进入下一轮                                                                | 无残留临时 tab，无明显卡死                                                                                      |
| R02 | 两个 MCP 连接 discovery             | 两个客户端分别 `Target.setDiscoverTargets`                                                                                     | discovery 事件只发给各自连接，不串扰                                                                            |
| R03 | 两个 Playwright 实例操作不同 tab    | 客户端 A、B 同时 `chromium.connectOverCDP(<cdp>)`，分别对不同 page 执行 `Runtime.evaluate`                                     | 两个 evaluate 都成功；任一客户端断开后，另一客户端仍能继续操作自己的 page                                       |
| R04 | 两个 raw CDP client 操作不同 target | 客户端 A、B 分别 `Target.attachToTarget` 到不同 target，然后并发 `Runtime.evaluate`                                            | 两个命令都成功，sessionId 不串扰                                                                                |
| R05 | 同 target 多客户端边界              | 两个客户端同时操作同一个 page                                                                                                  | 不崩溃；命令可以串行完成或返回明确冲突错误；不得因一个客户端断开导致另一个客户端的不同 target session 失效      |
| R06 | 一个连接关闭 tab                    | 连接 A 关闭 target，连接 B 已 discovery                                                                                        | 连接 B 收到 target destroyed/detached                                                                           |
| R07 | 加载中断开 MCP                      | 百度加载中直接关闭 MCP 连接                                                                                                    | Runweave UI 和 Browser tab 仍可用                                                                               |
| R08 | 加载中关闭 tab                      | 百度加载中在 UI 关闭 tab                                                                                                       | MCP 收到 detached，不崩溃                                                                                       |
| R09 | 隐藏 Electron 主窗口                | MCP 连接存在时点击 Electron 主窗口关闭按钮                                                                                     | App 不退出；9224 仍监听；MCP 连接不断开；`Target.getTargets` 仍可见原 target；重新激活窗口后 Browser tab 仍可用 |
| R10 | 端口占用                            | 让 `9224` 被占用后启动 Electron                                                                                                | 端口解析或报错行为明确                                                                                          |
| R11 | 非法端口环境变量                    | 设置 `RUNWEAVE_TERMINAL_BROWSER_CDP_PROXY_PORT=abc` 或 `70000`                                                                 | 启动失败且错误明确                                                                                              |
| R12 | 两个 Agent group 默认 page          | tab A、tab B 分别复制 group scoped endpoint；两个客户端各自 `connectOverCDP(endpoint)` 后直接用 `context.pages()[0].goto(...)` | A 只导航 group A 的默认 page，B 只导航 group B 的默认 page；不会共同改写同一个历史第一个 tab                    |

R12 需要基于真实 Terminal Browser 验收：分别复制 tab A、tab B 的 group scoped endpoint，用两个独立 Playwright/CDP 客户端连接后直接操作默认 page，确认两个客户端不会共同改写同一个历史第一个 tab。

### 多客户端自动化覆盖

`frontend/tests/terminal-browser-cdp-multi-client.spec.ts` 覆盖 `R03`。该用例需要真实桌面端 CDP endpoint；默认 CI 不设置 endpoint 时跳过。

执行命令：

```bash
RUNWEAVE_DESKTOP_CDP_ENDPOINT=http://127.0.0.1:9224 \
  pnpm --filter @runweave/frontend exec playwright test tests/terminal-browser-cdp-multi-client.spec.ts
```

## Playwright MCP 端到端验收建议

如果使用 Playwright MCP 工具手工执行，建议按以下顺序：

1. 打开 `https://www.baidu.com`。
2. 截图，确认截图不是空白。
3. 在 `https://httpbin.org/forms/post` 表单输入 `Runweave` 并提交。
4. 打开新 tab 到 `https://example.com`。
5. 在 Runweave UI 确认 tab bar、地址栏、标题同步。
6. 执行一个安全拦截用例，例如 `file:///etc/passwd` 导航应失败。
7. 关闭 MCP 创建的 tab，确认 UI 与 MCP 事件一致。

## 结果记录模板

```markdown
执行日期：
Runweave 版本/commit：
CDP endpoint：
MCP 客户端：

| ID  | 结果      | 备注 |
| --- | --------- | ---- |
| C01 | PASS/FAIL |      |
| C02 | PASS/FAIL |      |
| T12 | PASS/FAIL |      |
| P01 | PASS/FAIL |      |
| U02 | PASS/FAIL |      |
| S09 | PASS/FAIL |      |
```
