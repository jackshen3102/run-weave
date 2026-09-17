# iOS 验收状态

本页记录当前验收入口和仍需跟进的事项，不再作为迁移阶段流水账。
代码中的实现、构建/schema 检查和真实运行验收必须分别报告。

## 当前合同

仓库 `docs/testing/app/` 中的原生计划是当前合同：

- [首页关注、搜索与重命名](../../../docs/testing/app/ios-native-home-discovery.testplan.yaml)
- [终端悬浮输入布局](../../../docs/testing/app/ios-native-terminal-layout.testplan.yaml)
- [内置浏览器与终端连续性](../../../docs/testing/app/ios-native-browser.testplan.yaml)
- [网页身份与导航安全](../../../docs/testing/app/ios-native-browser-safety.testplan.yaml)
- [终端与渲染](../../../docs/testing/app/ios-native-terminal.testplan.yaml)
- [认证、连接与资源生命周期](../../../docs/testing/app/ios-native-session.testplan.yaml)
- [终端图片附件](../../../docs/testing/app/ios-native-image-attachments.testplan.yaml)
- [本地快捷回复](../../../docs/testing/app/ios-native-local-quick-replies.testplan.yaml)
- [草稿隐私元数据兼容](../../../docs/testing/app/ios-native-draft-privacy.testplan.yaml)
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

2026-09-17 输入根页已改为贴键盘的底部自增高面板，取代上述固定高度系统 Sheet。
iOS 26.5 / iPhone 17 Simulator 的当前源码 Debug 构建与原生交互已验证：两行起步、长文粘贴与内部滚动、
删除收缩、键盘收放、横屏、大字体、中文拼音候选、快捷回复追加/替换、附件失败布局、发送成功/失败，
以及关闭重开后的迟到确认隔离。本轮使用本机隔离 HTTP/WS fixture；正文增长和键盘收放未新增 resize，
不代表真实 Backend/PTY 端到端、真机、第三方键盘、外接键盘或 VoiceOver 已验收。

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

## 文件预览原生导航

2026-09-12，本轮工作区候选在 iPhone 17 / iOS 26.6.1 上完成 Debug 构建和覆盖安装。
既有 XCUITest 执行器从正式首页进入终端，验证系统左边缘右滑、短距离取消、连续进出、
源码与 Diff 横滚、Markdown 返回、图片双击缩放和平移及逐层返回；搜索词、列表落点和
文件内滚动位置保留。从文件进入 Diff 后返回没有重新显示加载指示器，截图已逐项核对。
没有向终端发送命令，也没有修改连接、凭据或服务端数据。

本机证据为 `.runweave/native-device-runner/preview-native-gestures.xcresult`、
`preview-native-media.xcresult`、`preview-native-nested-performance.xcresult` 及各自导出的附件。
三次系统导航指标采样报告约 87.7 fps、hitch 为 0，但 frame count 字段为 0，
不能据此宣称所有转场零掉帧；该小样本也不覆盖所有设备、大文件、弱网与系统中断。
此前 `preview-left-*` / `preview-right-*` 为已移除的自定义手势方案，不作为当前版本证据。

## 本地快捷回复验证

2026-09-12，本轮候选通过 iOS 26.5 独占 Simulator Debug 构建与既有 XCUITest 执行器的专项交互：
无连接时新增含技能名称的多行回复、标题/正文搜索、编辑、手动排序、取消删除、确认删除和进程重启恢复；
真实终端输入面板选择填入、追加、替换、草稿冷启动恢复后显式发送。独占 Backend 与真实 PTY 文本消费者
核对请求只接受一次、携带 `recordQuickInput: false`、正文收到一次且没有自动收录到快捷库。
另以目录真实不可写条件验证保存失败保留编辑内容，恢复权限后由用户显式重试成功；含引号、双连字符的
正文由共用文本编辑器原样保存。没有向用户已有终端发送测试内容，也未安装到个人真机。

真实 HTTP 输入检查覆盖省略/true 继续收录、false 跳过、非法类型投递前 400 拒绝；不能将其视为
旧 Backend 或手机全流程已全部验收。最初几次执行器的语言化按钮、遮挡命中与异步 UI 等待问题已在
执行器调整后重跑，不作为最终通过证据。本轮原始证据位于 `.runweave/local-quick-replies/`：
`runner/library-04.xcresult`、`runner/composer-03.xcresult`、`runner/write-failure-01.xcresult`、
`protocol-results.json` 和 `ui-send-result.json`，每次原生运行均导出截图和控件树。

2026-09-13，按上述两份 YAML 逐项完成 22 条 required 用例。独占 Simulator、真实 Backend 与
PTY/tmux 覆盖容量和损坏归档边界、跨项目/电脑、离线、注销/删除连接、写失败、接受响应丢失、
迟到目标隔离、覆盖安装和真实旧 App 字典迁移；旧 Backend 从 Git 基线运行，未用 mock 替代拒绝路径。
同文新编辑场景在真实接受确认处读取到不同的旧/新 revision UUID，确认草稿及隐私策略保留且只投递一次。
原附件路径、类型及上传原图保持；旧归档迁移中的 JPEG 缩略图可能按既有序列化方式重新编码，不保证缩略图字节不变。

验收中修复了两项 UI 问题：发送等待确认时可明确关闭并切换目标，旧请求不能清理新目标；
回复库搜索键盘不再改变底层终端尺寸。修复后完整重复尺寸/媒体用例，真实 tmux/stty 均为 38 行、43 列，
打开/搜索/编辑/填入/录音取消/关闭过程中新增 WS resize 为 0，媒体忙时仍禁止关闭或进入回复库。
最终候选另回归正常发送清理、未确认错误保留和迟到目标隔离；横竖屏实际行列为
38×43 → 13×83 → 38×43，仅旋转产生两次 resize，横屏打开输入和回复库搜索键盘新增 resize 为 0。
这些是受影响路径的专项回归，不表示终端布局、图片或连接测试计划的全部用例已重跑。

iPhone 17 / iOS 26.6.1 另补验了冷启动正文/排序及实际文件保护：归档和目录均为
`NSFileProtectionCompleteUntilFirstUserAuthentication`，目录排除备份属性为 true，解除了 Simulator
不提供该保护属性的环境限制。真机部分不等于所有 22 条均在真机执行，也不包含锁屏/首次解锁或备份恢复实验。

逐条结果和原始证据保存在本机 `.runweave/local-quick-replies-remaining-20260913/REPORT.md`，关联
`.runweave/local-quick-replies-acceptance-20260912/runner/` 的 xcresult、截图/控件树、前后归档、
输入接受/接收记录、旧版本构建及只读调试器观察。真机补证入口为
`.runweave/local-quick-replies-device-20260913/REPORT.md`。测试计划未改写以规避失败。

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

## Mac 电量与提醒验证

2026-09-11，Debug/Release Simulator 构建与 iOS 26.5 的既有 XCUITest 执行器交互通过：本机实际 100%/AC/full，
注入样本的实时 18%、接电但未充电、0%、失败保留旧记录、无电池、前台恢复新值，以及冷启动保留登录。
另用隔离 Backend 和真实 zsh 验证终端草稿在 App 后台后终止、重新启动时恢复，未向终端提交该草稿。
本轮原始证据位于执行机器 `.runweave/battery-ui/runner/` 的 `battery-native-final.xcresult` 与 `battery-drafts-01.xcresult`，
包含截图和控件树。采样注入只用于受控电量场景，不代表物理电池真的降到了 0%。

协议集成驱动验证真实认证 HTTP/WS、安装身份、单实例存储、阈值去重、别名撤销、网关重启、迟到 token 失败和接电取消重试。
provider 使用本地 HTTP/2 TLS 服务验证 ES256 JWT、固定 APNs headers/正文和响应映射；未向 Apple 发送通知。
另在真实 130 秒内保持 3 个鉴权 HTTP/WS 客户端，确认仅有启动、60 秒和 120 秒共 3 次采样；
初始 WS ticket 过期后，有效登录会话继续接收快照。注册确认前不发送、旧版本确认被拒也已通过真实 API 验证。
两份电量/推送 YAML 合同共 36 条 required 用例，本轮是上述专项验证，尚未完成全部用例的独立逐条验收。

同日已用当前本地代码的 Profile 构建升级 iPhone 17（iOS 26.6.1），既有真机执行器验证启动、
连接管理和返回首页通过，原登录和连接保留。当前 Personal Team 不支持 Push Notifications，
该安装通过本地空 entitlement 文件和 `RUNWEAVE_APNS_ENVIRONMENT=disabled` 构建，未启用 APNs。
本机桌面端随后更新到 0.208.0，安装态 Backend 的鉴权电量接口返回 52%/battery/discharging，与系统读数一致；
未再次验证手机刷新后的电量。证据分别位于执行机器 `.runweave/battery-phone/` 和 `.runweave/battery-desktop/`。

真实 sandbox/production 锁屏、前台 APNs 和点击通知路由未执行：可用推送签名、APNs 私钥与集中部署未配置。
远程 Mac、真实手机离线撤销、完整后台时序、命令超时恢复、
异常文件系统与完整多连接交互仍需按 YAML 合同补齐。构建或本地注入结果不能替代这些门槛。
