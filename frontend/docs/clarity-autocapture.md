# Web 与 Mac 桌面 Clarity 自动采集

普通 Web 与打包的 Mac Stable 主窗口默认加载 Microsoft Clarity。代码入口是 [clarity.ts](../src/features/analytics/clarity.ts) 与 [main.tsx](../src/main.tsx)。前端构建包含加载器和项目 ID；官方采集脚本运行时从微软下载。业务组件没有按钮事件或元素标签，点击不等于业务成功。

## 页面分类

[ClarityNavigationObserver](../src/features/analytics/clarity-navigation-observer.tsx) 在应用装配层统一识别实际显示的路由，通过官方 Identify API 设置固定 Custom Page ID。映射见 [screen-classification.ts](../src/features/analytics/screen-classification.ts)：终端列表为 `terminal_list`，终端工作区为 `terminal_workspace`，定时任务为 `scheduled_tasks`，其他页面同样使用固定枚举。动态 ID、查询参数和 hash 不进入新增分类数据；认证检查占位、重定向目标与未知路由不算已访问页面。

Identify API 要求 Custom User ID；应用只生成当前 Document 内存中的随机 UUID，刷新或新窗口后重新生成，不保存到 storage/cookie，不使用真实用户、设备、连接或终端身份，也不设置 Custom Session ID。SDK 异步加载或 SPA 重启时只保留并重新应用最新分类，不补发历史页面事件，失败不阻塞导航。

Electron 的官方 SDK 会把 URL 归一化为 `https://Electron`。Custom Page ID 是额外的后台筛选维度，不覆盖原生 URL，也不单独创建 pageview；不能据此承诺“顶级页面”显示真实路由或原生页面数等于功能进入次数。后台应使用“自定义页面 ID”筛选并保存所需区段，页面级聚合与回放粒度需以真实云端验收结果为准。

随记、隧道抽屉由 [ClarityDrawerObserver](../src/features/analytics/clarity-drawer-observer.tsx) 集中监听关闭→打开，分别发送固定事件 `surface_open_suiji`、`surface_open_tunnels`。重复 render、保持打开与关闭均不发送；关闭后再次打开新增一次。隧道仅在实际支持的 Electron 宿主上记录。事件没有附加内容或动态 ID，不改变 Custom Page ID，也不把抽屉当新页面。

SDK 尚未就绪或正在重启时跳过抽屉事件，不补发历史打开，不增加等待队列或重试。后台事件的会话数不能当成打开次数；按真实事件时间线核对次数和回放。分类与抽屉事件不修改既有 SDK 对 URL、DOM 的采集范围。

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

## 关闭与回滚

以 `VITE_CLARITY_ENABLED=false` 重新构建并部署，完整刷新后的新 Document 不再初始化；旧页面需刷新或关闭。只更改服务进程变量不会改变已构建包；移除脚本节点不能停止已运行 SDK。紧急停止需使用已验证的部署阻断或后台规则，并核对实际效果。

参考：[官方安装](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-setup)、[遮盖](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-masking)。
