# 随记 iOS 无埋点接入方案

状态：已获用户批准并完成接入代码；2026-10-02。验收进行中，Release 暂保持关闭。

当前进展：正式项目 `yr5biwkeyf` 与 QA 项目 `yr5czuz2mq` 已创建，均配置 Strict masking 与关闭 WebView DOM capture。
SDK 4.1.0、独立适配层、页面分类、安装包标签、敏感视图遮盖与用户披露已实现。
已通过：Debug/Release 模拟器与 Debug 真机构建；QA 原生合成数据流程；云端页面分类与正文、图片附件、纠错、AI 问答回放遮盖。完成待办后的返回首页与刷新也已在原生流程验证。
关闭、空 ID、非法 ID、模拟器正式 ID 四种运行时均无 SDK 会话；这不是网络抓包证明。
iPhone 17 的 USB、解锁与 Developer Mode 检查通过。底层 XCTest 空操作诊断通过后，agent-device 页面通道已恢复；默认关闭与 QA 开启版本均已在真机确认运行时使用分析状态。
真机合成数据已验证：完成待办后返回首页并重新请求列表、约 8,000 字正文编辑与输入、放弃本机测试草稿。测试未保存到真实业务服务。
同手机编辑页单次驻留内存样本：关闭 276,672 KiB、QA 开启 232,544 KiB（xctrace Activity Monitor）。一次关闭样本导出失败，且两个成功样本不是重复基准；不能据此宣布完整性能验收通过。
仍待验收：云端五个安装包标签（再次核对仍无可用自定义标签）、全部敏感输入/页面逐项遮盖、云端真机会话回放和会话重建后的页面恢复、启动/长列表滚动与编辑的多轮性能、断网/上传失败下业务流程，以及关闭版本无采集网络请求。Release 保持 `NO`，以上门槛完成前不切换为正式采集。

现行配置与操作入口见 `packages/suiji-ios/README.md`；下文保留原批准方案，不能将计划中的检查视为已通过。

## 目标和范围

按当前手机端上下文，将随记原生 iOS 接入 Microsoft Clarity，参考 Runweave iOS 的自动采集、固定页面分类和构建信息标签。暂按“新做一个应用”指在 Clarity 后台新建随记独立 Mobile/iOS 项目理解；如果指开发另一个产品，应另行界定范围。

本轮按用户批准实施原生 iOS 接入。
第一阶段覆盖随记 iOS；Runweave 内随记抽屉沿用现有 Web 采集。独立随记 Web 若要接入，另用 Web 项目和启动入口设计，不能把原生 SDK 用于网页。

## 实施前代码事实

- Runweave iOS 在 `packages/app-ios/Package.swift` 固定 Clarity SDK 4.1.0，在 `ios/RunweaveNative/RunweaveNativeApp.swift` 的 App 初始化入口调用采集初始化。
- `packages/app-ios/Sources/RunweaveIOS/Services/MobileAnalytics.swift` 处理一次初始化、固定页面名称、可见层级和会话开始后的分类恢复。
- 同目录的 `AppBuildMetadata.swift` 上报 `app_version`、`app_build`、`build_id`、`source_revision`、`source_state`。这些来自本机已安装包，不能使用连接的服务端版本冒充。
- Runweave iOS Release 真机默认启用；Debug/Profile 默认关闭；模拟器拒绝生产项目 ID。生产项目使用 Strict masking，关闭 WebView DOM capture。代码还对敏感展示与输入显式遮盖。
- 随记目前没有 Clarity 依赖、初始化入口或构建设置。其入口是 `packages/suiji-ios/ios/Suiji/SuijiApp.swift`，已有 `IOSBuildIdentity` 依赖。
- 随记包禁止导入 RunweaveIOS；可以参考实现方式，不能通过引用整个 Runweave App 获得采集功能。
- 当前 Web Clarity 已记录随记抽屉打开事件；这不代表独立随记 iOS 已采集。

## 建议的数据链路

随记 App → Clarity iOS SDK → 随记独立 Clarity Mobile 项目 → 后台会话、页面与回放筛选。

业务 API、草稿和数据库保持原有链路。无需新增随记 Backend 埋点接口、存储表、上传队列或每按钮手写事件。点击与回放用于观察使用过程，不能作为保存、完成待办等业务成功的证明。

### 独立项目

正式项目建议命名为 `Suiji iOS`；验收项目建议命名为 `Suiji iOS QA`。正式与测试使用不同项目 ID，不复用 Runweave 的 Web/iOS 项目。

项目创建后先配置 Strict masking、关闭 WebView DOM capture、核对管理员权限与用户披露，再接入正式数据。项目 ID 是公开标识，不是访问后台的凭据。

### 采集和筛选维度

SDK 自动采集页面交互与会话回放；客户端补充固定页面名称和安装包标签。

| 维度         | 建议内容                                                                                                                                                                                                              |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 页面         | `connecting`、`login`、`records`、`tasks`、`trash`、`record_detail`、`record_editor`、`followups`、`followup_editor`、`ai_review`、`connection_settings`、`attachment_preview`、`correction`、`browser`、`build_info` |
| 版本标签     | 与 Runweave 一致的 `app_version`、`app_build`、`build_id`、`source_revision`、`source_state`                                                                                                                          |
| 页面附加内容 | 不附加正文、标签名、搜索词、文件名、URL、记录 ID、用户名或服务地址                                                                                                                                                    |
| 身份         | 不调用自定义用户身份设置，不上传 ownerId/serverId、登录 token、设备或连接业务标识；SDK 自身会话标识仍用于 SDK 会话处理                                                                                                |

详情、编辑器和弹层显示时优先报告实际可见页面；关闭后恢复底层页面。Tab 切换、返回首页刷新、连接环境切换和新 SDK 会话都要保持分类正确。正文内容更新不触发页面分类改变。

### 遮盖

全局 Strict masking 外，敏感视图显式遮盖：登录输入、服务地址、搜索输入、正文、标签、跟进内容、AI 问题和回答、纠错内容、附件图片/文件名/预览、错误提示里的动态内容和浏览器地址/标题/网页。

`RecordBody.swift` 的正文是 UIKit UITextView，需要在创建视图时调用原生遮盖 API，不能只检查 SwiftUI Text。浏览器遮盖放在随记宿主，不让通用 browser-ios 包依赖 Clarity。

不添加 unmask。SwiftUI 输入必须逐个检查；官方 iOS 文档指出不能依赖统一强制输入遮盖。后台规则变更不会追溯遮盖已上传会话，因此先配置再开始验收。

### 构建配置

新增 `SUIJI_CLARITY_ENABLED` 与 `SUIJI_CLARITY_PROJECT_ID`，通过 Info.plist 传给客户端。

- Debug/Profile 默认关闭、项目 ID 为空；显式启用时使用 QA 项目。
- Release 真机在已配置并完成验收的正式项目下默认启用；ID 未配置或不合法时不初始化。
- 模拟器禁止使用正式项目；测试必须显式传 QA ID。
- 保留构建关闭覆盖。关闭后重新构建安装，旧包不会因修改构建变量自动停采。
- 与 Runweave 当前策略一致，按构建配置控制；“正式/开发”连接选择不等同于构建渠道，不能把该选择当成 SDK 上传目标。若希望开发连接会话也排除，实施前单独确定暂停/恢复规则。
- SDK 加载或上传失败不影响列表、编辑、完成待办、草稿保存或 API 请求，不新增业务重试。

## 文件范围和实施顺序

1. 创建并配置两个 Clarity 项目，记录项目 ID 和遮盖设置；这一步在批准实施后进行。
2. 修改 `packages/suiji-ios/Package.swift` 与相关 `Package.resolved`，固定依赖版本。优先对齐 Runweave 4.1.0，实施时验证该版本的下载、iOS 26.6.1 与 SwiftUI 兼容性，不直接使用 main 分支。
3. 新增 `Sources/SuijiIOS/Services/MobileAnalytics.swift` 与 `AppBuildMetadata.swift`：随记自己的薄适配层，沿用固定分类、可见层级和安装包标签语义。当前不抽取跨 App 通用框架，不修改 Runweave 采集实现。
4. 修改 `ios/Suiji/SuijiApp.swift`、`ios/Suiji/Info.plist`、`ios/Suiji.xcodeproj/project.pbxproj`：宿主主线程一次初始化、构建开关与项目 ID。
5. 在 `App/SuijiRootView.swift`、`Features/ConnectionViews.swift`、`RecordDetail.swift`、`RecordEditorSheet.swift`、`FollowupsView.swift`、`ReviewView.swift`、`CorrectionPanel.swift` 和 `Features/Browser/SuijiBrowserHost.swift` 添加页面分类与敏感内容遮盖。补查 `DesignSystem/RecordBody.swift`、`TagViews.swift` 和 `Components.swift` 中正文、标签、附件与动态展示。
6. 更新 `packages/suiji-ios/README.md` 与 `Resources/PrivacyInfo.xcprivacy` 中经 SDK 实际数据行为核对后需要修改的披露。隐私清单与用户披露分别检查，不能将二者互相替代。

路径在未给出包前缀时均相对 `packages/suiji-ios/`。计划实施不改变业务协议与草稿格式，不新增数据库迁移。

## 验收和回滚

本方案用以下手动检查清单验收，不在方案阶段新建测试资产；当前只有 Web 自动采集 YAML 合同，不能宣称它覆盖原生随记。

- 通过包入口构建 Debug 与 Release。关闭构建不初始化 SDK，不新增采集网络请求；非法/空 ID 同样保持关闭。模拟器对正式 ID 拒绝初始化，对 QA ID 可开展验收。
- 用 agent-device 在托管模拟器或指定真机操作：登录 → 首页 → 待办 → 详情 → 完成后首页 → 编辑器 → 跟进 → AI → 浏览器。核对实际可见页面分类；弹层关闭、新会话恢复和返回首页刷新后分类一致，无短暂底层误报。
- 给所有敏感展示与输入放入不同合成标记，检查采集数据和云端回放。正文、标签、服务地址、附件、AI、浏览器和 UIKit 正文分别检查；任一标记泄漏则不能启用正式项目。
- Clarity 后台确认会话归属随记项目、安装包标签吻合本次产物、页面名称可筛选。客户端网络请求和初始化成功只证明尝试采集，后台回放不可访问时记未通过。
- 同一手机、同一操作脚本对比开/关采集的启动、长列表滚动、长正文编辑和完成待办流程；记录耗时、卡顿与内存证据。出现崩溃、操作失效、草稿变化或明显新增主线程阻塞即失败。
- 检查断网、上传失败时业务仍正常。构建关闭版本重新安装后确认新进程无采集；已上传历史数据不因此删除。
- 实施时按包 README 构建和安装；UI 使用 agent-device；新增配置读取按仓库质量规则登记。文档检查执行 `pnpm docs:check`，代码检查执行 `git diff --check`。构建、安装、原生交互、遮盖、云端回放分别报告。

回滚首先使用 `SUIJI_CLARITY_ENABLED=NO` 重建安装；必要时回退 SDK 和适配层代码，不回退待办业务改动、不清理用户草稿或登录。

## 外部依据

- [官方 iOS SDK 安装与 API](https://learn.microsoft.com/en-us/clarity/mobile-sdk/ios-sdk)：SwiftUI App 初始化、主线程要求、会话回调、屏幕命名与输入遮盖限制。
- [官方 Mobile 遮盖文档](https://learn.microsoft.com/en-us/clarity/mobile-sdk/clarity-sdk-masking)：Strict 模式、SwiftUI/UIKit 遮盖、规则生效与非追溯行为。

## 已批准范围与后续边界

本次“新应用”按独立 Clarity iOS 项目实施，两个远端项目已创建。独立 Web 接入与排除 Release 包中的开发连接会话不在本轮范围，后续另行确定。当前采集开关按安装包配置控制。
