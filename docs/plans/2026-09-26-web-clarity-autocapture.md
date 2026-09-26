# Web 首期 Clarity 纯无埋点实施计划

日期：2026-09-26。粒度：L2。状态：待实施，当前只交付计划与测试案例。
随记记录：`6eb2e507-908d-4d74-83dc-08855a016be8`。

## 目标与决策

接入 Microsoft Clarity 免费托管服务，通过自动记录普通 Web 页面的点击、导航、滚动和动态界面，辅助发现入口难找、重复操作和路径绕行等体验问题。

首期只做一次全局脚本初始化和部署配置。业务组件不用知道 Clarity 存在。**不增加手工事件，不增加 analytics 或 Clarity 元素属性，不做终端、编辑器、Canvas、iframe 或其他组件的专门适配。** 没有充分理由引入手工埋点，本计划不申请这一例外。

用户可见行为保持原样，无新按钮、统计面板或录制提示流程。分析者在 Clarity 官方后台查看会话、回放和受支持的热力图。点击只表示一次交互，不等于业务成功；本期不定义功能完成率、跨设备身份或业务事件模型。

不接 PostHog/Mixpanel，不自建采集服务，不接诊断日志，不新增 Backend API、数据库、共享 DTO、原生 iOS 或 Electron 采集，不实现平台切换抽象、离线上报队列、定时重试或自定义录屏。

## 当前代码事实与差异

- [frontend/src/main.tsx](../../frontend/src/main.tsx) 是 Web 与 Electron renderer 的共同主入口；装配 `ThemeProvider`、`BrowserRouter`、`App`，另有仅开发/Beta 使用的 `browser-overlay-harness` 分支。没有分析 SDK 初始化。
- [frontend/src/App.tsx](../../frontend/src/App.tsx) 使用 React Router，包含 `/login`、`/home`、`/terminal`、`/activity` 等路由；通过 `window.electronAPI?.isElectron === true` 判断桌面宿主。不能无条件在共同入口插入第三方采集脚本。
- [PWA 注册](../../frontend/src/features/pwa/registration.ts) 已有“普通 http/https 页面、排除 Electron”的局部判断模式，可参考，不重构它。
- [frontend/companion.html](../../frontend/companion.html) 使用独立的 `companion-main.tsx`。首期不在该入口接入。
- [HomeHeader](../../frontend/src/pages/home/components/home-header.tsx) 有主题切换、Change Password、Activity 等现成普通 DOM 操作；[工作区 Header](../../frontend/src/components/terminal/workspace/header.tsx) 有 `More actions` 动态菜单；[运行状态面板](../../frontend/src/components/runtime-status-panel.tsx) 有 `overflow-y-auto` 内层容器。它们是验收对象，不是改造范围。
- [frontend/package.json](../../frontend/package.json) 尚无 Clarity/PostHog/Mixpanel 依赖。使用项目官方脚本安装方式即可，无需为此增加 npm SDK 和锁文件改动。
- [frontend/src/vite-env.d.ts](../../frontend/src/vite-env.d.ts) 目前仅引用 Vite 类型。本期新增的构建配置应补类型声明及部署说明。

上一轮实测证明：固定版本 `clarity-js 0.8.71` 在普通 DOM 验证页能自动采集动态点击、SPA 变化和内层滚动，官方本地回放库能恢复界面。本计划使用正式项目的托管脚本；实际下发版本、远程配置、云端入库和 Runweave 页面表现仍需验收，不能沿用本地实验的“通过”。

## 接入合同

### 输入和启用条件

新增两个 Vite 构建时环境变量：

| 配置                      | 合同                                                                      |
| ------------------------- | ------------------------------------------------------------------------- |
| `VITE_CLARITY_ENABLED`    | 仅字符串 `true` 启用，其余值均关闭；未配置默认关闭                        |
| `VITE_CLARITY_PROJECT_ID` | 去除首尾空白后非空，限 ASCII 字母数字；来自 Clarity 正式项目，不设默认 ID |

同时满足以下条件才加载：配置有效、当前为 `http:` 或 `https:`、`window.electronAPI?.isElectron !== true`、不存在 Companion bridge、当前走正常主应用入口而非 overlay harness。生产、测试各自注入项目 ID；开发/Beta 默认不注入，验收环境显式启用并使用独立测试项目。

不增加 `PROD` 硬门槛，否则隔离开发环境无法验收。配置中 ID 是公开客户端标识，不是鉴权秘密；不向 Clarity 传 Runweave token、sessionId、connectionId 或用户自定义身份。仅存在项目 ID 不代表已启用，也不能证明该项目真实有效。

### 输出与生命周期

新增 `frontend/src/features/analytics/clarity.ts`，只公开 `initializeClarity(): void`。职责是读取配置、判断宿主、按官方安装片段建立队列并异步插入项目脚本；不公开业务 `track`、`identify` 或事件注册接口。

- 正常主入口调用一次，不放进页面组件 effect、按钮回调或 Router 监听中；不等待远端脚本再渲染 React。
- 使用固定 HTTPS 脚本地址 `https://www.clarity.ms/tag/<projectId>`，项目 ID 不能改变主机或注入任意 URL。沿用官方队列协议，不自行实现采集逻辑。
- 以当前 Document 为边界保证幂等：初始化重复调用、HMR 和 SPA 路由变化不重复插入项目 tag、不重复包装全局队列。完整刷新后新 Document 可以重新初始化。固定 script 标识只用于脚本生命周期，不是业务埋点标签。
- 项目脚本可能继续加载版本化脚本；“一次初始化”指项目 tag 一次，不要求整个 Clarity 只有一个网络请求。
- SDK 启动前的早期操作可能不被采集，不加补发事件。正式验收从 SDK 已加载后开始，并记录启动时间。
- 配置缺失或格式不合法时直接跳过；脚本阻断、失败或上传失败时应用仍可操作，不显示业务错误弹窗，不由应用轮询重试。刷新后可以重新尝试。SDK 内部网络策略保持官方行为，不承诺 SDK 绝不重试。
- 不改动 React Router、登录持久化、PWA 更新、主题或已有页面事件处理。

### 全局数据配置

在测试项目先设置 Clarity 的全局 Strict masking，正式项目采用同一配置；不配置逐元素 unmask，不新增 `data-clarity-*`。理由是已观察到默认模式会保留普通可见文本，产品页面可能包含用户内容，全局模式足以在不逐组件处理的前提下减少内容采集。

代价是按钮文字等内容也会被遮盖；通过布局、位置、动作时间与实际页面对照判读。如遮盖后回放不足以解释体验问题，应把“可用性不通过”作为选型结果，不擅自解遮盖或补手工事件。

Strict masking 不是 URL、所有 HTML 属性或 CSS 的通用清洗器。本期沿用产品现有 URL，不另造 URL 重写或终端专用过滤；用合成内容检查实际上传范围，发现不能接受的字段时保留关闭状态，不宣称全量脱敏。正式部署前记录项目当前 cookies/consent 设置；不伪造用户同意、不接自定义身份。若部署环境需要额外同意流程，沿用已经存在的流程；本期不顺带新建管理系统。

### 兼容、迁移与回滚

没有数据库迁移、后端鉴权或 API 合同变化。默认关闭保证未提供配置的已有部署行为不变。

Vite 配置是构建时配置：修改服务器进程环境变量而不重新构建前端无效。关闭 `VITE_CLARITY_ENABLED`、重新构建并部署后，新打开或刷新页面不再初始化；**旧的已打开页面不会因此立刻停止**，需完整刷新或关闭。移除 DOM script 不能撤销已执行 SDK。紧急停止时使用部署层经验证的阻断方式或回滚构建并通知刷新，不实现未验证的 SDK stop API。

CDN 托管脚本不能假定固定为上一轮的 0.8.71；验收记录项目 tag、实际版本脚本 URL/版本以及时间。换构建、项目配置或 SDK 版本后，至少复验采集闭环和全局遮盖。

## 修改范围

| 路径                                                                   | 动作与职责                                               |
| ---------------------------------------------------------------------- | -------------------------------------------------------- |
| `frontend/src/features/analytics/clarity.ts`                           | 新增唯一全局初始化与幂等/宿主/配置判断                   |
| `frontend/src/main.tsx`                                                | 正常应用分支调用初始化，保留 harness 分支行为            |
| `frontend/src/vite-env.d.ts`                                           | 声明两个可选 Vite 配置值                                 |
| `frontend/docs/clarity-autocapture.md`                                 | 实施时新增：配置、正式项目设置、启停、生效边界和证据入口 |
| `frontend/AGENTS.md`                                                   | 实施时补一条文档入口，不复制详细配置                     |
| [测试计划](../testing/analytics/web-clarity-autocapture.testplan.yaml) | 本轮已编写的待实施行为合同                               |

若真实部署 CSP 阻止官方脚本或上传，只在已有部署配置中为实际观测到的必要域名最小放行，并记录对应位置；不能添加通配 `*`、关闭整站 CSP 或改写 SDK 上传代理。当前主前端源码未发现统一 CSP 配置，因此不预造一个配置文件；没有 CSP 限制就不改。

不修改业务按钮、终端目录实现、`packages/common`、Backend、Electron、App Server 或 iOS。保留实施时工作区已有的其他改动，不清理或覆盖。

## 实施顺序与验收

### 1. 准备正式可验证的项目

取得用户可访问的 Clarity 测试项目 ID、后台访问能力和隔离 Web 环境；确认项目设置、全局 Strict、cookies/consent 状态及 bot filtering。项目设置变化可能延迟生效，记录实际生效后的新会话。仅使用合成项目/文本，测试项目与正式流量分开。

Clarity 官方会过滤机器人流量；使用有界面的 Chrome，并在专用测试项目按需关闭 bot filtering，结束后恢复原设置。不要通过修改 UA 或伪造手工上报证明普通采集有效。没有后台访问能力时可以实现默认关闭的入口及本地验证，但云端用例必须记为 blocked，不能宣布接入验收完成。

交付：项目 ID 的配置位置、测试站点、版本、权限和设置记录，不在 Git 中保存后台登录凭据。

### 2. 完成最小接入

只修改上表文件，采用官方脚本加载方式。补齐配置默认值、宿主范围和文档。先检查实际差异没有 `capture/track/event/identify/set` 业务调用、没有 analytics 或 Clarity 元素标签、没有终端特殊分支。

运行以下仓库现有门禁，均要求退出码为 0：

```bash
pnpm --filter @runweave/frontend typecheck
pnpm --filter @runweave/frontend lint
pnpm --filter @runweave/frontend build
pnpm testplan:validate docs/testing/analytics/web-clarity-autocapture.testplan.yaml
pnpm docs:check
```

不新增单元测试，不使用当前没有 tracked spec 的 `test:e2e` 作为通过证据。

### 3. 真实 Web 与云端验收

按 [YAML 测试计划](../testing/analytics/web-clarity-autocapture.testplan.yaml) 执行。需要 Dev Session 时使用 `toolkit:runweave-dev-session`，浏览器使用 `toolkit:playwright-cli`，不得拿安装态 Desktop 的 CDP 代替目标 Web surface。Electron 排除项必须在实际测试实例验证，不能只注入假的 bridge 后声称桌面已通过。Companion 仅检查当前构建的独立 Web 入口不加载采集器，不要求本期验收原生 Companion 宿主。

各云端用例独立建立自己的合成会话，按开始时间、浏览器、URL、动作顺序定位后台记录。不为定位而添加自定义事件/身份。保持 cookies 策略一致，不要求 SDK 承诺跨设备身份。

本计划设置单个云端用例最长观测窗口为 30 分钟，轮询间隔不超过 60 秒；这是执行预算，不是厂商 SLA。窗口内缺少证据时停止计为未通过/待定位；无权限、机器人过滤、服务不可达等环境原因记 blocked，配置无误却缺失所承诺普通 DOM 行为记 fail。不能以请求 200、初始化成功、云端出现一条会话代替回放内容核对。

完成以下产品结果：在真实回放中辨认普通点击、动态菜单开关、导航顺序及内层滚动；至少能将一段操作准确对应到实际界面。提交会话链接、动作记录、必要截图和版本信息；不以 AI 摘要或总请求数代替原始证据。

### 4. 性能、降级与关闭验收

用同一源码、同一隔离 Backend 和合成数据，比较仅启用配置不同的两种构建；按同一浏览器/视口进行五组交替测量，每次重复打开/关闭同一动态菜单 30 次，以浏览器性能轨迹测量交互至下一次绘制，不用脚本总耗时冒充交互时延。

本计划提出的首期工程门槛：五组的 p95 交互延迟取中位数，启用后相对关闭基线的增量不得超过 `max(20ms, 基线的20%)`；所有动作仍完成、无 SDK 导致的页面未捕获异常。该阈值是拟定验收标准，不是已有测量结果。记录脚本与上传字节数、请求数及长任务，说明该单场景证据不能覆盖所有真实使用负载。无法取得可靠轨迹就记 blocked，不凭观感宣称“无影响”。

分别验证脚本无法加载、上传被阻断时普通 UI 仍可操作；验证关闭配置、重建部署并完整刷新后停止新采集。全局 masking 和范围隔离不通过时不得开启正式流量。

## 测试覆盖与明确不覆盖

配套 YAML 共 16 条：14 条 required、2 条全量回归扩展。覆盖配置缺省/非法输入、Web 单例生命周期、Electron/Companion 排除、云端普通点击/动态菜单/SPA/内层滚动、全局遮盖、脚本故障、上传故障、构建回滚、性能及纯无埋点范围检查。每条独立取证，不依赖上一条的会话或数据。

热力图可读性和 Firefox 作为扩展项，不影响“Chrome 上纯无埋点回放闭环”的基本范围。热力图只要求产品原生支持的普通页面点击，不要求 div 滚动热力图或动态菜单热力图。终端内部命令/输出、编辑器输入语义、Canvas/跨域 iframe、原生 iOS、Safari、长期留存及大规模吞吐不在首期验收承诺内；不为它们修改组件。

## 完成定义

- 代码范围符合纯无埋点，默认关闭且仅目标 Web 启用。
- 必需静态门禁及 14 条 required 用例通过；blocked 不能算通过。
- 云端回放对实际页面有可审阅证据，遮盖、降级和回滚结果明确；性能门槛有真实对照数据。
- 部署说明包含项目设置、构建时配置及旧页面回滚限制。
- 实现后是否合并/部署按当次授权执行；本轮只产出文件和格式校验，不执行实现或功能验收。
- 随记仅追加最终成果，未经用户明确确认不标记任务完成。

## 官方依据

- [Clarity 官方安装与验证](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-setup)：项目 tag、云端回放、collect 请求、bot filtering 和 cookies 设置。
- [全局 masking 模式](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-masking)：Strict、输入遮盖与设置生效边界。
- [热力图限制](https://learn.microsoft.com/en-us/clarity/heatmaps/heatmaps-features)：body 滚动图与动态区域限制。

这些文档描述厂商能力，不替代本项目的真实验收。
