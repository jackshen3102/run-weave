# Runweave 官网

独立的中文静态官网，使用 Astro 6、TypeScript 和 CSS。工程使用仓库的 Node 22（至少 22.12）与 pnpm 10.6.2，不依赖 Backend 或登录；交互脚本用于复制命令，正式站额外异步加载 Clarity；正文在无 JavaScript 时仍可阅读。

## 本地开发

项目已关闭 Astro Dev Toolbar，本地开发页不会显示底部调试悬浮条；正式静态构建本身不包含此工具栏。

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
- 首屏采用用户选定的第一张修订稿“网站开发与交付”：[hero-website.png](src/assets/hero-website.png)。来源为 `artifacts/website-hero-options/01-website-v2.png`，以真实桌面和 iOS 界面为参照，经 AI 编辑制作。横向项目标签、终端排版与产品结构对齐；电脑执行页面开发、手机补充安装步骤要求，均为同一示例任务的内容示意，不是实际执行或跨端验收证据。素材已移除顶部“Runweave｜01 网站开发与交付”标题；首页显示时收起顶部 130px 留白，保留完整产品画面和底部示意标注。素材转换为响应式 WebP；点击可查看无标题的 1536px 大图。
- 官网围绕电脑上的项目、终端与 Agent 工作台展开，多后端连接为主要能力，手机作为补充入口。已删除“工作方式”三步区域及对应导航；不再用离开电脑、通勤或文件附件测试作为首页价值叙事。原文件附件截图仅作历史素材保留，不在当前首页引用。
- 首屏隐私与内容检查：仅含公开官网、示例项目、`studio-mac` 与 `alex · workspace` 示例名称、构建命令及示意输出；无凭据、内部网址或用户业务材料。无 Beta 标记、公司名称、默认项目和虚构下拉菜单。
- 三个配套产品采用选定的 B 版局部聚焦构图：[随记](src/assets/product-notes.webp) 参照已有 iOS 卡片列表截图，[屏幕日记](src/assets/product-journal.webp) 参照 Mac 回放界面并将录屏内容替换为公开官网示例，[远程桌面](src/assets/product-remote.webp) 参照已有横屏手机模拟素材。均经 AI 编辑制作，属于界面与内容示意，不是原始实拍或运行验收证据；页面保留“界面示意”说明与图片替代文本。素材不含用户业务内容，采用响应式 WebP 和懒加载，名称与介绍仍为 HTML。
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

纯版本切换无需重启服务。当前正式版本为 `20261112T103418Z-198f5fac`，保留上一正式版 `20261112T030802Z-e2570f71` 及临时版本 `20261112T021514Z-91f82e46`。临时版本的 SEO 使用 share 域名，不能仅切换版本就声称完成正式域名回退。若要撤销本次域名迁移，先备份当时配置，恢复本次部署备份中的两个 Nginx 配置和 previous-release 指针，再 `sudo nginx -t && sudo systemctl reload nginx`；此操作会恢复临时 share 入口，必须连同域名与 Clarity 变更一起判断。未实际执行在线回滚演练。

2026-11-12 迁移核对：新域名 HTTPS 正常，证书 SAN 与域名匹配；19 个线上文件逐一匹配本次 manifest，包括按 404 返回的内部页面；正式 SEO 与缓存头核对通过。share 根路径恢复 404、原分享路由仍由原服务响应。当前版本和旧版本均保留，迁移前配置备份实际存在。Clarity 后台网站 URL 已保存并刷新读回为正式入口。Runweave Browser 实际打开新域名，点击首页 CTA 到教程并成功复制 AI 指令；390px 首页和教程无横向溢出，图片实际加载，控制台无错误。正式页各一个 Clarity tag，collect POST 返回 204；新域名的云端录制回放未单独核验。

浏览器专项仍有验收阻塞：当前代理不能取得所需页面级 CDP session，禁用 JavaScript 未执行；缩放快捷键未改变实际 viewport/DPR，CLI 无原生 zoom 控制，200% 缩放未执行。最小解锁动作是在同一 Browser 人工设置后交回复核，或由宿主提供对应控制能力。静态 HTML、CSS zoom 和响应式宽度检查不替代这两项验收。

迁移证据的长期源位于服务器 `/var/www/runweave-website/deployments/20261112T030802Z-e2570f71/manifest.json`：记录 production 构建输入、源提交 `e2570f71` 与 19 个文件的 SHA-256。版本 `20261112T030802Z-e2570f71` 是新域名构建，临时版本 `20261112T021514Z-91f82e46` 完整保留。当前机器上的逐路由 HTTP 状态、实际缓存头、SEO、浏览器交互与专项阻塞明细见 `artifacts/website-domain-migration.json`（本地验收附件，不作为应用配置或自动发布输入）。

### 首屏图片更新（2026-11-12）

用户选定第一张修订稿“网站开发与交付”，已发布版本 `20261112T043238Z-06aaad89`。生产源来自提交 `06aaad89e28a82baf3e22e68adf549fb28398088` 的网站包，加本轮 `Hero.astro`、`pages.css` 和 `hero-website.png` 三个文件覆盖；不包含工作区独立的品牌图标改动。隔离源码位于 `/private/tmp/runweave-website-hero-source/packages/website`，生产输出为 `/private/tmp/runweave-website-hero-dist`，未覆盖 4321 预览产物。

服务器 `deployments/20261112T043238Z-06aaad89/manifest.json` 保存构建输入、覆盖文件清单、源码及 16 个产物文件的 SHA-256；`previous-release` 与 `activation.json` 保存切换前后指针。发布前校验完整文件集合，随后原子切换 current；上一正式版仍可用上节回滚命令恢复，不改 DNS、TLS、Nginx 或运行中的服务。

检查结果：lint 通过，隔离源码 `astro check` 为 0 错误、0 警告，production 构建通过（依赖 Zod 注释有 Rollup 提示，不影响输出）。最初以 macOS `/tmp` 别名作为 Astro root 导致虚拟模块路径不一致；改用实际 `/private/tmp` 路径后构建通过，失败产物未发布。16 个线上文件与 manifest 逐一匹配，HTML no-cache、哈希资源 immutable，正式 canonical 与首屏内容正确，未知路径 404。响应式 WebP 为 480/720/1080/1536px，完整大图约 101 KB。

Runweave Browser 已实际检查同一生产产物的本地 1440px 与 390px 布局：图片加载成功、页面无横向溢出。正式首页 1440px 的图片加载、按钮无遮挡、大图点击与教程入口已通过；点击大图可打开 1536 × 1024 图片。正式页面调用 resize 后实际 innerWidth 仍为 1440，线上 390px 专项未通过工具执行，不能把本地宽度检查称为线上手机或真机验收。截图接口在本机与正式页均于 5 秒超时，未取得本轮网页截图；DOM 与交互证据保存在 `artifacts/website-hero-live-*.json`，HTTP 证据为 `artifacts/website-hero-live-checks.json`。禁用 JavaScript 与原生 200% 缩放仍保持上节阻塞状态。

### 恢复静态展示（2026-11-12）

用户撤回视频方案后，已恢复提交 `f23370c0` 的静态工作方式区域，首屏仍使用选定的第一张修订稿。视频组件、播放逻辑和视频资产已从网站源码与生产产物中移除；原视频及生成脚本仅归档到本机 `artifacts/website-workflow-video/reverted-source/`，不随网站发布。

当前发布 `20261112T065014Z-f23370c0`，独立 production 输出 `/private/tmp/runweave-website-static-restored-dist`。lint、astro check 与构建通过；16 个线上文件与 manifest 一致，首页无 video 元素或 MP4 引用，原首屏图片与静态流程均已恢复。服务器对应 deployments 目录保留 manifest、previous-release 和 activation.json；被撤回的视频版 `20261112T064431Z-f23370c0` 仅作历史保留，不应作为默认回退目标。HTTP 核对记录为 `artifacts/website-static-restored-checks.json`。

### 电脑工作台定位（2026-11-12）

版本 `20261112T065723Z-f23370c0` 删除工作方式区域、组件和导航链接；首页、页尾、多机连接、教程入口及 SEO 文案统一强调电脑上的项目、终端、Agent 与多后端工作。手机连接仍可用，作为补充入口介绍；保留用户选定的首屏图。

lint、astro check、production build 通过。15 个线上文件 SHA-256 与 manifest 一致，首页不含 workflow 锚点、视频或“离开／路上”宣传。Runweave Browser 已核对 1440px/390px 首页无横向溢出、原图加载、页内锚点无失效目标，快速开始导航实际可用。部署目录保存 manifest、previous-release、activation.json，上一版 `20261112T065014Z-f23370c0` 保留。本机证据为 `artifacts/website-desktop-focus-checks.json` 与同前缀桌面／手机宽度截图；不代替原生手机、禁用 JavaScript 或 200% 原生缩放验收。

### 首屏图片去标题（2026-11-12）

版本 `20261112T093641Z-f23370c0` 去掉素材顶部外置标题，页面通过固定比例容器收起 130px 留白。终端、浏览器预览、手机及底部示意说明保留；源素材为本轮图片编辑结果 `exec-89d37faa-bd18-41d2-844b-282616a009d4.png`，原图仍在 `artifacts/website-hero-options/01-website-v2.png`。lint、astro check 与生产构建通过，15 个线上文件逐一匹配 manifest。Runweave Browser 已核对 1440px/390px 显示及图片加载，截图为 `artifacts/website-no-heading-desktop.png`、`artifacts/website-no-heading-mobile.png`。上一版 `20261112T065723Z-f23370c0` 完整保留；本轮 manifest、activation 和 previous-release 位于对应服务器 deployments 目录。

### 配套工具文案（2026-11-12）

版本 `20261112T095754Z-f23370c0` 将“更多产品”栏目及导航改为“配套工具”，标题明确为“记录想法、回看屏幕、远程操作电脑”。以当前线上版 `20261112T093641Z-f23370c0` 的已校验源码为基线隔离构建，未发布工作区另一组使用方式改动；生产文件仅 `index.html` 发生变化。lint、astro check、build 通过，线上 HTML 哈希和文案已核对，1440px/390px Browser 布局无横向溢出，证据见 `artifacts/website-product-copy-*`。服务器对应 deployments 目录保留 manifest、previous-release 和 activation.json。

### 页脚导航（2026-11-12）

版本 `20261112T101704Z-198f5fac` 删除首页重复的大标题和行动按钮，页脚改为产品简介、开始使用、文档与支持，以及 MIT 许可证和源码入口；页脚位于 main 之外。保留已确认的配套工具文案。构建来自提交 `198f5fac` 加本轮 Footer、index 和 Products 改动，production 输出为 `/private/tmp/runweave-website-footer-dist`；构建输入与源文件哈希见服务器对应 deployments 目录的 manifest.json。本版本不包含随后工作区正在进行的配套产品图片改动。

lint、typecheck、production build 通过；15 个公开文件逐一匹配 manifest，HTML 和文本 no-cache、哈希资源 immutable。Runweave Browser 已检查正式站 1440px 和 390px 无横向溢出、页脚链接点击区域不小于 44px，并实际点击“让 AI 帮你安装”进入 `/start/#agent`。部署指南、使用文档、许可证及问题反馈链接均返回 HTTP 200。截图为 `artifacts/website-footer-live-desktop.png`、`artifacts/website-footer-live-mobile.png`，后者是浏览器手机宽度检查，不是真机验收。禁用 JavaScript 与原生 200% 缩放维持上述阻塞状态。

发布前校验全部文件，再原子切换 current；上一版 `20261112T095754Z-f23370c0` 保留，可使用上节 rollback-version.py 命令替换 release 参数恢复。服务器 deployments 目录保存 manifest.json、previous-release、activation.json 和 verification.json；本机 HTTP 与浏览器记录为 `artifacts/website-footer-checks.json`。本轮未改 DNS、TLS、Nginx 配置或重启服务，未执行在线回滚演练。

### 深浅外观（2026-11-12）

版本 `20261112T103418Z-198f5fac` 为首页、快速开始和 404 页统一提供浅色、深色、跟随系统三种模式，默认跟随系统。页头原生选择框支持键盘操作；手动选择保存在本站 localStorage 的 `runweave-website-theme`，选择“跟随系统”删除覆盖值。head 内初始化脚本在正文前恢复选择，监听系统偏好和同源 storage 变化。存储不可用时当前页面仍可切换；CSS 媒体查询提供无脚本的系统配色，选择器仅在脚本初始化后显示。无脚本设计已落实，但仍不声称完成禁用 JavaScript 专项运行验收。

配色集中在 `src/styles/theme.css`；导航、按钮、分隔线、页脚、教程代码框与复制按钮共用颜色变量，产品截图保持原貌。正文、辅助文字、强调色和主按钮文字的静态配色对比度均不低于 4.5:1。本轮隔离源码 `/private/tmp/runweave-website-theme-source/packages/website` 保留上一生产版的配套工具内容与布局，不包含工作区独立进行的产品图片改动；生产输出 `/private/tmp/runweave-website-theme-dist`，未覆盖已有开发预览。manifest 保存源文件哈希和正式构建输入。

lint、astro check（0 错误、0 警告）及 production build 通过。正式站 Browser 已实际验证系统浅色/深色动态跟随（媒体模拟）、手动选择优先于系统、刷新记忆、导航到教程及 404 的配色一致性、恢复系统模式后清除保存值。首页与教程分别在两种配色下检查 320/390/768/1440px，无横向溢出。系统偏好通过浏览器媒体模拟验证，未改宿主 OS 设置；手机宽度检查不等于真机验收。禁用 JavaScript 与原生 200% 缩放仍保留前述工具阻塞。

15 个公开文件与 manifest 完全匹配，HTML/文本 no-cache、哈希资源 immutable；原子切换后保留上一版 `20261112T101704Z-198f5fac`，需要回滚时使用上节 rollback-version.py 命令并替换 release 参数。服务器对应 deployments 目录保留 manifest.json、previous-release、activation.json、verification.json。本机证据为 `artifacts/website-theme-checks.json`，正式站浏览器截图为 `artifacts/website-theme-live-dark.png`、`artifacts/website-theme-live-light.png`。本轮不修改 DNS、TLS、Nginx 配置，无服务重启或在线回滚演练。
