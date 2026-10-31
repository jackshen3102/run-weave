# 屏幕记录一期实施计划：独立 Mac 采集与本地存储

日期：2026-10-31。状态：计划待评审，尚未开始实现。

范围依据：[整体讨论稿](2026-10-31-screen-recording-plan.md)。本文件是一阶段的实施依据；二阶段的 Mac／Runweave iOS 查看、网络访问、模拟器验收不进入一期。

## 1. 一期交付与明确边界

交付一个独立原生 Mac 工具，能够在用户启用后，持续按 Dayflow 的基本策略采集屏幕，将媒体和实际时间索引保存在本机，并按期限与容量自动清理。Runweave、RemoteDesk 和模型服务均不是运行前提。

完成标准是“全天采集的数据可靠、可解释、可以通过诊断工具读取”，不以浏览界面是否完成为标准。

一期包含：

- 屏幕录制授权、开始／暂停、运行状态、采集与保留配置、应用排除名单。
- 定时截图、活动显示器跟踪、休眠／锁屏暂停及恢复、输入空闲元数据。
- HEVC／MP4 分段、SQLite 时间索引、单写入者、故障恢复、7 天及容量清理。
- 本机只读诊断：状态、索引一致性、按记录 ID 抽取图片，供验证与排障使用。

一期不实现：Mac 截图浏览／时间线页面、iOS 改动、HTTP 服务、远程读取、配对、离线缓存、OCR、模型调用、语义事项归并、外部结果写回、随记写入、日报和多设备合并。不读取或迁移 Dayflow 的个人数据库，不增加账号、遥测或上传通道。

采集控制是必要操作界面，不属于二期的记录浏览。只设置菜单栏状态和一个简单设置窗口，不制作独立产品 UI 原型。

## 2. 技术结论与来源

### 2.1 技术栈

采用 Swift、SwiftUI／AppKit、ScreenCaptureKit、AVFoundation 和系统 SQLite3。原生 Mac App 独立构建；本期不引入 Electron、Tauri、Node 服务或新数据库依赖。

支持基线定为 macOS 15+，一期验证当前 Apple Silicon Mac；这与仓库原生 Mac 工程基线一致，不承诺未经验证的 Intel 支持。若设备不支持所需 HEVC 编码，显示明确错误，不静默改成无上限图片缓存。

工程暂用名 `ScreenJournal`，包路径 `packages/screen-recording-macos`，Bundle ID `com.runweave.screen-journal`。这些是本计划的实现命名建议；首次正式授权前固定身份，之后升级保持不变。

### 2.2 固定 Dayflow 参考版本

本计划以提交 `730d6f84b919998158ff7fdab15e3f032f7d8135` 为研究基线，避免实现过程中追随 main 漂移。逐模块移植适用逻辑，不整体 fork 产品，也不直接移入其全局单例依赖链。

| 源码                                                                                                                                                                                     | 已核实的参考内容                                                                           | 本期处理                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| [RecordingPreferences.swift](https://github.com/JerryZLiu/Dayflow/blob/730d6f84b919998158ff7fdab15e3f032f7d8135/Dayflow/Dayflow/Core/Recording/RecordingPreferences.swift)               | 默认 10 秒、1080 高度；间隔选项 1／5／10／20／30／60 秒，高度 720／1080                    | 保持参数基线，修改后封口旧段再应用                   |
| [ScreenRecorder.swift](https://github.com/JerryZLiu/Dayflow/blob/730d6f84b919998158ff7fdab15e3f032f7d8135/Dayflow/Dayflow/Core/Recording/ScreenRecorder.swift)                           | 定时截图、应用排除、输入空闲元数据、锁屏休眠响应                                           | 保留行为，移除模型、账户及遥测依赖                   |
| [ActiveDisplayTracker.swift](https://github.com/JerryZLiu/Dayflow/blob/730d6f84b919998158ff7fdab15e3f032f7d8135/Dayflow/Dayflow/Core/Recording/ActiveDisplayTracker.swift)               | 根据鼠标所在显示器跟踪目标，轮询与防抖                                                     | 沿用；不改成同时采集所有屏幕                         |
| [FrameStore.swift](https://github.com/JerryZLiu/Dayflow/blob/730d6f84b919998158ff7fdab15e3f032f7d8135/Dayflow/Dayflow/Core/Recording/FrameStore.swift)                                   | HEVC／MP4，600 秒或 600 帧封段，关键帧间隔 30，质量目标 0.55；编码帧时间与真实采集时间分离 | 保留编码参数起点；重建明确的持久化状态和恢复接口     |
| [RecordingPrivacyPreferences.swift](https://github.com/JerryZLiu/Dayflow/blob/730d6f84b919998158ff7fdab15e3f032f7d8135/Dayflow/Dayflow/Core/Recording/RecordingPrivacyPreferences.swift) | 应用标识规范化、敏感应用初始名单、前台与背景应用排除                                       | 初始化后允许用户编辑，保存可供检查的实际名单         |
| [AnalysisManager.swift](https://github.com/JerryZLiu/Dayflow/blob/730d6f84b919998158ff7fdab15e3f032f7d8135/Dayflow/Dayflow/Core/Analysis/AnalysisManager.swift)                          | 空闲批次可跳过模型并合并空闲卡片                                                           | 一期保存空闲证据，不导入任务调度、卡片归并和模型处理 |

该提交的 [LICENSE](https://github.com/JerryZLiu/Dayflow/blob/730d6f84b919998158ff7fdab15e3f032f7d8135/LICENSE) 为 MIT。移植文件保留版权及许可证，包内记录原路径、提交和本地修改说明。上游其他依赖不随代码片段自动引入。

当前仓库依据：[RemoteDesk project.yml](../../packages/remote-desktop-host/project.yml)、[build-host.sh](../../packages/remote-desktop-host/build-host.sh)、[DesktopCapture.swift](../../packages/remote-desktop-host/Sources/RunweaveRemoteHost/DesktopCapture.swift)。仅借鉴独立原生工程和构建方式；不改动其实时远控、配对、H.264 队列和生命周期。

## 3. 运行行为与资源参数

### 3.1 生命周期

- 首次启动保持未采集。用户在本机授权并点击开始后才采集；查看权限状态不得循环触发授权弹窗。
- 菜单栏显示运行、手动暂停、系统暂停或错误；设置窗口显示最近一次成功采样、错误原因、存储用量及当前排除名单。
- 关闭设置窗口不停止采集。手动暂停立即失效当前采集代际，丢弃迟到帧并封口已有段；解锁、唤醒不得解除手动暂停。
- 锁屏、休眠和图形用户会话失活时暂停；恢复后延迟 5 秒，重新检查权限和目标显示器，仅在用户仍希望记录时继续。
- 保存用户期望的启停状态。异常进程退出后的下次手动启动恢复原期望状态；明确点击退出先保存停止状态并封段。第一期不安装自动登录项或后台守护进程。
- 同一数据目录只有一个实例持有进程锁。第二实例退出并提示已运行，不能并行打开写入队列；锁依靠系统文件锁释放，不凭陈旧 PID 强杀进程。

状态建议为 `stopped / starting / recording / pausedSystem / blockedPermission / blockedStorage / failed`，另存 `desiredRecording`。错误重试不能改变用户的期望状态。

### 3.2 采集合同

- 默认 10 秒采样，1080 像素高，按比例缩放并满足编码尺寸要求；不录音，不采集键入内容。
- 每帧保存实际采集时间、设备 ID、会话 ID、会话内递增序号、显示器 ID、图像尺寸、可得的前台应用 bundle ID 与输入空闲秒数。空闲读取失败保存空值，不冒充 0 或永久空闲。
- 无键鼠输入仍可记录；不引入“用户无输入就删掉记录”的额外规则，不把观看视频或阅读直接判成没工作。
- 只允许一个采集请求及一个编码写入任务在途，不积压过期截图；忙碌时跳过该 tick 并计数。暂停或配置变化增加代际，旧请求返回后再次核验代际再写入。
- 目标屏幕变化或尺寸变化时封口旧段，新段保存新 display ID。显示器消失时刷新目标列表，无法确定目标就暂停并记录原因，不把旧画面当新采样。
- 采集请求失败采用 60／120／300／600 秒退避，恢复成功后回到正常间隔；连续故障达到 10 分钟转明确错误状态，等待用户恢复。权限撤销直接进入权限阻塞，不持续请求授权。
- 单次请求超过 30 秒时显示超时且不再提交新的请求；不能因“超时”就让不可取消的旧请求和新请求并发。迟到结果丢弃，实际释放资源后再进入恢复路径。

### 3.3 应用排除

屏蔽规则在采集前生效，默认按 Dayflow 的敏感应用识别规则生成一次初始名单；不读取用户现有 Dayflow 设置。设置支持选择已安装应用或输入 bundle ID。

- 被排除应用在前台：不截图真实画面，保存通用隐私占位图和 `privacyPlaceholder` 标记。
- 被排除应用在背景但窗口仍可见：通过 ScreenCaptureKit 应用过滤排除其窗口。
- 每次采样刷新或验证应用清单及排除规则版本；无法构造可信过滤条件时跳过并记错误，不回退到未过滤的全屏。
- 写入前再次核对规则版本和前台敏感状态；规则改变或前台检查出现敏感应用时丢弃在途结果，下一采样使用新规则。系统通知、浏览器内密码、网页 URL 过滤不在应用级排除保证内。
- 前台被排除时不落应用名称等额外敏感元数据，只保存屏蔽状态。普通记录保存 bundle ID，不额外读取窗口标题、剪贴板或辅助功能文本。

### 3.4 默认资源预算

用户已确认保留 7 天、可调整、另设容量上限。为使计划可执行，下面给出工程默认值；它们是建议值而非实测结果，首轮全天验证后可据证据调整。

| 参数             | 一期取值                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| 原始材料保留     | 7×24 小时；设置范围 1～30 天                                                                                  |
| 数据目录容量预算 | 默认 10 GiB；设置范围 1～100 GiB                                                                              |
| 卷剩余空间保护线 | 1 GiB；低于此值停止新采集，不删除其他应用数据                                                                 |
| 数据段封口       | 最长 600 秒或 600 帧，取先到者；停止、尺寸／显示器／采集配置变化也封段                                        |
| 编码             | HEVC／MP4，质量 0.55；平台不支持质量模式时使用上游按像素数缩放的码率配置，不改变真实采集间隔                  |
| 清理触发         | 启动恢复后、每 60 秒、封段后、用户降低保留或容量设置后                                                        |
| 采集资源验收目标 | 默认参数下连续 8 小时；进程树平均 CPU 不高于单核 5%，RSS 峰值不高于 300 MiB；超标时定位后调整，不能声称已达标 |

容量统计包括媒体、SQLite／WAL／SHM、配置、临时文件和日志；日志轮转控制在 10 MiB，不记录截图内容。活动文件可能造成短暂越限，下一次检查必须封段并清理至不超预算；无法做到则停止采集并明确报错，不能长期以“活动文件不可删”为由绕过预算。

## 4. 持久化与恢复设计

### 4.1 数据目录与结构

正式目录为 `~/Library/Application Support/ScreenJournal/`，目录权限 0700、敏感文件 0600。设置、数据库、媒体均使用独立身份，不共用 Runweave／RemoteDesk／Dayflow 的数据文件或密钥。Debug 支持显式隔离目录；Release 不接受任意路径注入。

验证用 Debug 参数统一为 `--validation-data-dir`、`--validation-max-bytes` 和 `--validation-free-bytes`；后两项分别覆盖配额与卷空间探测，仅在显式隔离目录下生效，状态和日志必须显示注入标识。Release 拒绝这些参数。fixture 工具仅接受新的空白隔离目录并生成资源清单，禁止覆盖已有材料或正式目录。

```text
ScreenJournal/
  settings.json
  records.sqlite
  media/<segment-id>.mp4
  pending/<segment-id>.mp4
  runtime/status.json
  logs/
  writer.lock
```

SQLite 使用 WAL、外键和单写入队列，优先保证提交的可恢复性；schema 以 `PRAGMA user_version` 管理。建议最小表：

| 表             | 必要字段                                                                                                                                             |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `device`       | 稳定随机 `device_id`、创建时间                                                                                                                       |
| `sessions`     | `id`、开始／结束时间、正常结束标记                                                                                                                   |
| `segments`     | `id`、相对路径、`writing/ready/deleting/unavailable` 状态、起止实际时间、尺寸、显示器 ID、帧数、字节数、故障原因                                     |
| `captures`     | 稳定 `id`、session ID、递增序号、segment ID、frame index、UTC 毫秒时间、时区偏移、display ID、前台 bundle ID（可空）、idle seconds（可空）、占位标记 |
| `state_events` | 起止时间、状态、原因码、受影响的采样数量；连续同类原因合并，避免每秒追加日志                                                                         |

唯一约束至少包含 `(segment_id, frame_index)` 与 `(session_id, sequence)`；按采集时间索引。真实时间保存 UTC，显示时再按时区转换；会话内序号用于识别系统时钟回拨，不能用 MP4 播放位置推算实际时间。

### 4.2 写入协议

1. 创建 `writing` 段及 pending 文件；编码接受一帧后再写对应 capture 索引。此时记录是暂存，诊断不能把它宣称为已落稳。
2. 到封口条件后结束编码，验证媒体可读和帧数与索引匹配。以每帧 1 秒的媒体 PTS 编码只是存储布局；真实时间只由 captures 决定。
3. 对文件落盘、同卷原子改名到 media，再在事务中把段改为 `ready` 并更新真实字节数。文件与 SQLite 无法共享原子事务，必须由启动恢复覆盖中间状态。
4. 封口操作最长等待 30 秒；超时进入失败状态，不删除仍被 writer 使用的文件，不并发启动替代 writer。下次启动统一恢复。正常退出失败应报告未完成封口，不能报告保存成功。

关键限制：最长 10 分钟分段意味着异常终止可能损失当前尚未封口的段。计划不承诺每次截图都已可恢复；已封口的 ready 段不得因新段失败而丢失。若实测发现该损失窗口不可接受，应缩短封段参数后重新验证，而不是隐瞒损失。

### 4.3 启动恢复与清理

启动获得独占锁后，先恢复再采集：逐个检查未完成段、删除中段和文件目录；不只检查最近一条记录。可解码且索引一致的段补全提交，不可恢复的段记录明确缺口并回收。未知文件不直接拼进时间线；仅处理本目录内符合自身文件命名和记录归属的资源。

清理使用同一协调器串行执行，先将候选 ready 段标记 `deleting`，移除媒体后在事务中删除其 captures 和段行；中断后重新执行必须幂等。删除失败保留状态并计入实际用量，禁止把仍在磁盘上的文件从统计中消失。

过期按 UTC 实际时间计算。以整段为删除单位：段内最早一帧过期即整段删除，因此边界附近最多提前删除一个段内的较新记录（默认不超过约 10 分钟）；不为保住边界帧而把过期内容无限延长。运行中清理滞后上限为一次 60 秒调度加实际 IO；进程未运行时无法物理清理，重启恢复后先清理再继续。二期读取接口还必须过滤已过期记录。

配额删除按最早段优先，永不触碰外部路径、符号链接指向的其他目录或未释放 writer 的文件。无足够候选段时先停止采集并安全封口，再清理；仍不满足配额则保持存储阻塞。state_events、日志也需有界，不长期保留每一条过期 capture 的墓碑。

## 5. 本机合同与未来扩展边界

一期没有网络 API。App 内部通过以下职责接口解耦，名称可按 Swift 风格调整但语义不变：

```text
CaptureCoordinator.start() / pause() / shutdown()
CaptureCoordinator.apply(settings)
FrameStore.append(image, metadata) -> pendingCaptureID
FrameStore.finalize(reason) -> committedSegmentID
RecordStore.reconcile() -> RecoveryReport
RetentionCoordinator.enforce(now) -> CleanupReport
```

提供同工程命令行 target `ScreenJournalInspect`，只读，不启动 App 或申请屏幕权限：

- `status --data-dir <目录> --json`：读取运行状态、schema、ready/pending 数量和磁盘统计；状态须包含 PID／更新时间，陈旧状态标记不可确认。
- `verify --data-dir <目录> --json`：要求写入者已停止，检查 SQLite 完整性、外键、ready 媒体存在性、所有段的可解码帧数及索引对应关系；异常非零退出。
- `extract --data-dir <目录> --capture-id <ID> --output <新文件>`：要求写入者已停止，按 frame index 解码 ready 且未过期记录，输出图片；原图不存在、过期、段未提交、目标文件已存在分别返回明确错误，不覆盖文件。

这些诊断命令不是手机接口或完整浏览产品。二期围绕稳定 capture ID 和已提交段增加查询与访问授权，不让消费者直接修改 SQLite；第三期再引入独立分析结果存储。

## 6. 文件范围

以下均为计划新建，尚未存在。主目录 `packages/screen-recording-macos/`：

| 路径                                                                                                                                          | 职责                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `AGENTS.md`、`README.md`                                                                                                                      | 原生边界、运行、授权、诊断、异常恢复和验收入口                                         |
| `project.yml`、`Info.plist`、`ScreenJournal.entitlements`、`.gitignore`                                                                       | XcodeGen 工程、固定身份、必要权限及生成物忽略                                          |
| `build.sh`                                                                                                                                    | 独立构建 App 与 Inspect；不安装、不启动、不触发采集                                    |
| `Sources/ScreenJournalApp/ScreenJournalApp.swift`、`RecorderModel.swift`、`SettingsView.swift`                                                | 菜单栏、设置窗口、状态呈现和动作路由                                                   |
| `Sources/ScreenJournalCore/CaptureCoordinator.swift`、`ScreenCaptureAdapter.swift`、`ActiveDisplayTracker.swift`、`SystemStateObserver.swift` | 串行状态机、系统截图、显示器及系统事件                                                 |
| `Sources/ScreenJournalCore/RecordingSettings.swift`、`PrivacyFilter.swift`、`CaptureMetadata.swift`                                           | 配置、隐私规则、原始采样合同                                                           |
| `Sources/ScreenJournalCore/FrameStore.swift`、`SegmentWriter.swift`、`SegmentReader.swift`                                                    | 段生命周期、编码及只读解码                                                             |
| `Sources/ScreenJournalCore/RecordStore.swift`、`StoreSchema.swift`、`RecoveryCoordinator.swift`、`RetentionCoordinator.swift`                 | SQLite、迁移、恢复及清理协调                                                           |
| `Sources/ScreenJournalCore/RuntimeStatus.swift`、`InstanceLock.swift`                                                                         | 只含运行元数据的状态快照与单实例锁                                                     |
| `Sources/ScreenJournalInspect/main.swift`                                                                                                     | 只读诊断命令；复用必要的存储模型与 reader，不编入 App 启动入口                         |
| `tools/make-validation-fixture.swift`                                                                                                         | 仅生成隔离的过期／配额／未完成段材料，拒绝正式数据目录；不作为单元测试或自动化通过判定 |
| `ThirdPartyLicenses/Dayflow-MIT.txt`、`ThirdPartyLicenses/README.md`                                                                          | 上游许可证、固定提交与移植清单                                                         |

核心文件作为两个 target 的按需共享 source groups，不在本期提前抽取通用远程协议包。保持单文件职责与仓库架构门禁，不能把完整上游大文件和全局单例原样堆入新包。

实施时只按需更新 `docs/architecture/README.md` 增加独立运行时入口，更新 `docs/README.md` 指向包 README。不改 backend、electron、frontend、app-ios、remote-desktop-_、suiji-_ 业务代码，不在根 package.json 增加无必要入口。

## 7. 执行顺序与交付物

- [ ] **任务一：固定来源和建立工程。**核对上述提交与许可证；建立独立 App、Inspect、数据目录和实例锁。产出能编译运行的未采集状态；关闭设置窗口后菜单栏仍存在，build 不启动 App。
- [ ] **任务二：采集状态机和隐私过滤。**接入权限、10 秒定时、显示器、系统暂停与代际；使用受控屏幕内容核验前台占位和背景窗口过滤。配置更新后不能写入旧策略画面。
- [ ] **任务三：分段与事务索引。**完成编码、ready 提交、Inspect verify/extract；在停止后抽样首／中／尾帧核对实际画面与采集时间。忙碌跳过不得造成索引错位。
- [ ] **任务四：恢复与保留。**完成异常退出、文件缺失、删除中断和配额规则；只在显式隔离数据目录制造故障，正式记录不得作为破坏性验收材料。
- [ ] **任务五：配置与诊断收口。**完成排除名单、保留天数、容量、状态及错误可见性；清理敏感日志，不引入网络请求、登录项或展示页面。
- [ ] **任务六：真实 Mac 持续验证。**执行配套 YAML；记录构建来源、权限、采样统计、资源测量和实际抽帧。完成一段至少 8 小时的真实会话；不足时如实标记该项未完成，不用 fixture、短跑或模拟器替代。
- [ ] **任务七：文档与交付。**更新包 README 和架构入口，报告通过／失败／阻塞与未封口段的损失边界。代码提交、安装到固定正式目录以及二期实现按后续授权执行，不因计划完成自动启动。

## 8. 验证入口与验收合同

配套计划：[一期采集与存储验收](../testing/screen-recording/capture-storage.testplan.yaml)。它描述待实现合同，不代表功能当前存在；本轮仅通过 YAML 格式检查。

实施后的构建与诊断入口按以下合同提供，命令目前尚未存在：

```bash
packages/screen-recording-macos/build.sh --configuration Debug --derived-data-path .runweave/screen-recording/build
.runweave/screen-recording/build/Build/Products/Debug/ScreenJournalInspect status --data-dir "$HOME/Library/Application Support/ScreenJournal" --json
.runweave/screen-recording/build/Build/Products/Debug/ScreenJournalInspect verify --data-dir "$HOME/Library/Application Support/ScreenJournal" --json
```

`verify` 前必须正常停止采集和退出 App；启动／暂停从真实 Mac 原生控件执行并记录后置状态。故障用例使用 Debug 的 `--validation-data-dir` 隔离目录，禁止以正式目录填满磁盘或强杀其他应用。故障注入必须显式记录为注入证据；资源与真实采样用实际运行取证。

构建通过只证明编译；verify 通过证明本次停止后的索引／媒体一致性；全天运行、系统状态变化和隐私排除必须分别取证。

全天覆盖目标：以启用且未系统暂停的时间计算应有采样 tick，成功采样不少于 99%；忙碌丢弃、采集错误和编码失败都计为缺失，不能从分母中排除来提高成功率。系统暂停、手动暂停和隐私占位需单独统计。CPU 使用进程树累计 CPU 时间除以观测墙钟时间，按单核 100% 口径计算；RSS 每分钟采样并记录峰值，另保留实际磁盘增长。

文档及实现门禁：

```bash
pnpm docs:check
pnpm testplan:validate docs/testing/screen-recording/capture-storage.testplan.yaml
pnpm architecture:check
git diff --check
```

计划阶段仅执行前两项及文本检查；架构和原生构建在实现后执行。不新增单元测试，不启动 iOS 模拟器或 Dev Session。

## 9. 主要风险与回退

- **敏感画面误入库：**采集前过滤、在途结果校验和可检查名单为一期必需；不能用二期隐藏图片弥补。权限、清单刷新失败时停止相关采样。
- **异常退出损失：**当前未封口段可能丢失，已提交段必须保全；报告具体时间区间，不能把 pending 行计为可回看记录。
- **删除造成不可逆损失：**时间／容量清理属于明确产品规则；边界段可能提前删除。验收只使用隔离材料，数据目录外的路径一律拒绝删除。
- **原生权限身份变化：**固定 Bundle ID 和安装路径后再做正式授权验证；重签或移动产物造成权限变化需要重新检查，不能修改系统权限数据库。
- **运行时耦合：**不复用 RemoteDesk 会话或 Runweave 进程生命周期，二期接入只能消费本工具的数据接口。
- **迁移和回退：**一期 schema v1；后续 schema 升级使用事务及升级前 SQLite 一致性备份。旧版本遇到更高 schema 必须拒绝写入。回退 App 不自动回滚用户数据库，也不删除已记录媒体；关闭采集工具即可停止新增数据。

完成本期后，再细化二期的在线查询、Mac 浏览、Runweave iOS 原生页面与模拟器验证。
