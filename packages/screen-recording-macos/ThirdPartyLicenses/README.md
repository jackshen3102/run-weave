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
