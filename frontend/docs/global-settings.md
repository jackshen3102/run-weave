# 桌面全局设置

桌面应用菜单的「全局设置」进入 `/settings/:pageId`。设置覆盖应用内容区域，保留原生标题栏；左上角返回工作区，分类不提供搜索。分类与作用域的唯一登记是 [registry.ts](../src/features/settings/registry.ts)。模型目录搜索和业务页面筛选继续存在。

## 作用域

- 本台偏好、普通连接、SSH 通道、桌面通知和本台诊断始终属于当前 Electron。随记账户继续按正式／开发环境隔离。
- 登录、手机接入、监控、服务配置、默认角色模型和电脑状态属于侧栏所选电脑。切换设置目标不切换工作区活动连接；两者的认证、请求及查询缓存分别管理。
- 外观页管理全部工具的设备偏好，但至少保留一个始终可用的工具；Agent Team 的呈现依赖终端，不能计入这一保障。
- 终端历史、Team 运行和状态查询保留终端上下文。项目、终端、右侧工具布局及业务入口不因设置分类改变。
- Browser 默认 Profile、端口、代理、Worktree 绑定、通道授权与打开网页路由保持原入口。设置中的 SSH 编辑器不编辑 Browser 对象，保存时保留完整对象。
- 右上角快捷指令、Services、随记、定时任务、运行状态和更多操作继续使用原图标及原交互；只将实例默认角色模型入口收敛到高级配置。

## 导航与生命周期

[navigation.ts](../src/features/settings/navigation.ts) 校验返回地址，并保留工作区 background location。分类和页内分区使用 URL，未知分类回退外观页，无来源时返回 `/terminal`。URL 不承载凭据或二维码载荷。

[settings-page.tsx](../src/pages/settings-page.tsx) 使用现有 Dialog 焦点管理及 `useOverlayRef(..., "window")`。背景工作区保持挂载，退出设置恢复原生 Browser 呈现；业务代码不能直接调用 Browser hide/show，遵循[浮层协调](overlay-coordination.md)。

[target-context.tsx](../src/features/settings/target-context.tsx) 复用现有连接认证，以连接身份、地址、代次和认证会话隔离电脑页。领域组件继续调用原 service/store；不要在设置组合页复制协议、账户存储或业务状态机。配置 HTTP 允许列表及本机权限限制保持原合同。

[edit-session.tsx](../src/features/settings/edit-session.tsx) 统一保护分类、目标、返回及历史导航。继续编辑保留草稿，放弃不提交；保存中的操作锁定输入和导航。敏感草稿只存组件内存。手机审批及签发使用原状态机，结果未知时核实同一请求。

## 验证入口

[全局设置测试计划](../../docs/testing/platform/desktop-global-settings.testplan.yaml) 验证容器、图标、工作区保活、目标隔离、草稿和原生 Browser 恢复。SSH、手机签发、账户登录、进程操作和服务生命周期仍按各领域测试计划验收，不能用页面可达或原型成功替代端到端结果。

桌面诊断导出通过可选的窄 Electron bridge 调用原导出实现。旧宿主缺少能力时按钮禁用；原生 File 菜单继续保留诊断导出和运行时重新加载。
