# 桌面全局设置实现核对

2026-10-12，wt-1 的实际实现与临时验收记录；这不是独立原型的模拟结果，也不表示所有领域用例都已通过。长期边界见[全局设置](../../../frontend/docs/global-settings.md)，原型历史清单见[逐页功能保留清单](../../prototypes/global-settings/feature-preservation.md)。

## 本次实现

10 个页面、18 个功能分区均接入现有组件、服务和存储。页面组合放在 `frontend/src/features/settings/pages/`，导航、目标身份及草稿保护分别管理；没有复制原型的假数据和业务状态机。

全局搜索为零。右上角 6 个快捷入口继续使用原 24×24 图标、提示和原交互，“阅读会话”也保留。终端历史、Team 运行、业务页面和 Browser 配置保持原作用域。

## 逐分区保留结果

“源码复用”表示字段、操作、权限和异常分支继续来自原组件，不表示该行的每个状态已经在真实外部环境执行。

| 页面／分区           | 实际内容和 owner                                         | 本轮真实验证及范围                                                                                                                           |
| -------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 外观                 | 原 next-themes 和 sidecar store；本台                    | 深浅／系统主题、10 工具显隐、排序、最后一项保护（不把依赖终端的 Agent Team 计入保障）、恢复原偏好；真实桌面                                  |
| 桌面通知             | 原通知存储键和宿主通知能力；本台                         | 与监控页共用偏好，双向修改读回；不伪造系统通知授权成功                                                                                       |
| 快捷键               | 原生菜单对应的 18 项只读说明；本台                       | 页面可达；File/Edit/View/Window 原位；未增加快捷键编辑                                                                                       |
| 连接管理／连接       | ConnectionPage/useConnections；本台                      | 添加自有 B、设置选中 B、工作区仍 A；系统连接只读和重连继续源码复用                                                                           |
| 连接管理／SSH 与转发 | 原 TunnelDrawer/HostForm 及共享校验；本台                | 实际保存主机、端口、路径、Backend 入口；revision 冲突保留输入；隐藏 Browser 对象完整保留；已清理测试主机。实际 SSH 连接未执行                |
| 连接管理／远程接入   | HostForm 内原中转与 RemoteDesk 内容；本台                | 中转表单字段观察；身份准备、证书指纹检查、复制／检测等源码复用；未启动实际中转或远控                                                         |
| 随记账户             | 原 SuijiConnection/account store；按环境                 | 正式／开发切换、草稿继续／放弃；原登录恢复／修改／退出／401／重试分支复用；未使用真实账户登录                                                |
| 登录／密码           | 原 ChangePasswordForm 和 auth API；所选电脑              | 原当前／新密码，增加确认，中文主题控件可达；403／401／成功重新登录源码复用；未提交密码修改                                                   |
| 登录／手机           | 原 useMobileLogin/MobileLoginDialog；所选电脑            | 真实 QR 创建、HTTP claim、设备名、拒绝、离开取消；自有 Backend 协议另验证批准、并发同会话、完成清除凭据、取消及 180 秒过期。没有真机扫码证据 |
| 资源监控与提醒       | 原 ResourceSettings/controller；所选电脑，本台通知独立   | 提醒开关真实保存／读回／恢复，权限配置不变；本机管理远端控制权限、revision 与部分成功源码复用                                                |
| 高级配置／字段       | 原 ConfigurationPanel/service/field states；所选电脑     | 元数据核对 28 字段、5 领域、6 敏感字段；真实保存、消费者采用状态、冲突留稿、重读和空值默认恢复；不扩大允许列表                               |
| 高级配置／默认模型   | 原动态目录／模型 API；所选电脑                           | 四角色整组保存与读回、取消不写入、目录搜索、保存中全控件锁定；没有启动付费 Agent Run；既有快照合同不变                                       |
| 电脑状态／运行状态   | 原 RuntimeStatusPanel/Provider；所选电脑                 | 实际节点健康、失败原因、能力和版本构建；原刷新／复制／展开和导航继续复用                                                                     |
| 电脑状态／系统资源   | 原 SystemMonitorPage/process rows；所选电脑              | 实际 CPU／RAM／电池／进程和排序控件可达；PID 身份、保护原因、结束／强制确认／权限撤销源码复用；未终止用户进程                                |
| 电脑状态／开发资源   | 原 DevResourcesPage/resource list；所选电脑              | 实际池容量／归属／筛选／明细可达；expectedOwnershipVersion、幂等键、释放／停止并释放及未知结果源码复用；未释放其他任务资源                   |
| 电脑状态／Codex 额度 | 原 CodexQuotaProvider；所选电脑                          | 真实查询返回额度与重置时间，手动刷新入口；未知／陈旧／失败保留最近成功／401 分支复用                                                         |
| 电脑状态／日志       | 原 DiagnosticLogEntry/controller；本台 Web＋所选 Backend | 真实开始、结束并保存本台 Backend、返回路径、正文及下载控件；读取中可离开，提交中保护；未向第三方上传                                         |
| 本台桌面诊断         | 原 DesktopConfigurationStatus 与窄 bridge；始终本台      | 切 B 仍显示本台身份；真实导出产生诊断包，原生成功提示；重载确认取消。没有宣称实际重启通过                                                    |

## 验证证据

[verification.json](verification.json) 包含结果和边界。新增 DGS-001 至 DGS-007 的 7 项 required 均已在 Electron 候选构建 `dvs-79dc43`（Beta pool-04）执行通过：全窗 20 次页面／尺寸检查、原快捷交互、工作区保活、A/B 隔离、草稿保护、路由恢复和原生 Browser 输入命中。A/B 使用另一个自有 `dvs-691339`（Beta pool-03）；手机 UI 和随记草稿的先前证据来自同一实现过程中的 `dvs-5ba2e1`。没有将旧原型断言算入这些结果。最后补充了「终端条件工具不能计入最后一项保障」的保护，重新构建并在 `dvs-46bbe7`（pool-04）确认实际加载的 bundle 含该条件，重跑 20 次布局检查和该保护／偏好恢复。

Browser 原生合成窗口观察：设置中的原生点击不会命中测试网页（计数 0）；返回后原 Profile、Tab、URL、偏好和驻留 Tab 数保持，原生点击计数变为 1。见[协议与原生记录](native-browser.json)。

前端构建与 lint、Shared/Electron 类型检查、Electron lint、架构检查通过；循环依赖、违规跨层依赖和超过 600 行文件均为 0。两个 YAML 格式、文档检查、diff 空白检查另在收尾记录。未新增单元测试。

真实 Electron DEV 截图：[最终全屏设置](native-final-settings.png)、[Browser 避让过程](native-settings.png)、[默认模型](final-models.png)、[恢复工作区](native-browser-restored.png)、[浅色主题](final-light.png)、[SSH 冲突](ssh-conflict.png)、[日志保存](final-logs.png)、[开发资源](final-dev-resources.png)。截图不是对应领域全部状态通过的替代证明。

## 尚未执行的领域验收

实际 SSH／中转／RemoteDesk 链路、真实 iPhone 扫码、随记真实账户恢复／登录／退出、密码修改提交、真实进程结束与资源释放，以及已有各领域测试计划的全部 required 矩阵仍未执行。最小依赖分别是执行者可用的 SSH 目标与端口、可用且解锁的 iPhone、测试账户，以及明确属于验收的可处置资源。这些缺口不以保留旧入口或源码复用冒充通过。

未更新 Stable、安装 iOS、创建提交或 PR。已停止成功启动的自有 Session；启动失败的 `dvs-400807` 仍为 stale，CLI 因 Beta 所有权信息不完整拒绝 stop／cleanup-stale。其原自有 App Server PID 已不在运行；没有强制停止恢复后的 pool-02 窗口、删除 lease 或处理其他任务资源。本轮 Dev Session 生命周期清理见[verification.json](verification.json)中的 cleanup。
