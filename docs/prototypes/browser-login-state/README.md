# Cookie 导入导出与服务器登录态：三套交互原型

2026-10-11 的设计产物，当前为**待用户评审、未冻结**状态。它不是产品当前能力的说明；未修改产品代码，未编写实施计划。

## 打开

在 Runweave Terminal 顶部 `... → Prototypes` 选择 `browser-login-state`，默认进入三方案选型页。

单独查看时，在仓库根目录运行：

```bash
python3 -m http.server 6197 --bind 127.0.0.1 --directory docs/prototypes/browser-login-state
```

打开本机地址 `http://127.0.0.1:6197/`。该地址仅在这台电脑可访问，不是公开部署。

| 方案                | 页面              | 适用场景                           | 取舍                                                     |
| ------------------- | ----------------- | ---------------------------------- | -------------------------------------------------------- |
| A：当前网站快捷工具 | `?scheme=quick`   | 临时导出、已有服务器脚本、手工导入 | 操作短；文件传输和服务器接入需自行处理                   |
| B：发送到服务器向导 | `?scheme=send`    | 明确要把当前网站带到某台服务器     | 一条路径完成选择、确认、导入与验证；需要服务器运行时支持 |
| C：登录态管理       | `?scheme=library` | 多网站、多账号、多服务器的持续使用 | 能集中发现失效和恢复；界面与管理成本最高                 |

建议先评审 B 的完整任务路径；A 可以作为轻量入口，C 在多身份管理需求明确时引入。三者可组合，也可分别交付，目前没有选定最终方案。

## 原型简报

- 用户目标：让本机已登录的网站可以方便地在服务器使用。
- 动作：选择 Browser 与网站、导出文件、导入预览、选择服务器身份、验证登录、处理重新登录。
- 真实产品落点：Terminal Browser 的 Profile 区域及拟新增的登录态面板；C 是独立管理视图的设计候选。
- 关键状态：没有选择网站、JSON 无效、过期条目、分区属性不支持、覆盖既有账号、未验证、已验证、需要重新登录、服务器离线。
- 非目标：完整浏览器目录同步、真实 cookie 采集、真实凭据传输、真实服务器安装、localStorage/IndexedDB 迁移、生产安全合同。

## 试用路径

A：选择网站范围与格式 → 导出文件 → 切到导入 → 选择刚下载的文件或粘贴 JSON → 预览 → 导入 → 验证。下载的文件只有虚构 cookie，不含真实凭据。取消全部网站后无法导出；切换 Browser 会改变目标并清除刚才的导入反馈。

B：选择来源 Browser 和域名 → 选择服务器 → 新建身份或更新已有身份 → 确认范围 → 导入并验证。第二步还可选择“服务器使用本机 Browser”，清楚呈现本机必须在线、不会复制 cookie 的差异。返回上一步保留选择；离线服务器不能选择。

C：选择身份查看详情 → 搜索或按状态筛选 → 导入文件建立新身份 → 验证 → 更新 cookie。更新后回到“未验证”。选择“团队知识库”可试用重新登录路径。已经验证的身份打开浏览器时展示账号页。

## 演示状态

这些 URL 参数是原型辅助机制，不进入产品界面或实施需求：

- `?scheme=send&verify=mfa`：导入成功，但网站要求重新登录；打开浏览器后点“我已登录，重新验证”进入成功状态。
- `?scheme=send&verify=unknown`：导入成功，但没有获得网站登录证据。
- `?scheme=send&verify=mfa&recover=fail`：重新验证仍然无法确认登录。
- `?scheme=library&verify=unknown`：点击重新验证，身份保持未验证。
- 默认验证结果成功；等待时长、账号证据、远程浏览器画面都是 fixture。所有状态只存在内存，刷新即重置。

## 文件与截图

- [index.html](index.html)：壳层与 dialog 挂载点。
- [app.js](app.js)：三套界面及状态流转。
- [style.css](style.css)：共享视觉与窄屏布局。
- [mock-state.json](mock-state.json)：虚构服务器、身份、网站和 cookie。
- [A：网站侧面板](preview-a.png)、[B：迁移确认](preview-b.png)、[C：失效身份详情](preview-c.png)：独立 Chrome 浏览器截图。

## 功能分类

| 元素或行为                                                   | 分类             | 边界                                            |
| ------------------------------------------------------------ | ---------------- | ----------------------------------------------- |
| 网站与 Profile 选择、JSON 文件下载、文件与粘贴导入、范围预览 | 产品候选核心功能 | 当前仅对 fixture 或本地输入工作                 |
| 服务器与身份选择、覆盖提醒、导入与验证分离                   | 产品候选核心功能 | 真实传输、版本冲突处理尚未实现                  |
| 身份列表、状态筛选、重新登录与验证                           | 产品候选核心功能 | 服务器 viewer、任务暂停和恢复都是模拟           |
| 选型首页                                                     | 原型辅助功能     | 以 `data-prototype-helper` 标记，独立于产品页面 |
| scheme / verify / recover 参数                               | 原型辅助功能     | 仅切换方案与模拟结果                            |
| 背景仓库页面、固定账号与验证时间                             | 原型辅助数据     | 不代表真实网站证据                              |

## 当前代码事实与能力缺口

基于本次 rebase 后的 `fca06360` 核对：

- [Profile 定义](../../../packages/shared/src/browser/profile.ts)已有 Browser 1/2/3 及独立持久 partition。
- [Profile 设置组件](../../../frontend/src/components/terminal/browser/header/profile-settings.tsx)是当前相关 UI 入口之一；没有从原型复制实现进去。
- [远程项目文档](../../architecture/ssh-remote-projects.md)中的回连是服务器使用本机 Browser，本机必须在线。
- [CDP 消息处理](../../../electron/src/browser/cdp/proxy/messages.ts)和[会话消息处理](../../../electron/src/browser/cdp/proxy/session-messages.ts)里的 Storage.getCookies 返回空数组，Storage.setCookies 返回空结果。当前 endpoint 的成功响应不能证明真实 cookie 导入导出。
- 独立服务器身份、传输、持久存储、真实账号验证、接管时暂停 Agent 写操作仍需要真实实现和验证。

本次复核的官方资料：[Electron Cookies](https://www.electronjs.org/docs/latest/api/cookies)提供 Session cookie 读写接口；[Playwright Authentication](https://playwright.dev/docs/auth)说明存储状态复用。原型只表达 cookies-only 交互，不把它标作完整网站登录态迁移。

## 实际验证

使用仓库固定 Playwright CLI 1.62.1 与本任务独立 Chrome 会话，浏览器交互检查覆盖：

- A：空范围禁用；导出文件确有 8 项所选域名的虚构 cookie，origins 为空；无效 JSON；过期条目跳过；预览、导入、验证及切换 Profile。
- B：服务器选择；覆盖提示；空名称阻止继续；确认、导入与身份查看；本机回连分支；需要重新登录及恢复。
- C：身份选择、搜索空态、状态筛选；通过文件建立新身份；验证、打开浏览器；分区属性拒绝；更新后清除验证状态。

- 三套页面在 390px 窄屏下无横向溢出；另检查无法确认登录、重新登录仍未成功的反馈；浏览器未出现 pageerror。

以上是 HTML 原型交互验证，不是 Runweave 产品、真实 cookie、服务器或真实网站登录验收。

## 评审状态

- 已提供 A/B/C 三个候选方案，尚未选定或放弃任何方案。
- 产品功能清单、具体实现范围、最终视觉均待用户评审。
- 原型阶段继续调整本目录；用户推进实现后再整理实施计划。
