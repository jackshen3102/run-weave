# iOS 验收状态

本页记录当前验收入口和仍需跟进的事项，不再作为迁移阶段流水账。
代码中的实现、构建/schema 检查和真实运行验收必须分别报告。

## 当前合同

仓库 `docs/testing/app/` 中的原生计划是当前合同：

- [首页关注、搜索与重命名](../../../docs/testing/app/ios-native-home-discovery.testplan.yaml)
- [终端悬浮输入布局](../../../docs/testing/app/ios-native-terminal-layout.testplan.yaml)
- [终端与渲染](../../../docs/testing/app/ios-native-terminal.testplan.yaml)
- [认证、连接与资源生命周期](../../../docs/testing/app/ios-native-session.testplan.yaml)
- [终端图片附件](../../../docs/testing/app/ios-native-image-attachments.testplan.yaml)
- [输入、媒体、预览与主题](../../../docs/testing/app/ios-native-features.testplan.yaml)
- [扫码跨端交互](../../../docs/testing/app/mobile-qr-login.testplan.yaml)
- [扫码协议与凭据](../../../docs/testing/app/mobile-qr-login-protocol.testplan.yaml)

布局改动若有独立执行计划，以该任务当前计划为准，不继承历史运行结果。
原生 UI 需要 Simulator / 真机实际操作。Playwright 可用于 Backend 配套的 Web 客户端，不能验证 SwiftUI。
不新增 XCTest 或单元测试框架来替代真实 UI 取证。

2026-09-09 将终端常驻 Composer 改为右下角入口和系统 Sheet，大输入区覆盖终端，键盘不再改变
底层终端视口；同时保留草稿提示和执行中一键停止。10 条布局测试计划通过格式校验，iOS 26.5
Simulator Debug 构建、安装和启动通过；启动时 Backend 离线，尚未完成终端内交互验收，不能据此
宣称闪动和 resize 行为已经运行通过。

## 已有证据及适用边界

2026-09-07 的既有记录覆盖真机登录与连接、tmux 历史滚动、断网恢复、只读客户端释放、
媒体转写、文件/Diff、主题持久化及设备响应路由。这些属于当时构建的结果，不能转为后续修改的自动通过。
原生 Profile 曾完成 256 KiB/s、600 秒负载：接收和提交各 157286452 B，前 60 秒输出提交
p95 41.56 ms，输入提交 p95 4.51 ms，第二/第十分钟 RSS 163.44/163.89 MiB。
计量从解码后的通知或应用事件分发开始，到 UIKit transaction commit 为止，既不含完整网络链路，也不是屏幕发光延迟。

原始证据在执行机器的仓库 `.runweave/ios-native-evidence/` 与 `.runweave/native-device-runner/`；
这些本地文件不随源码分发。发布结论必须带对应 commit、设备、配置、计划版本和可访问证据。
历史阶段报告及迁移对照可以从 Git 历史查阅，不作为运行或构建依赖。
本轮把旧客户端对照改为独立验收合同，因此不沿用旧版“40 通过”等汇总数字。

## 首页查找验收

2026-09-07，`ios-native-home-discovery.testplan.yaml` 的 IOSHOME-001 至 IOSHOME-011
已在本轮隔离 Backend、真实 shell 和 iOS 26.5 Simulator 上取证。覆盖置顶与取消、幂等与重启恢复、
连接切换迟到响应、搜索展开恢复、Unicode 别名、写入/刷新失败、离线禁用、鉴权、删除和真实输入。
输入用例同时核对原生请求日志与专用文件，确认命令只执行一次。Swift Debug 构建通过；这不替代真机验收。

2026-09-09 新增 IOSHOME-012 至 IOSHOME-015，覆盖未读与执行态临时上浮、关注原因优先级去重和
离线缓存降级。测试计划格式校验与 iOS 26.5 Simulator Debug 构建通过；这四条新增行为尚未执行
Simulator 或真机交互验收。

本轮证据位于执行机器 `.runweave/ios-home-discovery/`，入口为 `REPORT.md`，含构建、
`.xcresult`、控件树、截图与脱敏 API 结果。旧格式记录由修改前的存储实现生成，再用候选 Backend
修改和重启验证。中途磁盘空间耗尽、原 Simulator 消失，恢复后使用本轮新建 Simulator 完成剩余用例。

全目录存储故障还暴露了既有活动时间后台写入的未捕获异常；本轮只验证并修复置顶/别名的失败一致性，
不声称整个 Backend 已能从任意磁盘故障恢复。该异常保留在本轮证据中供后续专项处理。

## 图片附件验收

2026-09-07，`ios-native-image-attachments.testplan.yaml` 的 IOSIMAGE-001 至 IOSIMAGE-005
已在 iOS 26.5 Simulator、原生照片选择器、隔离 Backend 和真实 zsh 上通过。覆盖多图预览、取消选择、
文字与图片一次发送、上传失败重试、移除后迟到响应、仅图片发送、输入失败保留、终端/连接隔离，
以及发送确认期间新增草稿的保留。真实 shell 实参文件验证了空格、单引号转义与图片顺序，图片像素哈希一致。

本轮证据入口为执行机器 `.runweave/ios-image-attachments/REPORT.md`，含 `.xcresult`、截图、控件树、
脱敏请求记录和实参核对。Swift Debug 构建、增量 Swift 格式检查与测试计划 schema 检查通过。
这些结果不替代真机、语音转写、后台系统终止或全部图片格式的专项验收。

## 终端接管提醒验收

2026-09-08，原生 Debug 构建和 iOS 26.5 Simulator 交互通过：五种终端状态、项目收起后的
未读汇总、打开终端确认已读、终端页收到新提醒及手动确认、列表标记已读、确认失败保留绿点、
旧确认期间新完成事件的保留，以及 App 重启恢复未读。隔离 Backend 使用真实 HTTP/WS、
完成版本和持久化实现；运行状态、完成通知及确认延迟/失败由本地验证入口控制，未运行真实 Agent 任务。
同时验证了 2 秒响铃、黄点暂时覆盖绿点及到期恢复、返回前台时不重放历史响铃。

证据位于执行机器 `.runweave/ios-attention-20260908/`，包含原生 `.xcresult`、截图、控件树、
确认版本记录及落盘结果。这不替代真机或桌面与手机同时在线的端到端验收。

## 待关闭事项

扫码实现已有 iOS 26.5 Simulator Debug 构建、iPhone 17 真机 Debug 构建与安装证据。
2026-09-08 的真机 XCUITest 从正式连接管理进入扫码，确认点击后才出现相机权限请求，随后进入
扫码页并取消返回原连接。桌面候选通过 Playwright 完成入口、换码、请求确认与完成回执状态验证，
其中手机请求由临时 HTTP 驱动发送，不能视为真实相机扫码成功。

独立 Backend 协议检查已覆盖旧登录、owner/claimant 绑定、批准边界、取消、180 秒真实期限、
并发丢包恢复、同一认证目录下的 Backend 重启，以及会话创建写盘失败恢复（MQP-001～009）。
MQP-010 已验证连续 65 次每秒轮询、每 IP/requestId 限流、第 65 个活跃请求拒绝以及等待后的容量恢复；
内部表大小未通过公开 API 观测，因此不标为整条通过。后端结构化字段与 JSON 字符串的脱敏链已独立验证。
本机原始证据在 `.runweave/mobile-qr-login-evidence/`；真实相机对准桌面、Keychain/连接保存故障、
回执丢失恢复及三端日志/重定向用例仍需专项取证，25 条 required 用例尚未全量通过。

| 项目                | 当前边界与下一步                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 首页回复预览        | 类型、Hook、隔离 HTTP/真实落盘回填与模拟器构建已验证；任务完成后的原生列表自动刷新仍需真机交互取证。             |
| IOSFEATURE-006 录音 | 历史取消录音后有一次来源未明 HTTP 输入；后续无触摸回归未复现，仍需归因，不能归入已修复的 renderer 自动响应问题。 |
| IOSTERM-007 锁屏    | 同一会话恢复和新输入已有记录；仍需在同次持续输出锁屏运行中补齐 scene/socket 与画面恢复耗时。                     |
| IOSFEATURE-012 主题 | 连接管理弹窗即时主题绑定已修复，编译通过；该修复尚需真机即时切换回归。                                           |
| 最低系统与 TLS      | 此前 iOS 15 及 HTTPS/WSS/TLS 子项被排除，排除不是通过；声明支持范围时应按当前部署版本和真实设备重新取证。        |

旧 xterm 十分钟对照未完成，保留为历史研究限制；旧客户端退役后不再作为当前原生性能合同的前置条件。
原生性能预算仍保留，不能因为删除对照就降低阈值。后续布局、渲染或输入变更需按影响范围重验。
