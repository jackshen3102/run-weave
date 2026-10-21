# Web 与 Mac 桌面 Clarity 自动采集

普通 Web 与打包的 Mac Stable 主窗口默认加载 Microsoft Clarity。代码入口是 [clarity.ts](../src/features/analytics/clarity.ts) 与 [main.tsx](../src/main.tsx)。前端构建包含加载器和项目 ID；官方采集脚本运行时从微软下载。业务组件没有按钮事件或元素标签，点击不等于业务成功。

## 页面分类

[ClarityNavigationObserver](../src/features/analytics/clarity-navigation-observer.tsx) 直接读取 [App.tsx](../src/App.tsx) 交给 `<Routes>` 的同一份路由声明，按实际 location 匹配，通过官方 Identify API 设置 Custom Page ID。不再维护独立的路由白名单，新增普通页面路由即可自动分类。默认名称来自路由模板的静态段，连字符转为下划线：`/dev-resources` → `dev_resources`，`/scheduled-tasks/:taskId?` → `scheduled_tasks`。动态参数值、查询参数和 hash 不进入新增分类数据。

只有需要保留历史名称或标识外部渲染的页面容器时，在原路由的 `handle.analyticsScreen` 中指定名称：终端列表仍为 `terminal_list`，终端工作区仍为 `terminal_workspace`，后台运行仍为 `background_run`；由管理容器渲染的 `/settings/:pageId?` 统一为 `settings`，不把设置分类拆成独立统计页面。未来如需分类维度，应复用 settings 注册表，不新增手写分类清单。

重定向、认证检查占位、无内容路由及通配回退不报告分类。可见性依据路由当前实际选择的 element，不另行复制认证规则。管理页面保留的后台终端不会覆盖前台分类；分类机制不修改 SDK 自动采集，也不创建额外 pageview。

Identify API 要求 Custom User ID；应用只生成当前 Document 内存中的随机 UUID，刷新或新窗口后重新生成，不保存到 storage/cookie，不使用真实用户、设备、连接或终端身份，也不设置 Custom Session ID。SDK 异步加载或 SPA 重启时只保留并重新应用最新分类，不补发历史页面事件，失败不阻塞导航。

Mac Stable 的 `runweave:` 协议不支持 Chromium 原生 Cookie 写入。集中加载器在启用采集后安装 [桌面 Cookie 兼容层](../src/features/analytics/desktop-clarity-cookies.ts)，仅将 SDK 自己生成的 `_clck`、`_clsk` 按其原有到期时间保存在当前 origin 的 localStorage，支持 SDK 删除操作；其他 Cookie 继续交给原生访问器，普通 Web 不安装兼容层。这里保存的是 SDK 的匿名用户及会话 Cookie，与上面的临时 Custom User ID 不同；不加入业务身份。存储被禁用时采集降级，不阻断应用。

Electron 的官方 SDK 会把 URL 归一化为 `https://Electron`。Custom Page ID 是额外的后台筛选维度，不覆盖原生 URL，也不单独创建 pageview；不能据此承诺“顶级页面”显示真实路由或原生页面数等于功能进入次数。后台应使用“自定义页面 ID”筛选并保存所需区段，页面级聚合与回放粒度需以真实云端验收结果为准。

随记、隧道抽屉由 [ClarityDrawerObserver](../src/features/analytics/clarity-drawer-observer.tsx) 集中监听关闭→打开，分别发送固定事件 `surface_open_suiji`、`surface_open_tunnels`。重复 render、保持打开与关闭均不发送；关闭后再次打开新增一次。隧道仅在实际支持的 Electron 宿主上记录。事件没有附加内容或动态 ID，不改变 Custom Page ID，也不把抽屉当新页面。

SDK 尚未就绪或正在重启时跳过抽屉事件，不补发历史打开，不增加等待队列或重试。后台事件的会话数不能当成打开次数；按真实事件时间线核对次数和回放。分类与抽屉事件不修改既有 SDK 对 URL、DOM 的采集范围。

已经成功启动过的 SDK 如果停止，在用户前台操作、页面分类变化、窗口重新获得焦点或网络恢复时，适配器等待 1 秒并再次确认仍处于停止状态，再调用官方 `start` 恢复，保留 SDK 当前配置与 consent 状态。恢复尝试间隔至少 30 秒，不运行后台重试循环，不重新注入项目 tag，不补发失败期间的操作。正常 SPA 重启期间恢复会自动取消；首次脚本加载失败仍等待新 Document。

## 构建配置与运行范围

| Vite 环境变量             | 行为                                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `VITE_CLARITY_PROJECT_ID` | Web 与 Mac Stable 缺省使用项目 `yo8dc0des6`；可覆盖为独立验收项目 `yo6azwkf18`。非空 ID 仅允许 ASCII 字母数字。 |
| `VITE_CLARITY_ENABLED`    | 缺省启用；显式字符串 `false` 关闭。                                                                             |

Vite 开发服务（包括 Dev Session）不初始化；即使 Dev Session 使用生产模式构建，存在 `VITE_RUNWEAVE_DEV_SESSION_ID` 时也不初始化。`VITE_RUNWEAVE_CHANNEL=beta` 的构建不初始化。普通 Web 只在 `http:`/`https:` Document 初始化；Mac Stable 主窗口只在 Electron bridge 与 `runweave:` 协议同时存在时初始化。Companion bridge、独立 `companion.html` 和 overlay harness 继续排除。初始化只加载 `https://www.clarity.ms/tag/<projectId>` 一次；SPA 导航不重复安装。脚本下载或上传失败不阻塞产品操作。

如需云端验收，使用隔离的**生产模式构建**并覆盖项目 ID：

```bash
VITE_CLARITY_PROJECT_ID=yo6azwkf18 pnpm --filter @runweave/frontend build
```

开发服务器、Beta 和 Dev Session 不会产生 Clarity 会话或新增页面分类，不能用于云端采集验收。项目 ID 是公开标识，不是后台凭据。Clarity 会采集页面 URL，`/terminal/:terminalSessionId` 等路由中的 ID 不受 Strict masking 保护；桌面上线验收必须核对这一项与实际回放范围。现有项目登记的网站 URL 为 `http://127.0.0.1:5001`；项目存在或采集请求成功不代表云端已有可用回放。

## 遮盖、披露和验收

生产与验收项目均使用全局 Strict masking，不添加 unmask。Strict 遮盖文本与图片，但不能据此推断 URL、属性或所有媒体都安全；使用唯一合成标记检查实际上传和回放。项目规则的修改需要等待生效后用新会话验证。上线前核对既有用户披露和部署环境的 cookies/consent 要求。

使用 [Clarity 测试计划](../../docs/testing/analytics/web-clarity-autocapture.testplan.yaml) 验证 Web、Mac Stable、Beta/Dev Session 排除、普通 DOM 行为、云端回放、遮盖及性能。浏览器网络请求只证明客户端尝试采集，不证明官方后台有可用回放。无法访问后台时相关项记 blocked。

会话身份持续性、SDK Cookie 删除与到期、网络中断后的恢复，使用 [Clarity 会话生命周期计划](../../docs/testing/analytics/clarity-session-lifecycle.testplan.yaml) 独立取证。隔离 Electron 中的本地接收器可验证 SDK 行为与上传信封，不能替代真实桌面实例及云端回放验收。

## 关闭与回滚

以 `VITE_CLARITY_ENABLED=false` 重新构建并部署，完整刷新后的新 Document 不再初始化；旧页面需刷新或关闭。只更改服务进程变量不会改变已构建包；移除脚本节点不能停止已运行 SDK。紧急停止需使用已验证的部署阻断或后台规则，并核对实际效果。

参考：[官方安装](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-setup)、[遮盖](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-masking)。
