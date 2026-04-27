# Terminal Browser CDP/MCP 测试用例

本文档用于手工验证 Runweave Terminal Browser 暴露给 Playwright MCP / Playwright CLI 的 CDP Proxy 能力。

## 适用范围

- Runweave Electron 客户端中的 Terminal Browser。
- CDP Proxy endpoint，例如 `http://127.0.0.1:9224`。
- 通过 Playwright MCP 或 `chromium.connectOverCDP(...)` 连接上述 endpoint 的自动化客户端。

## 前置条件

1. 启动 Electron 客户端。
2. 打开 Terminal 侧边栏的 Browser 面板。
3. 点击 CDP/AI endpoint 按钮，复制当前 tab 的 endpoint，后文统一记为 `<cdp>`。
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

S05-S08 属于高风险安全命令。如果代理没有正确拦截，可能改变浏览器安全行为或删除本地浏览数据。默认不要在真实用户 profile 上直接执行这些命令；优先通过 `electron/src/terminal-browser-cdp-proxy.test.ts` 的 `isBlockedCommand` 断言验证。只有在一次性 Electron profile、测试账号、可丢弃数据环境中，才执行端到端发送命令验证。

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

## 并发与稳定性

`MAX_AI_TABS` 当前上限是 10，且会受当前已有 Terminal Browser target 数影响。R01 只验证反复创建/关闭的稳定性，不验证批量占满上限；每轮必须先关闭本轮创建的 tab，再进入下一轮。批量上限验证使用 T14。

macOS/Electron 主窗口关闭按钮当前是“隐藏到后台/托盘”语义，不等价于退出 App。点击主窗口关闭按钮不应要求 CDP proxy 断开，也不应要求销毁 Terminal Browser target；只有真正退出 App 才应停止 9224 代理。

| ID  | 用例                    | 操作                                                                 | 预期                                                                                                            |
| --- | ----------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| R01 | 创建/关闭循环           | 循环 10 次：创建 1 个百度 tab，确认加载后立即关闭，再进入下一轮      | 无残留临时 tab，无明显卡死                                                                                      |
| R02 | 两个 MCP 连接 discovery | 两个客户端分别 `Target.setDiscoverTargets`                           | discovery 事件只发给各自连接，不串扰                                                                            |
| R03 | 一个连接关闭 tab        | 连接 A 关闭 target，连接 B 已 discovery                              | 连接 B 收到 target destroyed/detached                                                                           |
| R04 | 加载中断开 MCP          | 百度加载中直接关闭 MCP 连接                                          | Runweave UI 和 Browser tab 仍可用                                                                               |
| R05 | 加载中关闭 tab          | 百度加载中在 UI 关闭 tab                                             | MCP 收到 detached，不崩溃                                                                                       |
| R06 | 隐藏 Electron 主窗口    | MCP 连接存在时点击 Electron 主窗口关闭按钮                           | App 不退出；9224 仍监听；MCP 连接不断开；`Target.getTargets` 仍可见原 target；重新激活窗口后 Browser tab 仍可用 |
| R07 | 端口占用                | 让 `9224` 被占用后启动 Electron                                      | 端口解析或报错行为明确                                                                                          |
| R08 | 非法端口环境变量        | 设置 `BROWSER_VIEWER_TERMINAL_BROWSER_CDP_PROXY_PORT=abc` 或 `70000` | 启动失败且错误明确                                                                                              |

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
