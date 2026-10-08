# iPhone 多线路连接原型

2026-10-08 的历史交互设计快照，保存当时的产品意图与模拟交互。核心原生实现已落地，当前合同见 [iOS 架构](../../../packages/app-ios/docs/architecture.md#同一电脑的多线路连接)；本原型不作为当前生产协议、实现状态或真机验收证据。

## 打开

```bash
python3 -m http.server 6197 --bind 127.0.0.1 --directory docs/prototypes/ios-connection-routes
```

访问 <http://127.0.0.1:6197/>。无构建步骤，需通过 HTTP 加载 JSON，不能直接双击 HTML。

## 原型简报

- 目标：iPhone 在家里网络、公司网络与已有 Devbox 隧道之间，继续访问同一台 Runweave 电脑。
- 入口：连接管理 → 一台电脑 → 连接线路。原型默认打开最后一级，可返回电脑列表再进入。
- 主要动作：自动选择、手动指定、重新选择、排序、添加、编辑、删除线路。
- 默认状态：家里地址不可达，公司地址在线，Devbox 隧道尚未检测。
- 关键状态：探测中、在线、全部不可达、固定线路失败、目标身份不匹配。
- 非目标：Mac 桌面远控、桌面/Web 连接管理、创建 SSH 隧道、自动发现地址、真实登录与持久化。

## 采用的交互方案

一台电脑保存多条完整 URL，可包含域名、端口与路径。顶部展示电脑、当前线路、状态和延迟；下面选择连接方式并管理有序线路。

自动模式按顺序尝试，成功后停止。已连接时不因排序变化或更高优先级线路恢复而抢切；用户可主动重新选择。手动模式只尝试固定线路，失败不自动回退；切回自动立即重新按顺序选择。

“编辑”进入排序状态：桌面拖动、触屏拖动手柄或上移/下移按钮；“完成”结束排序。每行菜单提供编辑和固定使用。新增线路追加到末尾；删除需要确认。改变正在使用的地址会断开当前连接，需重新选择。

放弃的方向：把不同地址分别保存成不同电脑；线路恢复后自动抢切；手动固定失败后静默回退；在产品画面加入演示场景开关。

## 功能分类

| 分类         | 内容                                                                                                                  |
| ------------ | --------------------------------------------------------------------------------------------------------------------- |
| 产品核心功能 | 同一电脑多 URL、自动/固定模式、排序、当前线路反馈、逐条检测进度、重试、增删改、地址格式与重复校验、目标身份不匹配反馈 |
| 原型辅助功能 | `mock-state.json` 中的虚构电脑、地址、状态和延迟；URL 场景参数；固定系统时间；浏览器内绘制的手机外框                  |

辅助功能不进入产品实施计划。页面中没有可见的模拟开关。新增或修改地址的目标验证在原型中假设成功；URL 仅做本地格式校验，不发出连接请求。模拟探测每条耗时 700 ms，不是正式产品超时合同。数据只存在当前页面内存，刷新会重置。

## 查看其他场景

在地址后添加以下参数；均来自 `mock-state.json`：

| 参数                       | 状态                                                     |
| -------------------------- | -------------------------------------------------------- |
| `?scenario=home`           | 家里线路在线                                             |
| `?scenario=tunnel`         | 两条 Wi-Fi 不可达，使用 Devbox                           |
| `?scenario=offline`        | 所有线路不可达                                           |
| `?scenario=manual-failure` | 固定家里线路且连接失败                                   |
| `?scenario=identity`       | Wi-Fi 不可达，隧道目标身份不匹配                         |
| `?scenario=recover`        | 家里线路恢复，仍保持公司线路；点击重新选择后改用家里线路 |

## 与当前产品的关系

正式实现由 [ConnectionStore](../../../packages/app-ios/Sources/RunweaveIOS/State/ConnectionStore.swift) 保存电脑与有序线路，[ConnectionRouteResolver](../../../packages/app-ios/Sources/RunweaveIOS/State/ConnectionRouteResolver.swift) 选择可信地址，[ComputerCredentialSession](../../../packages/app-ios/Sources/RunweaveIOS/State/ComputerCredentialSession.swift) 按电脑共享凭据和一次在途刷新。同电脑换线路保留终端和未发送草稿；身份协议见 [移动端架构](../../architecture/app-mobile.md#电脑身份协议)。

新配置使用 `native.connections.v2`，由用户重新录入，不导入或删除旧配置、凭据、草稿与通知绑定。完整验收矩阵及真机跨网络验证仍以 [验收状态](../../../packages/app-ios/docs/validation-status.md) 为准，不继承下面的浏览器原型检查结果。

## 验证

通过仓库固定版本的 Playwright CLI，在 Runweave Terminal Browser 中完成 16 项浏览器检查：默认连接、手动失败不回退、固定隧道成功、自动顺序选择、上移排序、排序不打断连接、鼠标拖动手柄排序、添加、编辑、确认删除、全部不可达、身份不匹配、高优先级恢复不抢切、主动重新选择、连接管理往返，以及 390px 宽度无横向溢出。

`node --check app.js` 与仓库 `pnpm docs:check` 通过。触屏拖动尚未在真机验证。

预览：[自动模式](prototype-preview.png)、[手动固定](manual-preview.png)、[添加线路](add-route-preview.png)。

本原型是 2026-10-08 的历史交互设计产物。当前实现与验收边界见 [iOS 架构](../../../packages/app-ios/docs/architecture.md#同一电脑的多线路连接) 和 [验收状态](../../../packages/app-ios/docs/validation-status.md)。
