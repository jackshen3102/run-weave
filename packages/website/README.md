# Runweave 官网

独立的中文静态官网，使用 Astro 6、TypeScript 和 CSS。工程使用仓库的 Node 22（至少 22.12）与 pnpm 10.6.2，不依赖 Backend 或登录；交互脚本用于复制命令，正式站额外异步加载 Clarity；正文在无 JavaScript 时仍可阅读。

## 本地开发

在仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm --filter @runweave/website dev --host 127.0.0.1 --port 4321
```

质量检查与静态预览：

```bash
pnpm --filter @runweave/website lint
pnpm --filter @runweave/website typecheck
pnpm --filter @runweave/website build
pnpm --filter @runweave/website preview --host 127.0.0.1 --port 4321
```

`typecheck` 使用 `astro check` 检查 Astro 模板与 TS；lint 使用仓库 ESLint 检查 TS/配置。设备图经过 Sharp 转换为响应式 WebP，不在浏览器加载原始大 PNG。`@emnapi/runtime` 是 Astro 模板检查工具所需的显式 peer。

## 内容和素材

- [首页数据](src/data/home.ts)：GitHub、中文使用指南和三个产品文档入口。
- [首页](src/pages/index.astro)：页面区域装配；各区域的真实正文在 `src/components/`。
- [全局样式](src/styles/global.css)：米白背景、橙色重点、桌面与手机布局。
- 首屏使用未经重绘的真实截图，由 CSS 排列：[桌面 Beta](src/assets/desktop-real.png) 来自本机 `artifacts/file-paste-desktop-beta.png`；[iOS 附件草稿](src/assets/ios-real.png) 来自 `artifacts/mobile-file-attachment-draft.png`；[iOS 附件输出结果](src/assets/ios-result.png) 来自 `artifacts/mobile-file-attachment-sent.png`。三张均属于 `rw-file-paste-check` 文件附件检查场景，页面流程统一为“检查项目文件 → 手机补充文件 → 查看终端输出”，不混用登录修复或旁聊场景。
- 这是同一验证任务的桌面／手机素材，不宣称同一终端会话或由同一 Agent 自动完成。桌面使用 shell 验证、手机展示附件输入与输出。页面标明历史实拍；手机当前不可连接，未声称本轮重新采集或当前版本跨端验收。
- 隐私检查：仅含测试目录、测试文件名、示例文件正文与产品控件；未包含凭据、内部网址、用户业务材料。原截图内容和比例未改变。
- 首屏与分享图不使用生成设备图；原设计参考保留在仓库根目录。
- 三个配套产品的小图是 CSS 绘制的装饰示意，均从可访问树中移除；名称与介绍是 HTML。
- [分享图](public/og.png) 使用同一真实桌面 Beta 截图，[favicon](public/favicon.svg) 为本站字标。

页面包含首页、`/start/` 快速开始和 404；首页的“开始使用”和“快速开始”均进入站内教程。`/agent-guide.txt` 提供 AI 可读指南，`/llms.txt` 提供发现入口。安装命令和纯文本指南共享 `src/data/quickstart.ts`；`CopyCode.astro` 渐进增强复制功能，失败时选中文本并提示手动复制。

教程以 npm Server 为最短使用入口，要求 Node 22.x，分别列出 macOS/Linux 和 Windows `.cmd` 命令。安装、账号初始化、前台启动、Agent 登录和手机网络连接分别说明。本轮不在用户环境重新安装或初始化服务。产品入口仍指向公开 README，没有虚构安装器或 App Store 链接。

## 构建环境

| 输入               | 合同                                                                          |
| ------------------ | ----------------------------------------------------------------------------- |
| `WEBSITE_ENV`      | `preview`（默认）或 `production`，其他值报错                                  |
| `WEBSITE_SITE_URL` | HTTP(S) 根地址，不含凭据、查询、片段和子路径；生产要求 HTTPS 且不是 localhost |

预览默认使用 `http://127.0.0.1:4321`，输出 noindex、禁止抓取的 robots，不生成 sitemap。生产缺少站点地址会报错，不允许部署此时残留的旧产物。

生产构建前，先将 `WEBSITE_SITE_URL` 设置为确认后的真实地址，再执行：

```bash
WEBSITE_ENV=production pnpm --filter @runweave/website build
```

不要把生产环境值硬编码到仓库。每次模式切换重新构建，产物为 `packages/website/dist/`。

## 静态托管

将整个 dist 作为站点根目录托管，无需 Node 服务。域名和托管平台由部署时提供，本包不自动修改 DNS 或上线。

- `/` 返回首页；未知路径返回 HTTP 404 并展示 `404.html`。不要配置 SPA 首页 fallback。
- HTML 使用短缓存或可重新验证缓存，带 hash 的 `/_astro/` 静态资源可长期缓存。
- 同一次构建的 HTML 与资源一起原子发布；保留上一版完整产物，回滚时切换整个版本。
- 生产 robots 指向 `/sitemap-index.xml`；站点地图包含首页和快速开始页，排除 404 与纯文本接口。
- 发布后分别确认 HTTPS、canonical/OG 域名、robots、sitemap、资源和未知路由状态码；真实搜索收录需要另行验证。

预览的 noindex 不能提供访问保密；仅使用可公开内容。

## 网站行为分析

沿用产品的 Microsoft Clarity 官方 Web 自动采集，使用独立项目 [Runweave Website](https://clarity.microsoft.com/projects/view/zc99skixyj/dashboard)，公开项目 ID 为 `zc99skixyj`，不复用 Web/Electron 或 iOS 项目。项目当前登记地址为本机预览 `http://127.0.0.1:4321`；正式域名确定后同步更新项目概述和 `WEBSITE_SITE_URL`。

- `WEBSITE_ENV=production` 的静态页面默认启用；Astro 开发模式、预览构建、404 和纯文本接口不采集。无前端框架、无新增 npm 依赖。
- `WEBSITE_CLARITY_ENABLED=false` 是构建时关闭开关；修改后重建并替换整份站点产物。变量只接受 true/false。preview 即使设为 true 也不加载采集器。
- `WEBSITE_CLARITY_PROJECT_ID` 可覆盖为单独验收项目；启用时仅允许非空 ASCII 字母数字。项目 ID 不是访问后台的凭据。
- 同一 Document 最多一个官方项目 tag，异步从 `https://www.clarity.ms/tag/<projectId>` 加载，不阻断正文、导航或复制功能；故障不重放点击或创建重试循环。
- 官方 SDK 自动记录页面访问、点击、滚动和回放。固定标签：`site=runweave_website`、`client=website`、`environment=production`，以及 `page=website_home` 或 `website_quickstart`。不自定义逐按钮事件，不上报剪贴板、命令内容、账号或业务标识；标签不包含查询参数与 hash。
- 页面 body 显式 `data-clarity-mask=true`，后台也设为 Strict。SDK 仍会按官方机制采集页面 URL 与匿名会话；不要把密码、token 或内部地址放到官网 URL 或素材中。本文不将标签的固定字段范围误称为 SDK 完全不收集其他数据。

代码入口：[Analytics.astro](src/components/Analytics.astro)、[公共布局](src/layouts/SiteLayout.astro)、[构建配置](astro.config.mjs)。初始化发生在 HTML head，首页与教程都是独立 Document，依赖正常导航自动采集，不手动伪造页面访问或成功事件。

验证分层：本地加载官方 SDK、collect 请求成功，只证明客户端上报链路；正式域名部署、Clarity 后台出现会话、实际回放可用分别核对。默认 4321 预览持续排除采集；生产模式验证在单独输出目录和临时本机服务执行，不覆盖用户预览。

本轮验证（2026-11-12）：独立生产构建在本机临时服务加载官方 SDK 0.8.77，首页与教程均只出现一个项目 tag，collect POST 返回 204；实际从首页进入教程并复制安装命令。Clarity 后台出现测试实时用户，打开实时录制后重建了教程结构，文本呈遮盖状态。此证据不替代正式域名上线后的普通浏览器验证；测试宿主是 Electron Browser，云端入口可能归一为 Electron，使用 site/page 标签区分。

显式关闭、预览强制开启仍排除、Astro dev 强制 production 配置仍排除、非法开关/项目 ID 拒绝均已检查。人为阻断 SDK 项目 tag 后，导航与复制不受影响（真实复制成功）；故障规则随后已移除。Astro 预渲染可能把同名环境变量暴露为字符串，入口显式归一 true/false 并独立检查生产/开发条件，不把字符串 false 当作启用。
