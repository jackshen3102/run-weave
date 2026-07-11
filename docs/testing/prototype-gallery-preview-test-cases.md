# 多项目原型轮巡库测试案例

本文档验证 `docs/architecture/terminal-code-preview.md#多项目原型轮巡库`。浏览器行为必须使用 `$toolkit:playwright-cli` 在真实 Chromium 中执行；静态检查、代码阅读或截图不能替代交互验收。

## 范围与前提

- 项目来源：当前 Runweave 服务的 Terminal Project 列表。
- 原型来源：每个 `<project.path>/docs/prototypes/` 的一级目录。
- 可运行入口：原型目录根部 `index.html`。
- Terminal 入口：顶部 `...` 菜单中的 `Prototypes`。
- 列表接口：`GET /api/terminal/prototype-gallery`。
- 票据接口：`POST /api/terminal/project/:id/prototype/:slug/preview-ticket`。
- 静态路由：`GET|HEAD /prototype-preview/:ticket/:projectId/:prototypeSlug/*`。
- 至少准备两个都含原型的已登记项目，并确保它们至少有一个相同 slug；另准备一个 project path 为空或无 `docs/prototypes` 的项目。
- 不改动既有原型作为 fixture；目录数量和名称以执行时磁盘事实为准。

不覆盖原型自身全部业务交互、外部 CDN 可用性、原型编辑/发布、未登记仓库的自动发现和 App 移动端 UI。

## 必跑门禁

```bash
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/backend typecheck
pnpm --filter @runweave/backend lint
pnpm --filter @runweave/frontend typecheck
pnpm --filter @runweave/frontend lint
pnpm build
git diff --check
```

## 测试案例

### PGP-001 已登记项目与 gallery 项目一一对应

标签：gallery api project-discovery

依赖：Runweave 已登记至少三个不同状态的项目；已取得有效 access token。

步骤：

1. 请求 Terminal Project 列表，记录项目 id、名称和 path。
2. 请求 `/api/terminal/prototype-gallery`，记录 `projects`。
3. 按 project id 对照两份结果。

期望：

1. gallery 中项目数量、id、名称、path 与 Terminal Project 列表一致，顺序保持一致。
2. path 为空显示 `project-path-missing`；不存在 `docs/prototypes` 显示 `prototype-root-missing`；不可读或越界显示 `prototype-root-unavailable`；正常目录显示 `available`。
3. 单个项目异常不影响其他项目返回。

失败判定：任一已登记项目被漏掉、重复、错误归入另一个项目，或一个项目异常导致接口整体 500。

### PGP-002 原型发现、标题和入口状态符合磁盘事实

标签：gallery filesystem metadata

依赖：至少一个 `available` 项目；其 `docs/prototypes` 可读。

步骤：

1. 读取该项目 `docs/prototypes` 的一级真实目录并排序。
2. 对照 gallery 中该项目的 `prototypes[].slug/title/entry/files`。
3. 对有 `index.html`、只有 README、两者都没有的目录分别核对标题回退。

期望：

1. 一级目录与 `prototypes` 数量、slug 和顺序一致；symlink 逃逸目录不进入清单。
2. `entry` 仅在根部存在普通 `index.html` 时为 `index.html`，否则为 `null`。
3. 标题依次取 HTML title、README H1、slug；`files` 只列根部普通文件并排序。

失败判定：目录被静默漏掉、深层目录被当成独立原型、标题优先级或入口状态错误。

### PGP-003 Terminal 入口展示左右轮巡界面

标签：terminal sidecar playwright ui

依赖：frontend 与 backend 已启动；真实 Chromium 可访问 Terminal。

步骤：

1. 使用 `$toolkit:playwright-cli` 登录并打开 Terminal。
2. 点击顶部 `...`，选择 `Prototypes`。
3. 读取 Sidecar 顶部工具、左侧项目分组和右侧内容区 DOM。

期望：

1. Sidecar 打开且 `Prototypes` 为选中工具；`Preview`、`Browser` 保持可切换。
2. 左侧按项目分组展示全部已登记项目，项目内展示原型或明确空态。
3. 右侧展示当前原型标题、项目名、路径和 iframe/无入口空态。
4. 非 `Preview` 工具不显示 Save、Refresh preview、Copy path 等源码预览动作。

失败判定：需要额外启动原型服务、入口不可达、项目列表扁平化后无法区分来源，或 Preview 专属动作污染原型工具。

### PGP-004 跨项目点击与同 slug 隔离

标签：multi-project collision iframe playwright

依赖：两个项目包含至少一个相同 slug，且两个入口页面可通过标题或 DOM 区分。

步骤：

1. 在项目 A 点击共同 slug，读取选中项、右侧路径、iframe URL、title 和一个可区分 DOM 文本。
2. 在项目 B 点击同一 slug，重复读取。
3. 再点击第三个项目的另一原型。

期望：

1. 每次只有被点击项具有 `aria-current="page"`。
2. iframe URL 同时包含当前 project id 和 slug；项目切换时 URL 与内容同时改变。
3. 项目 B 不复用项目 A 的 HTML、脚本、mock 数据或选中状态。

失败判定：同 slug 发生串库、点击后右侧未更新、或列表选中项与 iframe 内容来源不一致。

### PGP-005 相对资源、MIME 与 iframe 隔离正确

标签：preview resources security playwright http

依赖：选择一个同时包含 HTML、JS、JSON 和图片资源的原型；已取得有效预览票据。

步骤：

1. 使用 `$toolkit:playwright-cli` 等待 iframe 主文档加载并读取其 DOM。
2. 请求同一票据路径下的入口、JS、JSON、图片和 HEAD。
3. 读取 status、Content-Type、Content-Length 与安全响应头。
4. 检查 iframe 的 `sandbox` 和 `referrerpolicy` 属性。

期望：

1. 主文档和本地相对资源返回 200，JS 为 JavaScript MIME、JSON 为 JSON MIME、图片为真实图片 MIME；HEAD 无响应体。
2. 响应包含 `Cache-Control: no-store`、`Access-Control-Allow-Origin: *`、`Cross-Origin-Resource-Policy: cross-origin`、`Referrer-Policy: no-referrer` 和 `X-Content-Type-Options: nosniff`。
3. iframe 仅含 `allow-scripts`，不含 `allow-same-origin`，并设置 `no-referrer`。

失败判定：本地相对资源 4xx/5xx、MIME 被识别为文件路径、iframe 获得父页面同源权限或关键安全头缺失。

### PGP-006 票据与文件路径边界不能跨项目或跨原型

标签：ticket authorization traversal http

依赖：项目 A、项目 B 都有同 slug；已为项目 A 签发票据。

步骤：

1. 用项目 A 票据请求项目 A 的入口。
2. 保持票据和 slug 不变，把 URL project id 换成项目 B。
3. 保持票据和 project id 不变，把 slug 换成另一个原型。
4. 请求不存在文件、编码后的父目录路径，并对有效资源发送 POST。

期望：

1. 原始资源返回 200；换 project id 或 slug 返回 401。
2. 不存在文件和路径逃逸不返回任何 prototype root 外文件，状态为 4xx。
3. POST 返回 405，`Allow` 为 `GET, HEAD`。

失败判定：票据可跨项目/原型复用、路径逃逸返回项目文件、或静态路由接受写入方法。

### PGP-007 缺入口和项目异常显示明确空态

标签：empty-state resilience playwright

依赖：至少存在一种项目异常状态；若存在无 `index.html` 原型则同时验证该项。

步骤：

1. 用 `$toolkit:playwright-cli` 查看异常项目分组。
2. 如有无入口原型，点击该项并读取右侧内容。
3. 确认其它正常项目仍可点击和预览。

期望：

1. 项目分别显示 `Project path is not set`、`No docs/prototypes directory`、`Prototype directory is unavailable` 或 `No prototypes`。
2. 无入口原型显示 `No index.html entry` 和一级文件，不创建 iframe、不申请可用票据。
3. 异常项不阻断其它项目。

失败判定：异常项目消失、右侧白屏、错误状态互相混淆，或整个轮巡库不可用。

### PGP-008 选择持久化、刷新和请求竞态收敛

标签：selection refresh race playwright

依赖：至少两个项目各有可运行原型。

步骤：

1. 选择非默认项目中的一个原型，切到 `Preview` 再切回 `Prototypes`。
2. 关闭 Sidecar，通过顶部菜单重新打开 `Prototypes`。
3. 点击“刷新原型库”和“重新加载当前原型”。
4. 快速连续点击两个不同原型，等待请求完成。

期望：

1. 工具切换和 Sidecar 重开后恢复同一个 `{projectId, slug}`。
2. 刷新列表后选择仍有效；重新加载后 iframe 内容来源不变但使用新票据 URL。
3. 快速点击最终显示最后一次选择，较早请求不能覆盖新选择。

失败判定：选择只按 slug 持久化导致串项目、重开后回到错误项目、或旧 ticket 响应覆盖最后点击。

### PGP-009 鉴权与质量门禁

标签：auth quality-gate build

依赖：可分别构造无 access token、无效 token 和有效 token 请求。

步骤：

1. 无 token 和无效 token 请求 gallery 与 ticket API；有效 token 重试。
2. 执行本文“必跑门禁”全部命令。
3. 用新的 `$toolkit:playwright-cli` session 重复 PGP-003 至 PGP-005 的核心路径并检查 console error。

期望：

1. 鉴权 API 拒绝无效身份；有效身份可列清单和签发资源绑定票据。
2. 全部门禁退出码为 0。
3. 干净浏览器 session 无本功能导致的 console error；真实 iframe 内容与选中来源一致。

失败判定：未鉴权可枚举本地项目路径或签发票据、任一门禁失败，或仅用静态检查代替浏览器验收。
