# 开发资源

桌面终端左侧的「开发资源」及原生 iOS 首页「… → 开发资源」展示当前连接 Backend 所在电脑的测试资源。进入页面读取一次，
其后由用户点击刷新；筛选、展开、聚焦和网络恢复不刷新。接口不提供历史列表或趋势。

桌面容量按五个 Beta 物理槽位计数，槽位 owner 对应的 Session 不重复计数。
非池桌面 Session 单独列出；已经释放且没有残留进程的 Session 不再展示。
iOS 模拟器按 registry 中的物理 UDID 去重。设备 Booted / Shutdown 与任务占用状态独立。
未知归属、读取失败和冲突登记必须保守展示，不能被当作空闲。

## 释放边界

忙碌资源提供「停止并释放」，归属明确且符合恢复条件的残留提供「释放占用」。
用户确认前显示资源、任务、工作树及中断说明。控制当前接口的 Backend 所属 Session
不能从自身页面停止；共享服务不属于目标 Session 的清理范围。

释放请求携带当前 Backend generation 绑定的占用摘要和幂等键。控制 helper 在现有
Session / 槽位 / UDID 生命周期锁内重新核对 owner、lease 与进程身份。清理失败保留占用，
通过进程退出、设备关机、reset 和 lease 后置核查后才展示空闲。网络中断和 Backend
重启不自动重放清理；持久化操作记录用于返回同一操作或说明结果尚未确认。

GET 只读投影，不通过会写回状态的 `dev:status` 协调资源。安装产物携带固定 helper、
模拟器管理代码与原生锁依赖，不执行 owner worktree 中提供的控制脚本。
模拟器管理需要 macOS、Python、Xcode；清理自动化任务需要已安装的 agent-device 0.21.3。
资料不完整时显示原因并关闭释放能力。

## 原生 iOS

手机采用独立原生页面，桌面与模拟器分段显示，概览同时可见；占用时长与最后活动按快照观察时间计算。
Swift DTO 对照共享 HTTP 合同，复用当前连接认证；不引入历史数据或轮询。明确释放操作结束后读取一次结果。
离线、读取失败、连接切换或服务实例变化时禁用释放，保留的数据标明需要手动刷新。旧响应不跨连接显示，
未知归属、正在执行或结果未确认的操作不允许重复释放。

释放确认显示电脑、资源、任务、工作树与中断影响；取消不发送请求。资源请求使用独立的 75 秒等待预算，
避免普通接口的 20–30 秒超时早于清理结束；认证续期、超时与连接失败均不自动重发释放请求。
旧电脑端不支持接口时，手机显示更新电脑端的提示；更新手机不会更新电脑 Backend。

## 入口与验收

- [共享协议](../../packages/shared/src/monitoring/dev-resources.ts)
- [Backend 服务](../../backend/src/dev-resources/service.ts)与[认证路由](../../backend/src/routes/registration/dev-resources.ts)
- [只读投影](../../scripts/dev-resources/snapshot.mjs)与[固定释放控制](../../scripts/dev-resources/operations.mjs)
- [桌面产品页面](../../frontend/src/pages/dev-resources-page.tsx)
- [原生 iOS 页面](../../packages/app-ios/Sources/RunweaveIOS/Features/DevelopmentResources/DevelopmentResourcesView.swift)、[状态模型](../../packages/app-ios/Sources/RunweaveIOS/State/DevelopmentResourcesModel.swift)与[Swift DTO](../../packages/app-ios/Sources/RunweaveIOS/Contracts/DevelopmentResources.swift)
- [模拟器管理合同](../cli/ios-simulators.md)与[桌面生命周期合同](../deployment/runweave-beta.md)
- [桌面与 Backend 验收计划](../testing/platform/development-resources.testplan.yaml)与[原生 iOS 验收计划](../testing/app/ios-development-resources.testplan.yaml)

格式、类型和构建通过不能替代真实桌面、Runner 清理与锁内身份变化验收。发布前须为专项计划
的全部 required 用例取得真实 verdict，不能把局部验证当作完整矩阵通过。
