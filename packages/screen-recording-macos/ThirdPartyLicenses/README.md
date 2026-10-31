# Dayflow 来源

固定研究／移植基线：[JerryZLiu/Dayflow@730d6f84b919998158ff7fdab15e3f032f7d8135](https://github.com/JerryZLiu/Dayflow/tree/730d6f84b919998158ff7fdab15e3f032f7d8135)。
版权与 MIT 授权完整保存在 [Dayflow-MIT.txt](Dayflow-MIT.txt)，并随 App 打包。

| 上游 `Dayflow/Dayflow/Core/Recording/` 文件 | 本地处理                                                                                                                   |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `RecordingPreferences.swift`                | `RecordingSettings.swift` 保留 10 秒／1080 默认值及可选值，以 JSON 保存独立配置                                            |
| `RecordingPrivacyPreferences.swift`         | `PrivacyFilter.swift` 移植敏感应用名称／bundle 提示规则与应用扫描，去掉全局 UserDefaults，首次初始化独立名单               |
| `ActiveDisplayTracker.swift`                | `ActiveDisplayTracker.swift` 重新实现鼠标目标轮询与 500ms 防抖，不依赖上游单例                                             |
| `ScreenRecorder.swift`                      | `ScreenCaptureAdapter.swift` 与 `SystemStateObserver.swift` 参考单帧截图、应用排除、HID 空闲及系统事件行为；协调器独立重写 |
| `FrameStore.swift`                          | `SegmentWriter.swift` 沿用 HEVC、0.55 质量、按像素缩放码率回退、关键帧 30、1fps PTS 和像素缓冲方式；写入提交及恢复独立重写 |

600 秒／600 帧上限沿用上游参数。像素转换改用系统 Core Image 的复用 context，关闭中间缓存，
避免逐帧 Quartz 绘制缓存造成 RSS 峰值增长；编码格式及时间索引不变。
未移入账户、模型、分析调度、遥测、云服务、第三方依赖或用户数据库。

## 二期回放参考

同一固定提交的 `Views/UI/MainView/ScreenshotSlideshow.swift`、
`ScreenshotSlideshowPlayback.swift` 和 `Core/Recording/FrameStore.swift` 用于核对实际时间倍速、
顺序 reader、预取和有界缓存的设计。`JournalPlaybackModel`、`PlaybackFrameReader` 与 iOS
`ScreenRecordingPlaybackModel` 为本项目独立实现；未复制上游 SwiftUI 或新增其第三方依赖。
本项目额外实现 owner 读取许可、在线认证、快照、保留清理和失效代际；不采用后台延时视频生成。
现有 `SegmentWriter` 的代码改写来源与 MIT 文本保持随 Mac App 分发。

## 三期事项分析参考

同一固定提交的 `Core/Analysis/AnalysisManager.swift`、`Core/AI/LLMTypes.swift`、
`ClaudeTimelinePrompt.swift`、`CodexProvider+Timeline.swift`、`OneStepTimelineSupport.swift`
及 `Core/Analysis/IdleBatchClassifier.swift` 用于核对 60 秒检查、15 分钟批次、2 分钟缺口、
45 分钟上下文、代表帧和输入空闲语义。`AnalysisCoordinator`、Backend analysis worker、
专属 provider 与验证器为本项目独立实现，未引入上游运行时或依赖。
本项目保留不足五分钟短尾，使用上海自然日、owner 租约和原子修订；不采用最短活动门槛、
凌晨四点日界或每日解锁限制。Daily Recap 的分层思路接入既有 Daily Record，未移植调度器。
