# Clarity 官方页面分类实施记录

状态：代码与隔离 Mac Stable 构建完成；云端分类筛选与热图仍待验收。2026-09-30。

## 实施范围

采用用户确认的官方 Custom Page ID 路径。集中观察实际显示的路由，通过 Identify API 设置固定分类；所需 Custom User ID 是当前 Document 内存中的随机 UUID，不持久化，也不传 Custom Session ID。没有添加手工页面事件、标签或逐按钮埋点；后续用户确认后补充了集中抽屉打开事件。

路由与认证占位按真实 App 状态分类，未知路由不发送。SDK 首次加载或 SPA 重启后重新应用最新分类，不积累历史导航队列、不增加重试定时器。既有 Stable/Web 启用与 Beta、Dev Session、Companion 排除逻辑保持原合同。完整运行说明见 [Clarity 自动采集](../../frontend/docs/clarity-autocapture.md)。

随记和隧道属于抽屉，按用户后续确认的简单方案，只发送 `surface_open_suiji` / `surface_open_tunnels` 打开事件，不改 hash、不当作新页面；SDK 未就绪时丢弃，不排队补发。Custom Page ID 不覆盖 Electron 原生 URL，也不创建 pageview；不能承诺顶级页面恢复真实路由或功能进入次数。若云端无法准确隔离页面，再评估集中事件方案，而不是修改 UA 或依赖 SDK 内部 URL 覆盖。

## 当前验证证据

- frontend typecheck、lint、docs:check、现有 YAML 格式校验和 diff whitespace 检查通过。
- 从当前源码打包隔离 macOS arm64 Stable App，覆盖验收项目 `yo6azwkf18`，独立 instance/config/user-data；未替换用户的 Stable 安装。
- 实际主窗口为 `runweave:` 协议，真实 Electron bridge 为 true，SDK `0.8.70`，项目 tag 始终只有一个。
- 用真实 UI 登录合成账号并执行终端列表、终端工作区、定时任务与返回。解码实际 collect 的 variable 事件，确认 `pageId` 分别为 `scheduled_tasks`、`terminal_workspace`，上传 HTTP 204；随机 ID 的 SDK 哈希在同一 Document 内一致。
- 独立验收项目出现当前会话并可打开云端实时回放，终端与侧栏布局可辨认、内容遮盖。云端回放尝试读取部分 `runweave:` JS 资源报未知协议，不能声称回放零错误。
- Custom Page ID 筛选已能在后台应用；当前实时列表提示不支持此筛选，归档筛选尚未返回新会话。云端索引与热图未验证前，不能把客户端上传当作页面级分析验收通过。

- 隔离 HTTP 静态生产构建的真实登录页（Terminal Browser，无 Electron bridge）上传 `pageId=login`；完整刷新后匿名 ID 的 SDK 哈希改变。拦截官方脚本后登录界面与输入继续工作。此项不代表普通 Chrome 全流程回归通过。

- 后续抽屉方案验证：隔离真实 Electron 使用当前生产 renderer（复用此前壳与后端包，重新 ad hoc 签名）执行随记及隧道各两次打开/关闭，包括快速连续开关及随记输入引起的 render。实际解码 collect event 24 各有两个对应事件，URL 保持 `/terminal`、tag 数量为 1。首次基于 React effect 的实现曾在快速开关漏一次，改为直接 store 订阅后同样操作通过。云端新抽屉事件时间线未单独验收，未安装或发布。

## 剩余验收

在独立验收项目中，以 `terminal_workspace` 与 `scheduled_tasks` 分别筛选归档录制、仪表板和热图，核对每个筛选实际包含的页面、会话和截图范围；明确会话包含语义与页面聚合语义。等待厂商索引最多 30 分钟，每次等待不超过 60 秒。处理尚未完成时记录待验收，不能发布为已完成。

覆盖普通 Web 的分类和新 Document 随机身份、快速导航/首次加载、SDK 不可用时交互、原有排除范围。现有 [自动采集验收合同](../testing/analytics/web-clarity-autocapture.testplan.yaml) 已允许应用自身的集中匿名分类，禁止验收脚本补发 identify 或事件来伪造产品证据；本轮未执行完整 20 条回归。

正式 Stable 安装、生产发布与 PR 合并尚未执行。历史数据不回填。回滚可移除集中导航观察器与分类调用，保留官方自动采集；完整刷新后生效。

## 补充研究：优先验证官方 Custom Page ID

用户要求进一步研究 Electron 官方方案后，修正实施优先级：先验证官方 Custom Page ID 能否满足页面分类，再决定是否需要下文的事件方案。不要直接把页面分析迁移到另一套 SDK。

- 微软已经实现 Electron 特定的本地样式内联回放，见已合并的 [PR #496](https://github.com/microsoft/clarity/pull/496) 和当前 [node.ts](https://github.com/microsoft/clarity/blob/master/packages/clarity-js/src/layout/node.ts)。2023 年“不支持 Electron”的旧回复不能作为今天完全不支持的结论。
- 官方 [Identify API](https://learn.microsoft.com/en-us/clarity/setup-and-installation/identify-api) 提供 custom-page-id；[Filters 文档](https://learn.microsoft.com/en-us/clarity/filters/clarity-filters) 明确支持 Custom Page ID 筛选，且筛选入口存在于 Dashboard、Recordings、Heatmaps。这是应先尝试的官方能力。
- 该接口要求 custom-id，custom-page-id 不能单独调用。试验若获实现授权，应使用仅存于当前 Document 内存的随机匿名 custom-id，不使用真实账号、设备标识或固定的本人身份值，不做跨设备/跨 Document 用户追踪。此项比原方案新增了匿名 custom identifier，是明确的采集合同变化；如果必须完全不调用身份接口，保留标签/事件方案。
- 路由映射继续用下文的固定 screen 枚举；先用真实隔离 Stable 验证“终端工作区→定时任务→终端工作区”在 Custom Page ID 筛选、回放和热图中的粒度。必须确认筛选是否只保留对应页面，还是包含页面的整个会话；无法准确隔离时不得当成页面聚合能力交付。官方接口源码只是写入变量，不重写 URL，也不凭空创建新 pageview。
- 随记是同一路由内的抽屉。Custom Page ID 改变不会自动保证生成新的 Clarity 页面段；抽屉仍需验证筛选是否混合底层界面，不能把抽屉开关等同于正式页面导航。页面实验通过后，再按需求决定面板事件是否必要。
- 尚未找到公开、受支持的 Electron page URL override 参数。相关 [覆盖 URL 功能请求 #422](https://github.com/microsoft/clarity/issues/422) 当前仍 open。当前 hosted SDK 仍有 Electron URL 归一化；Custom Page ID 不承诺让“顶级页面”直接显示真实路由。
- 移动 SDK 的 [setCurrentScreenName](https://learn.microsoft.com/en-us/clarity/mobile-sdk/ios-sdk) 不能当成 Electron Web SDK API 使用。社区 UA 修改建议不是微软针对页面 URL 的解决承诺；去掉 Electron 标记还会关闭现有的 Electron 样式适配，因此不作为推荐路径。
