# 全局设置可交互原型

2026-10-12 第五版，供设计评审，尚未进入生产实现。按现有代码逐页核对 10 个全局页面、18 个功能分区，补齐此前遗漏的 SSH、手机接入、资源操作和配置状态。详见[逐页功能保留清单](feature-preservation.md)与[机器可读覆盖表](feature-coverage.json)。

这是当前版本。`desktop-secondary-pages` HTML、10 张旧方案图片和第三版的验证记录仅作历史对照，不能作为本版范围或当前实现合同。

## 打开

在 Runweave 原型库选择 `global-settings`，或在仓库根目录启动：

```bash
python3 -u -m http.server 0 --bind 127.0.0.1 --directory docs/prototypes/global-settings
```

打开输出的本地地址。原型通过 HTTP 加载 JSON 与 ES modules，不能双击 HTML。默认进入全屏外观设置；左上角返回工作区。

## 固定范围

- 全局设置侧栏不提供搜索，10 个页面直接分类呈现；模型目录搜索和业务内部筛选保留。
- 右上角快捷入口保持原有图标形式、提示和交互；原型工作区的文字占位已改为图标，生产实施复用现有组件。
- 设置填满应用内容区域，左侧分类、右侧独立滚动。返回后保留项目、终端输入、Worktree 和当前工具布局。
- 本台偏好、随记账户、所选电脑的配置分别管理；设置中的电脑选择不替换工作区连接。
- 终端历史、Team 运行、状态查询、快捷指令执行、后台运行、定时任务、随记业务、自进化、活动数据和原型库保留原业务入口，不进入全局设置侧栏。
- Browser 的默认 Profile、代理、端口、Worktree 绑定、通道授权和终端绑定保持原交互。SSH 表单保存保留既有 Browser 配置对象，不增加重复 Browser 编辑入口。
- 原生系统菜单仍原位保留。快捷键页为只读说明，没有新增自定义绑定。
- 本轮只改原型，没有修改生产页面、API 或配置，也没有更新客户端。

## 页面与已覆盖交互

| 页面           | 原型中的交互                                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 外观           | 主题、10 个工具的显隐与排序、至少保留一个、返回后的布局恢复；原型专用偏好存储支持刷新和跨窗口同步                                       |
| 桌面通知       | 开关、系统未授权、宿主能力不足、失败重试                                                                                                |
| 快捷键         | 18 项 macOS 行为说明，原生菜单继续原位保留                                                                                              |
| 连接管理       | 普通连接 CRUD、系统只读/重连、SSH endpoint 引用、主机完整配置、转发/Backend 入口、中转接入、RemoteDesk 自动身份读取、版本冲突、连接重试 |
| 随记账户       | 环境、地址/账号/密码、登录/修改/退出、恢复中、401、失败重试与草稿保护                                                                   |
| 登录与手机接入 | 当前密码验证、修改后重新登录；二维码地址/倒计时、扫码、批准、签发、手机确认，以及拒绝、取消、过期、未确认、错误和重生成                 |
| 资源监控与提醒 | 监控/提醒、远程控制授权、本机管理限制、部分保存失败与重试                                                                               |
| 高级配置       | 28 个 Web 公开字段、恢复默认、6 个密钥操作；四角色整组模型、搜索/目录与能力限制；来源、生效状态、磁盘/版本/实例冲突                     |
| 电脑状态       | 节点能力与版本、资源排序/PID/暂停显示/安全结束、开发资源归属与释放、额度未知/旧记录/刷新、日志上报/正文/路径/复制/下载                  |
| 本台桌面诊断   | 本台环境/实例/版本、consumer 状态、刷新/失败、磁盘错误、诊断导出与重载确认                                                              |

每个字段和操作的真实来源见逐页清单。高级字段列表严格采用现有 HTTP 接口与页面共同过滤规则；[配置登记](configuration-inventory.json)包括全部 165 条元数据，28 条可在现有 Web 页面编辑，其余 137 条保持原 owner/入口，不扩大 Web 权限。

## 交互规则

编辑有草稿保护；取消离开保留输入。保存、重新读取、切电脑和切随记环境不能将草稿写到其他目标。异步提交期间防重复提交与离开。密码更新或认证失效后，所选电脑的配置先重新登录。

模型由目录明确选择，推理强度和 Fast/Max 按模型能力提供，保存四角色整组默认值。配置保存与服务已经采用分别显示。SSH 身份未核对、磁盘不可读、权限不足或版本冲突时禁止覆盖；失败保留可核对的输入和状态。

手机接入在批准后等待签发与手机完成确认；超时不把已有凭据说成失效。离开或切换地址使旧请求失效，旧回调不能覆盖新请求。二维码仅在等待扫码时显示。资源控制以进程实例和资源归属为目标，普通结束与强制结束分开确认。

## 原型数据与辅助方式

页面没有演示按钮。数据位于 `mock-state.json`；以下 URL 参数仅用于原型检查，不进入产品：

| 参数                                                             | 用途                                               |
| ---------------------------------------------------------------- | -------------------------------------------------- |
| `?tab=hosts#/connections`                                        | 直接查看 SSH 主机与通道                            |
| `?tab=mobile#/access`                                            | 手机接入                                           |
| `?mobile=waiting_scan&tab=mobile#/access`                        | 固定等待扫码，观察二维码与倒计时                   |
| `?mobile=pending_approval&tab=mobile#/access`                    | 待人工批准；批准后按样例事件进入签发、完成         |
| `?mobile=expired`、`unconfirmed`、`failed`                       | 手机异常结果与重生成，配合 `tab=mobile#/access`    |
| `?tab=resources`、`dev`、`quota`、`logs`                         | 电脑状态的子视图，配合 `#/status`                  |
| `?quota=unknown`、`stale`                                        | 上游未提供窗口或旧记录                             |
| `?config=disk-error`、`pending`、`invalid`、`unknown`、`applied` | 配置来源/应用状态；磁盘错误禁止保存                |
| `?models=missing`、`unavailable`、`error`                        | 模型缺失、CLI 不可用或目录失败                     |
| `?host=web`                                                      | 没有 Electron 管理能力                             |
| `?auth=expired`、`?notification=denied`                          | 认证失效、系统通知未授权                           |
| `?account=restoring`                                             | 随记恢复会话的过渡状态                             |
| `?remoteControl=allowed`                                         | 样例远端电脑已在本机授予控制权限                   |
| `?state=offline`                                                 | 样例本机连接断开                                   |
| `?reset=1`                                                       | 清空此原型的偏好存储；移除此参数后才能验证刷新保留 |
| `?fault=<名称>`                                                  | 下一次指定操作失败一次；保留现有输入，供重试检查   |

失败名称：`ssh-connect`、`ssh-save`、`ssh-conflict`、`system-reconnect`、`remotedesk-fingerprint`、`remotedesk-unavailable`、`remotedesk-changed-before-save`、`mobile-address`、`mobile-create`、`mobile-qr`、`mobile-decision`、`mobile-issue`、`mobile-unconfirmed`、`process-denied`、`process-exited`、`ownership-conflict`、`release-running`、`release-unknown`、`quota-refresh`、`quota-401`、`logs-report`、`desktop-refresh`、`password-401`、`password-403`、`login`、`account-restore`、`account-401`、`account-network`、`models-load`、`config-load`、`config-conflict`、`config-instance`、`monitor-partial`、`notification-denied`、`save`。

普通手机流程生成二维码后，样例事件约 5.5 秒后出现 iPhone 待批准。二维码内容是 `runweave-prototype://mobile-login/fixture-only`，不含凭据，不会让真实手机登录。显示的 SSH、IP、账号、版本、模型、进程和资源也均为样例。

偏好只写入 `runweave-prototype-settings-v4`，不读取产品配置。其他状态刷新重置。下载确实生成 JSON 文件，但显式包含 `prototype: true`。`window.prototypeEvidence()` 是无 UI 的只读检查辅助，只返回样例操作身份、主机和配置对象，不参与生产方案。

SSH 的“打开网页”仅切回工作区 Browser 示意并记录既有打开意图，不实现真实 Browser 通道。工作区的业务模块保持背景示意；本轮未重写或删减原业务功能。

## 文件与验证

第五版删除侧栏搜索及过滤状态，保留模型目录搜索；右上角恢复紧凑图标形式。独立 Chrome 会话 `global-settings-no-search` 完成 **19 项本次变更检查**：10 页可达、模型过滤、目标切换、图标无可见文字且有名称/提示、返回保留输入及无运行错误。见[本次结果](no-search-verification.json)。未重跑第四版全部 135 项；旧结果保留为基线。

当前 Chrome 截图：[无搜索的全屏设置](no-search-preview.png)、[右上角快捷图标](workspace-icons-preview.png)。下方早期截图仍含旧版搜索框，只供对应功能内容对照。

`app.js` 负责页面外壳、导航和基础表单；`connections.js`、`mobile.js`、`diagnostics.js` 分别承接完整功能区；`settings-behavior.js` 管理配置、账户、认证和偏好状态。原型不导入产品组件，不应直接复制到生产代码。

第四版在独立 Chrome 会话 `global-settings-complete` 中通过 **135 项断言**，见[验证索引](coverage-verification.json)。检查包括失败后的重试、冲突保留输入、身份核对、手机状态推进、资源归属、权限、复制下载、认证、跨窗口偏好、10 页可达和窄窗口布局。`node --check`、配置元数据对照与 `pnpm docs:check` 同时检查。

历史记录：[第三版 55 项](browser-verification.json)、[上一轮 35 项](preservation-verification.json)。这些不能代替本轮结果。

Chrome 实际截图：[SSH 主机](ssh-preservation-preview.png)、[SSH 表单](ssh-editor-preview.png)、[手机二维码](mobile-preservation-preview.png)、[系统资源](resources-preservation-preview.png)、[日志结果](logs-preservation-preview.png)。

原型验证不证明真实 SSH 连通、手机授权、Electron 权限、模型执行、服务配置生效或资源释放；这些由后续生产实现和对应环境验收证明。
