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
- 首屏采用用户选定的第一张修订稿“网站开发与交付”：[hero-website.png](src/assets/hero-website.png)。来源为 `artifacts/website-hero-options/01-website-v2.png`，以真实桌面和 iOS 界面为参照，经 AI 编辑制作。横向项目标签、终端排版与产品结构对齐；电脑执行页面开发、手机补充安装步骤要求，均为同一示例任务的内容示意，不是实际执行或跨端验收证据。图片保留完整比例，转换为响应式 WebP；点击可查看 1536px 大图。
- 文件附件流程仍使用独立的历史验证案例 `rw-file-paste-check`：[桌面 Beta](src/assets/desktop-real.png) 来自 `artifacts/file-paste-desktop-beta.png`；[iOS 附件草稿](src/assets/ios-real.png) 来自 `artifacts/mobile-file-attachment-draft.png`；[iOS 附件输出结果](src/assets/ios-result.png) 来自 `artifacts/mobile-file-attachment-sent.png`。这不是首屏“网站开发”示例的实际运行记录，也不宣称同一 Agent 自动完成或本轮重新采集手机素材。
- 首屏隐私与内容检查：仅含公开官网、示例项目、`studio-mac` 与 `alex · workspace` 示例名称、构建命令及示意输出；无凭据、内部网址或用户业务材料。无 Beta 标记、公司名称、默认项目和虚构下拉菜单。
- 三个配套产品的小图是 CSS 绘制的装饰示意，均从可访问树中移除；名称与介绍是 HTML。
- [分享图](public/og.png) 使用同一真实桌面 Beta 截图，品牌图标与 [favicon](public/logo.png) 共用桌面端图标，由 `electron/resources/icons/icon-preview.png` 等比缩小为 128 × 128 PNG。

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

沿用产品的 Microsoft Clarity 官方 Web 自动采集，使用独立项目 [Runweave Website](https://clarity.microsoft.com/projects/view/zc99skixyj/dashboard)，公开项目 ID 为 `zc99skixyj`，不复用 Web/Electron 或 iOS 项目。项目登记地址已同步为 AWS 正式入口 `https://runweave.jackshen310.cn`；迁移域名时同时更新项目概述和 `WEBSITE_SITE_URL`。

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

## AWS 当前部署

官网入口为 **https://runweave.jackshen310.cn/**，教程为 [/start/](https://runweave.jackshen310.cn/start/)。Cloudflare 中 `runweave` 的 A 记录指向 AWS `18.140.158.81`，仅 DNS、TTL 自动。Nginx 直接托管静态文件，无需 Node 进程。

`share.jackshen310.cn` 恢复为分享专用域名，根路径为 404；`/share/terminal` 与 `/api/snapshot-shares` 沿用原代理配置。临时官网入口已撤下，没有把签名分享 URL 重定向到官网。Backend 和 App Server 未修改或重启。

生产构建独立输出，不能直接发布本地预览产物：

```bash
WEBSITE_ENV=production WEBSITE_SITE_URL=https://runweave.jackshen310.cn \
  pnpm --filter @runweave/website build --outDir /tmp/runweave-website-domain-dist
```

本机 4321 仍提供预览，保留 noindex 与 Clarity 排除；生产首页和教程不含 noindex，canonical、OG、robots、sitemap、llms.txt 与 AI 指令使用正式域名。账号初始化示例中的 `127.0.0.1:5001` 是用户本机 Server 地址，保留该值。

服务器目录与配置：

- `/var/www/runweave-website/releases/<release>/`：完整静态产物；发布后不原地覆盖。
- `/var/www/runweave-website/current`：Nginx 使用的版本符号链接。
- `/var/www/runweave-website/deployments/<release>/manifest.json`：源提交、构建输入与逐文件 SHA-256；首次临时版记录只有源提交与域名。
- 同目录 `runweave-share.conf.before`、`runweave-website.conf.before` 与 `previous-release`：本次迁移前配置和版本指针。
- `/etc/nginx/conf.d/runweave-website.conf`：独立官网虚拟主机，源码见 [nginx-site.conf](deploy/nginx-site.conf)。
- `/etc/nginx/snippets/runweave-website.conf`：静态路由，源码见 [nginx-static.conf](deploy/nginx-static.conf)。
- `/etc/letsencrypt/live/runweave.jackshen310.cn/`：正式域名证书，当前到期日 2027-02-10；续期使用 webroot `/var/www/runweave-website-acme`，现有 `snap.certbot.renew.timer` 负责调度，成功后检查并重载 Nginx。没有手动读取或复制私钥。

HTML、纯文本、站点地图和 404 使用 `Cache-Control: no-cache`；带 hash 的 `/_astro/` 使用 `public, max-age=31536000, immutable`。未知路径为真实 HTTP 404 并展示本版本 404.html，不使用 SPA fallback。HTTP 入口固定跳转本域名 HTTPS，ACME challenge 单独保留。

后续发布先上传新版本并按 manifest 核对，再原子切换 `current`，保留旧目录；切换后核对 `/`、`/start/`、两份 AI 文本、SEO、全部公开资源、缓存头及未知路径，并检查分享接口未被官网接管。

正式域名的已验证回滚基线是 `20261112T030802Z-e2570f71`。[rollback-version.py](deploy/rollback-version.py) 默认只读预检：要求 manifest 的 release、正式域名、文件集合与全部 SHA-256 匹配，并拒绝 release 内的符号链接。临时 share 版会被拒绝，不能混用其 SEO。只有显式 `--apply` 才原子替换 current；已指向该版本时不作修改。

从仓库根目录执行（先预检；后续发布需要恢复此基线时才加 `--apply`）：

```bash
scp packages/website/deploy/rollback-version.py ubuntu@18.140.158.81:/tmp/runweave-website-rollback-version.py
ssh ubuntu@18.140.158.81 \
  'python3 /tmp/runweave-website-rollback-version.py 20261112T030802Z-e2570f71'
# 实际切换：
ssh ubuntu@18.140.158.81 \
  'sudo python3 /tmp/runweave-website-rollback-version.py 20261112T030802Z-e2570f71 --apply'
```

切换后按本节列出的站点、资源、缓存与分享路径检查，不以命令返回值替代线上验证。脚本只恢复静态版本，不改 DNS、TLS、Nginx 配置或 Clarity 项目。当前保留多个正式域名版本；首屏更新发布已使用 `--apply` 原子切换到新版本，旧版本仅执行只读回滚预检，未执行在线回滚演练。

纯版本切换无需重启服务。当前正式版本为 `20261112T043238Z-06aaad89`，保留上一正式版 `20261112T030802Z-e2570f71` 及临时版本 `20261112T021514Z-91f82e46`。临时版本的 SEO 使用 share 域名，不能仅切换版本就声称完成正式域名回退。若要撤销本次域名迁移，先备份当时配置，恢复本次部署备份中的两个 Nginx 配置和 previous-release 指针，再 `sudo nginx -t && sudo systemctl reload nginx`；此操作会恢复临时 share 入口，必须连同域名与 Clarity 变更一起判断。未实际执行在线回滚演练。

2026-11-12 迁移核对：新域名 HTTPS 正常，证书 SAN 与域名匹配；19 个线上文件逐一匹配本次 manifest，包括按 404 返回的内部页面；正式 SEO 与缓存头核对通过。share 根路径恢复 404、原分享路由仍由原服务响应。当前版本和旧版本均保留，迁移前配置备份实际存在。Clarity 后台网站 URL 已保存并刷新读回为正式入口。Runweave Browser 实际打开新域名，点击首页 CTA 到教程并成功复制 AI 指令；390px 首页和教程无横向溢出，图片实际加载，控制台无错误。正式页各一个 Clarity tag，collect POST 返回 204；新域名的云端录制回放未单独核验。

浏览器专项仍有验收阻塞：当前代理不能取得所需页面级 CDP session，禁用 JavaScript 未执行；缩放快捷键未改变实际 viewport/DPR，CLI 无原生 zoom 控制，200% 缩放未执行。最小解锁动作是在同一 Browser 人工设置后交回复核，或由宿主提供对应控制能力。静态 HTML、CSS zoom 和响应式宽度检查不替代这两项验收。

迁移证据的长期源位于服务器 `/var/www/runweave-website/deployments/20261112T030802Z-e2570f71/manifest.json`：记录 production 构建输入、源提交 `e2570f71` 与 19 个文件的 SHA-256。版本 `20261112T030802Z-e2570f71` 是新域名构建，临时版本 `20261112T021514Z-91f82e46` 完整保留。当前机器上的逐路由 HTTP 状态、实际缓存头、SEO、浏览器交互与专项阻塞明细见 `artifacts/website-domain-migration.json`（本地验收附件，不作为应用配置或自动发布输入）。

### 首屏图片更新（2026-11-12）

用户选定第一张修订稿“网站开发与交付”，已发布版本 `20261112T043238Z-06aaad89`。生产源来自提交 `06aaad89e28a82baf3e22e68adf549fb28398088` 的网站包，加本轮 `Hero.astro`、`pages.css` 和 `hero-website.png` 三个文件覆盖；不包含工作区独立的品牌图标改动。隔离源码位于 `/private/tmp/runweave-website-hero-source/packages/website`，生产输出为 `/private/tmp/runweave-website-hero-dist`，未覆盖 4321 预览产物。

服务器 `deployments/20261112T043238Z-06aaad89/manifest.json` 保存构建输入、覆盖文件清单、源码及 16 个产物文件的 SHA-256；`previous-release` 与 `activation.json` 保存切换前后指针。发布前校验完整文件集合，随后原子切换 current；上一正式版仍可用上节回滚命令恢复，不改 DNS、TLS、Nginx 或运行中的服务。

检查结果：lint 通过，隔离源码 `astro check` 为 0 错误、0 警告，production 构建通过（依赖 Zod 注释有 Rollup 提示，不影响输出）。最初以 macOS `/tmp` 别名作为 Astro root 导致虚拟模块路径不一致；改用实际 `/private/tmp` 路径后构建通过，失败产物未发布。16 个线上文件与 manifest 逐一匹配，HTML no-cache、哈希资源 immutable，正式 canonical 与首屏内容正确，未知路径 404。响应式 WebP 为 480/720/1080/1536px，完整大图约 101 KB。

Runweave Browser 已实际检查同一生产产物的本地 1440px 与 390px 布局：图片加载成功、页面无横向溢出。正式首页 1440px 的图片加载、按钮无遮挡、大图点击与教程入口已通过；点击大图可打开 1536 × 1024 图片。正式页面调用 resize 后实际 innerWidth 仍为 1440，线上 390px 专项未通过工具执行，不能把本地宽度检查称为线上手机或真机验收。截图接口在本机与正式页均于 5 秒超时，未取得本轮网页截图；DOM 与交互证据保存在 `artifacts/website-hero-live-*.json`，HTTP 证据为 `artifacts/website-hero-live-checks.json`。禁用 JavaScript 与原生 200% 缩放仍保持上节阻塞状态。
