# Terminal Browser Playwright MCP 测试用例

本文档从 **Playwright MCP 工具视角** 测试 Runweave Terminal Browser CDP Proxy 的能力。相比 `terminal-browser-cdp-mcp-test-cases.md` 侧重底层 CDP 命令验证，本文档聚焦 Playwright MCP 高级工具（`browser_navigate`、`browser_click`、`browser_type`、`browser_screenshot`、`browser_snapshot`）在 CDP Proxy 场景下的行为差异和边界覆盖。

## 适用范围

- Runweave Electron 客户端中的 Terminal Browser。
- CDP Proxy endpoint，例如 `http://127.0.0.1:9224`。
- 通过 `@playwright/mcp` Server 连接上述 endpoint 的 AI 客户端（如 Claude Desktop、Codex、Coco CLI）。
- 通过 Playwright CLI 脚本使用 `chromium.connectOverCDP(...)` 的自动化客户端。

## 与原生浏览器 MCP 的关键差异

| 维度                | 原生浏览器 MCP（Chrome/标准 CDP） | Runweave CDP Proxy                             |
| ------------------- | --------------------------------- | ---------------------------------------------- |
| Target 可见范围     | 所有 browser target               | 仅 Terminal Browser 白名单 tab                 |
| Target.createTarget | 可创建任意 window/tab             | 只创建 Terminal Browser AI tab（上限 10）      |
| 导航协议            | 无限制                            | 仅 http/https/about:blank                      |
| 危险命令            | 全部可用                          | Browser.close 等 8 个永久阻断                  |
| DevTools            | 可并存                            | 硬性互斥                                       |
| Session ID          | 透传                              | 双域翻译（proxySessionId ↔ electronSessionId） |
| Frame ID            | 透传                              | Proxy 双向重写（targetId ↔ rootFrameId）       |
| 连接数              | 无限制                            | 最大 8 个 CDP 连接                             |
| Env 传播            | 手动配置                          | 自动 PLAYWRIGHT_MCP_CDP_ENDPOINT               |

## 前置条件

1. 启动 Electron 客户端 `pnpm dev:electron`。
2. 打开 Terminal 侧边栏的 Browser 面板。
3. 点击 CDP/AI endpoint 按钮，复制当前 endpoint，后文统一记为 `<cdp>`。
4. 确认 Runweave terminal 内 `echo $PLAYWRIGHT_MCP_CDP_ENDPOINT` 输出与 `<cdp>` 一致。
5. 记录 Runweave 主窗口状态、Browser tab 数量，测试后验证这些状态未被破坏。

## Playwright MCP 连接验证脚本

```bash
pnpm --filter ./frontend exec node --input-type=module <<'NODE'
import { chromium } from "@playwright/test";

const endpoint = process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT || "<cdp>";
const browser = await chromium.connectOverCDP(endpoint);
const context = browser.contexts()[0] ?? await browser.newContext();
const page = context.pages()[0] ?? await context.newPage();

await page.goto("https://www.baidu.com", { waitUntil: "domcontentloaded" });
console.log({
  url: page.url(),
  title: await page.title(),
  pages: browser.contexts().flatMap(c => c.pages()).length,
});

await browser.close();
NODE
```

## MCP 工具级测试用例

### browser_navigate — 导航能力

| ID   | 用例                | 操作                                                                         | 预期                                    |
| ---- | ------------------- | ---------------------------------------------------------------------------- | --------------------------------------- |
| MN01 | HTTPS 导航          | MCP 调用 `browser_navigate` URL=`https://www.baidu.com`                      | 页面加载成功，返回标题包含 `百度一下`   |
| MN02 | HTTP 导航           | MCP 调用 `browser_navigate` URL=`http://example.com`                         | 页面加载成功，标题 `Example Domain`     |
| MN03 | 空白页导航          | MCP 调用 `browser_navigate` URL=`about:blank`                                | 导航成功，不报错                        |
| MN04 | file 协议拦截       | MCP 调用 `browser_navigate` URL=`file:///etc/passwd`                         | 被 Proxy 拒绝，返回导航失败错误         |
| MN05 | javascript 协议拦截 | MCP 调用 `browser_navigate` URL=`javascript:alert(1)`                        | 被 Proxy 拒绝                           |
| MN06 | chrome 协议拦截     | MCP 调用 `browser_navigate` URL=`chrome://settings`                          | 被 Proxy 拒绝                           |
| MN07 | devtools 协议拦截   | MCP 调用 `browser_navigate` URL=`devtools://devtools/bundled/inspector.html` | 被 Proxy 拒绝                           |
| MN08 | 地址栏同步          | MCP 导航到百度后观察 Runweave UI                                             | 地址栏显示百度 URL                      |
| MN09 | Tab 标题同步        | MCP 导航到百度后观察 tab 标题                                                | tab 标题最终同步为 `百度一下，你就知道` |
| MN10 | 导航后 reload       | MCP 导航到百度后调用 `page.reload()`                                         | 页面重新加载成功，URL 不变              |
| MN11 | 导航后 back/forward | 依次导航百度→example.com，执行 back→forward                                  | 页面和地址栏同步变化                    |
| MN12 | hash 导航           | MCP 导航到 `https://example.com/#section-a`                                  | 地址栏包含 `#section-a`                 |
| MN13 | 超长 URL            | MCP 导航到 `https://example.com/?` + 10000 字符 query                        | 不崩溃；成功或返回明确错误              |
| MN14 | 并发导航            | 快速连续发送 3 次不同 URL 导航                                               | 最终页面稳定在最后一个 URL，不崩溃      |

### browser_click — 点击能力

| ID   | 用例           | 操作                                                           | 预期                                       |
| ---- | -------------- | -------------------------------------------------------------- | ------------------------------------------ |
| MC01 | 链接点击       | 打开 example.com，MCP 点击 `More information...` 链接          | 页面跳转到 IANA 页面                       |
| MC02 | 按钮点击       | 打开 `https://httpbin.org/forms/post`，MCP 点击 `Submit order` | 表单提交成功                               |
| MC03 | 输入框聚焦点击 | MCP 点击 `input[name="custname"]`                              | 输入框获得焦点                             |
| MC04 | 坐标点击       | MCP 通过坐标 (100, 100) 点击                                   | 点击事件触发，不影响 Runweave 外层 UI      |
| MC05 | 右键点击       | MCP 在页面元素上右键点击                                       | 触发 contextmenu，不弹出 Electron 原生菜单 |
| MC06 | 双击           | MCP 在文本上双击                                               | 选中词汇，不影响外层                       |
| MC07 | 跨 frame 点击  | 如果页面含 iframe，MCP 点击 iframe 内元素                      | 点击成功或返回明确的 frame 相关错误        |

### browser_type — 输入能力

| ID   | 用例          | 操作                                                  | 预期                           |
| ---- | ------------- | ----------------------------------------------------- | ------------------------------ |
| MT01 | 文本框输入    | 打开 httpbin forms，MCP 在 `custname` 输入 `Runweave` | 输入框显示 `Runweave`          |
| MT02 | textarea 输入 | MCP 在 `comments` textarea 输入多行文本               | 文本显示在 textarea            |
| MT03 | 中文输入      | MCP 输入 `你好世界`                                   | 正确显示中文                   |
| MT04 | 特殊字符输入  | MCP 输入 `<script>alert(1)</script>`                  | 作为纯文本显示在输入框，不执行 |
| MT05 | Enter 键      | MCP 在搜索框输入后发送 Enter                          | 触发表单提交或搜索             |
| MT06 | Tab 键        | MCP 发送 Tab 键                                       | 焦点切换到下一个表单元素       |
| MT07 | Meta+Q 拦截   | MCP 发送 Meta+Q 组合键                                | 被 Proxy 拦截，Electron 不退出 |
| MT08 | Meta+W 拦截   | MCP 发送 Meta+W 组合键                                | 被 Proxy 拦截，窗口不关闭      |
| MT09 | 普通快捷键    | MCP 发送 Meta+A（全选）                               | 允许执行，页面内容被全选       |
| MT10 | 连续快速输入  | MCP 快速输入 100 个字符                               | 全部字符正确显示，不丢字符     |

### browser_screenshot — 截图能力

| ID   | 用例           | 操作                            | 预期                                            |
| ---- | -------------- | ------------------------------- | ----------------------------------------------- |
| MS01 | 基础截图       | 导航到 example.com 后 MCP 截图  | 返回有效图片数据，非空白                        |
| MS02 | 截图尺寸       | 检查截图的宽高                  | 宽高大于 0，符合 Terminal Browser 面板尺寸      |
| MS03 | 动态页面截图   | 导航到百度后截图                | 截图包含百度页面内容                            |
| MS04 | 面板隐藏时截图 | 隐藏 Browser 面板或最小化后截图 | 截图仍然成功且非 0 宽高；若失败则记录为能力缺陷 |
| MS05 | 连续截图       | 快速连续截图 5 次               | 全部成功，不卡死                                |
| MS06 | 截图格式       | 检查返回的截图格式              | 应为 webp 或 png（根据实现），质量可接受        |
| MS07 | 全页面截图     | MCP 请求 fullPage 截图          | 成功或返回明确的不支持错误                      |
| MS08 | 元素截图       | MCP 截取特定元素                | 成功或返回明确错误                              |

### browser_snapshot — 可访问性快照能力

| ID   | 用例            | 操作                                    | 预期                                                |
| ---- | --------------- | --------------------------------------- | --------------------------------------------------- |
| MA01 | 基础 snapshot   | 导航到 example.com 后 MCP 获取 snapshot | 返回 accessibility tree，包含 `Example Domain` 文本 |
| MA02 | 表单 snapshot   | 在 httpbin forms 页面获取 snapshot      | 包含 input、textarea、button 等表单元素节点         |
| MA03 | 导航后 snapshot | 先导航到百度，等待加载后 snapshot       | 包含搜索框和按钮元素                                |
| MA04 | 空白页 snapshot | 在 about:blank 页面获取 snapshot        | 返回最小 tree，不报错                               |
| MA05 | 大页面 snapshot | 在内容丰富的页面获取 snapshot           | 成功返回，不超时                                    |

## CDP Proxy 特有场景

### 连接与发现

| ID   | 用例                | 操作                                                             | 预期                                            |
| ---- | ------------------- | ---------------------------------------------------------------- | ----------------------------------------------- |
| CP01 | env 自动发现        | 在 Runweave terminal 启动 `@playwright/mcp`，不手动配置 endpoint | 通过 `PLAYWRIGHT_MCP_CDP_ENDPOINT` 自动连接成功 |
| CP02 | 只看到白名单 target | MCP 连接后列出 pages                                             | 只包含 Terminal Browser tab，无 Runweave 主窗口 |
| CP03 | 新开页面            | MCP 调用 `browser.newPage()` 或 `context.newPage()`              | 在 Terminal Browser 创建新 AI tab               |
| CP04 | 新页面 UI 同步      | MCP 创建新 tab 后观察 Runweave UI                                | tab bar 出现新 tab                              |
| CP05 | 新页面上限          | MCP 连续创建 10 个新 page 后再创建第 11 个                       | 返回 `Maximum AI tab limit` 错误                |
| CP06 | 关闭页面 UI 同步    | MCP 关闭一个 page 后观察 UI                                      | tab 从 tab bar 消失                             |
| CP07 | 重新连接            | 断开 MCP 连接后重新连接                                          | 连接成功，能看到之前的 tab                      |
| CP08 | 多客户端连接        | 两个 MCP 客户端同时连接                                          | 都能看到相同的 target 列表                      |
| CP09 | 连接数上限          | 8 个客户端已连接后第 9 个尝试连接                                | 返回 503 或明确拒绝                             |

### Session 管理（双 sessionId 域）

| ID   | 用例                       | 操作                                             | 预期                                                         |
| ---- | -------------------------- | ------------------------------------------------ | ------------------------------------------------------------ |
| CS01 | sessionId 隔离             | MCP 连接后检查收到的 sessionId                   | 是 Proxy 生成的 proxySessionId，不是 Electron 内部 sessionId |
| CS02 | 多 tab session             | MCP 在两个 tab 间切换操作                        | 各 tab 的 session 独立，操作不串扰                           |
| CS03 | session 级 Target 命令拦截 | 在 attached session 内发送 `Target.createTarget` | 返回受控 no-op 或错误，不创建 Electron BrowserWindow         |
| CS04 | 无效 sessionId             | 使用伪造 sessionId 发送命令                      | 返回 `Unknown session`，Proxy 不崩溃                         |

### Frame ID 重写

| ID   | 用例              | 操作                                                  | 预期                                           |
| ---- | ----------------- | ----------------------------------------------------- | ---------------------------------------------- |
| CF01 | Page.getFrameTree | MCP 内部调用 `Page.getFrameTree`                      | 返回正确的 frameTree，frameId 与 targetId 一致 |
| CF02 | frame 内执行 JS   | 在主 frame 执行 `page.evaluate(() => document.title)` | 返回正确标题，frameId 正确映射                 |
| CF03 | iframe 场景       | 打开含 iframe 的页面，操作 iframe 内容                | frameId 重写正确，不出现 frame/target 错配     |

### 安全拦截（MCP 工具层面）

| ID   | 用例                   | 操作                                                        | 预期                                                   |
| ---- | ---------------------- | ----------------------------------------------------------- | ------------------------------------------------------ |
| SS01 | file 协议 via evaluate | MCP 执行 `page.evaluate(() => fetch('file:///etc/passwd'))` | 浏览器安全策略拒绝，不返回文件内容                     |
| SS02 | 窗口操作 via evaluate  | MCP 执行 `page.evaluate(() => window.close())`              | 不关闭 Runweave 主窗口                                 |
| SS03 | 导航主窗口             | MCP 尝试导航到 Runweave 主窗口 URL                          | 无法选中主窗口 target，操作受限于 Terminal Browser     |
| SS04 | Browser.close via MCP  | MCP 调用 `browser.close()`                                  | Proxy 收到 `Browser.close` 时返回错误但不关闭 Electron |
| SS05 | setContent 危险内容    | MCP 调用 `page.setContent` 含 `javascript:` 链接            | 被 Proxy 过滤拒绝                                      |
| SS06 | 跨域 cookie 读取       | MCP 尝试读取非当前域的 cookie                               | 受限于当前 page domain                                 |

### DevTools 互斥

| ID   | 用例                     | 操作                                             | 预期                                          |
| ---- | ------------------------ | ------------------------------------------------ | --------------------------------------------- |
| SD01 | MCP 连接中打开 DevTools  | MCP attached 期间在 UI 点击 DevTools 按钮        | 按钮 disabled 或主进程拒绝打开                |
| SD02 | DevTools 已开时 MCP 连接 | 先打开某 tab 的 DevTools，再让 MCP attach 该 tab | attach 失败，错误包含 DevTools 相关信息       |
| SD03 | MCP 断开后 DevTools 恢复 | 关闭 MCP 连接后点击 DevTools                     | DevTools 可正常打开                           |
| SD04 | 外部 detach 感知         | DevTools 被强制打开导致 debugger detach          | MCP 收到 session 断开事件，Proxy 清理 session |

## 端到端工作流

### Playwright MCP 典型 AI 工作流

| ID  | 用例           | 操作                                                                                  | 预期                             |
| --- | -------------- | ------------------------------------------------------------------------------------- | -------------------------------- |
| E01 | 搜索工作流     | MCP 依次：navigate 百度→snapshot→找到搜索框→type "Runweave"→click 百度一下→screenshot | 全流程成功，截图含搜索结果       |
| E02 | 表单填写工作流 | MCP 依次：navigate httpbin forms→snapshot→type custname→type comments→click submit    | 提交成功，返回页面含提交数据     |
| E03 | 多 tab 工作流  | MCP 依次：newPage→navigate 百度→newPage→navigate example.com→切换 tab→screenshot      | 各 tab 内容正确，UI tab bar 同步 |
| E04 | 错误恢复工作流 | MCP：navigate 到不存在的域名→确认错误→navigate 到正确 URL                             | 错误不阻塞后续操作               |
| E05 | 长时间会话     | MCP 连接后执行 20+ 次导航/截图/输入操作                                               | session 稳定，不超时不断开       |

### 对比原生 MCP 的差异验证

| ID  | 用例             | 操作                                          | 预期（CDP Proxy 特有行为）                              |
| --- | ---------------- | --------------------------------------------- | ------------------------------------------------------- |
| D01 | Target 隔离验证  | MCP 列出所有 pages                            | 只含 Terminal Browser tab，无 Runweave renderer         |
| D02 | 新 tab 来源验证  | MCP 调用 newPage 后检查新 tab 属性            | 新 tab 由 Terminal Browser 管理，aiAllowed=true         |
| D03 | 窗口安全验证     | MCP 尝试各种方式操作主窗口                    | 所有尝试失败，主窗口状态不变                            |
| D04 | 关闭行为验证     | MCP 调用 `browser.close()`                    | Proxy 拦截，Electron 不退出，Terminal Browser 仍可用    |
| D05 | 导航协议验证     | MCP 尝试 file/chrome/devtools/javascript 协议 | 全部被 Proxy 层拦截（而非浏览器层）                     |
| D06 | 环境变量传播验证 | 在 Runweave terminal 新建 shell 后检查 env    | `PLAYWRIGHT_MCP_CDP_ENDPOINT` 已设置且指向 Proxy        |
| D07 | Proxy 信息验证   | 访问 `<cdp>/json/version`                     | 返回 `Runweave/CDP-Proxy`，不是 Chrome/Electron 原始 UA |
| D08 | 连接上限验证     | 超过 8 个 MCP 连接                            | 第 9 个被拒绝（原生 CDP 无此限制）                      |
| D09 | AI tab 上限验证  | 超过 10 个 newPage                            | 第 11 个失败（原生 CDP 无此限制）                       |

## 并发与稳定性

| ID   | 用例                  | 操作                                                   | 预期                                             |
| ---- | --------------------- | ------------------------------------------------------ | ------------------------------------------------ |
| MR01 | MCP 导航中断开        | 百度加载中直接关闭 MCP 连接                            | Runweave UI 和 Browser tab 仍可用                |
| MR02 | MCP 输入中关闭 tab    | 在 UI 关闭正在输入的 tab                               | MCP 收到 session 断开事件，不崩溃                |
| MR03 | 快速重连              | 连续连接→操作→断开 5 次                                | 每次都正常工作，无残留状态                       |
| MR04 | 两个 MCP 操作同一 tab | 两个 MCP 客户端同时对同一 page 发送命令                | 不崩溃，命令按序执行或返回冲突错误               |
| MR05 | MCP 操作中隐藏窗口    | MCP 操作期间点击 Electron 主窗口关闭按钮（隐藏到后台） | MCP 连接不断开，9224 仍监听，重新激活后 tab 可用 |
| MR06 | 端口被占用启动        | 9224 端口被占用后启动 Electron                         | 自动漂移到下一个可用端口，或明确报错             |

## Playwright MCP 端到端验收流程

建议按以下顺序执行完整验收：

1. **环境验证**：在 Runweave terminal 确认 `echo $PLAYWRIGHT_MCP_CDP_ENDPOINT` 输出正确 endpoint。
2. **连接验证**：运行快速验证脚本，确认能连接且看到正确 page。
3. **导航验证**：MCP 导航到百度，确认标题和地址栏同步。
4. **截图验证**：截图，确认非空白且尺寸正确。
5. **输入验证**：在 httpbin forms 输入文本并提交。
6. **多 tab 验证**：创建新 tab，导航到 example.com，确认 UI 同步。
7. **安全验证**：尝试 `file:///etc/passwd` 导航，确认被拦截。
8. **互斥验证**：尝试在 MCP attached 时打开 DevTools，确认被禁用。
9. **关闭验证**：关闭 MCP 创建的 tab，确认 UI 和事件一致。
10. **恢复验证**：断开 MCP 后确认 DevTools 可用，Browser tab 正常。

## 结果记录模板

```markdown
执行日期：
Runweave 版本/commit：
CDP endpoint：
MCP 客户端类型：[ ] @playwright/mcp [ ] Playwright CLI [ ] Codex [ ] Coco CLI
操作系统：

| ID   | 结果      | 备注 |
| ---- | --------- | ---- |
| MN01 | PASS/FAIL |      |
| MN04 | PASS/FAIL |      |
| MC01 | PASS/FAIL |      |
| MT01 | PASS/FAIL |      |
| MT07 | PASS/FAIL |      |
| MS01 | PASS/FAIL |      |
| MA01 | PASS/FAIL |      |
| CP01 | PASS/FAIL |      |
| CP02 | PASS/FAIL |      |
| SS01 | PASS/FAIL |      |
| SD01 | PASS/FAIL |      |
| E01  | PASS/FAIL |      |
| D01  | PASS/FAIL |      |
```
