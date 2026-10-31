# ScreenJournal

独立 macOS 15+ 菜单栏屏幕记录工具，使用 ScreenCaptureKit、AVFoundation HEVC 和系统 SQLite。
提供独立采集、本地存储、Mac 原生回放与同用户 Unix socket 只读服务；Runweave iOS 经现有 Backend 认证在线查看。没有模型调用、额外 TCP 监听或登录项。

## 构建与使用

需要 Xcode 26+、XcodeGen。当前验证平台为 Apple Silicon；构建成功不代表权限或全天采集通过。

应用图标源为 `Resources/AppIcon.icon`：黑色背景与银白前景分层，由 Xcode 编译为原生图标资源及旧版 macOS 使用的 ICNS。不要仅复制 PNG 转换的 ICNS 替代它，否则系统可能额外添加浅色底板。

```bash
packages/screen-recording-macos/build.sh --configuration Debug --derived-data-path .runweave/screen-recording/build
```

产物在指定 DerivedData 的 `Build/Products/Debug/`，包含 `ScreenJournal.app` 与
`ScreenJournalInspect`。脚本只构建，不自动安装或启动。真实屏幕权限验收必须传 `--team TEAM_ID` 使用稳定开发者签名；省略时为临时签名，
每次重建的代码哈希可能使既有屏幕权限不匹配，只适合编译和合成材料验证。
正式安装及固定路径授权独立执行，重签或移动后需核对 macOS 屏幕权限。

打开 App 默认展示“录屏记录”，“整理事项”为辅助视图；打开主界面不自动开始采集。
通过主界面的授权提示处理屏幕录制权限，再点击工具栏的“恢复记录”。关闭窗口后
菜单栏继续运行；手动暂停不会因解锁或唤醒恢复。明确退出会保存停止状态并等待封段；
封段失败会提示，不声明已保存。异常退出后手动重新启动会恢复原先启用意图。

工具栏齿轮、`⌘,` 和菜单栏“设置…”统一打开主窗口内的设置面板；取消不应用草稿，保存后返回记录。
打开设置暂停回放，关闭面板不自动续播。设置包含采样间隔、高度、保留期限、容量与应用排除。首次按
[固定 Dayflow 来源](ThirdPartyLicenses/README.md)生成敏感应用名单，后续以保存的实际名单为准。
前台排除应用使用通用锁形占位；背景排除应用窗口在截图前过滤。网页内容和系统通知不属于
应用级排除保证。无输入不停止采集，保存可得的 HID 输入空闲秒数。

## 存储与恢复合同

### 压缩与体积验收

体积是核心约束。MP4 是封装，实际使用 HEVC/H.265 帧间压缩；不把每次采样保存成独立 PNG。
默认 10 秒采样、1080 高度、质量 0.55、每 30 帧关键帧，结合分段内相邻画面压缩。
PNG 仅用于显式诊断导出。7 天期限与 10 GiB 容量预算共同限制保留量；先达到容量预算时，
实际保留时间可能短于 7 天。

压缩验收同时记录媒体字节数、整个目录字节数、采样数和真实采集时长，并实际抽帧检查文字可读性。
分别覆盖静态阅读、网页滚动、应用切换和动态画面，不能用静态画面的小文件推算全天用量。
优化质量、码率或尺寸时使用同一批画面对比，保留帧索引、真实时间及可读性，不能只追求最小文件。
当前固定场景短跑（1662×1080、69 帧、680.207 秒）媒体为 300830 字节，
目录为 408010 字节；这只是静态为主场景的实测，不是全天容量承诺。

目录为 `~/Library/Application Support/ScreenJournal/`，0700；敏感文件 0600。
独占系统文件锁保证一个写入者。SQLite v1 使用 WAL、FULL 同步和外键，版本高于 v1 拒绝写入。
`settings.json`、`records.sqlite`、`media/`、`pending/`、`runtime/status.json` 均在该目录下。

每段最多 600 帧或 600 秒；显示器、尺寸、配置变化、暂停或退出也会封段。媒体第 N 帧的
PTS 为 N 秒，仅用于定位；真实时间来自 captures 的 UTC 毫秒与时区偏移，会话内序号不依赖时钟。
writer 接受后索引处于 writing。结束编码、逐帧解码核对、文件 fsync、同卷移动与 SQLite
提交后才变为 ready。异常退出可能损失当前最多约 10 分钟的未封口段，已提交段独立保留。

启动先恢复 writing／deleting 与缺失文件，未恢复的段标为 unavailable 并记缺口。
只处理本目录自有 UUID 媒体，路径和符号链接检查禁止越界操作。每分钟、封段后、配置变更和
启动后清理。最早一帧过期即删整段，边界可能提前清理最多一个段内的新帧。配额包含数据库、
临时文件、状态等全部目录内容，默认 10 GiB；剩余卷空间少于 1 GiB 停止新采集。
状态事件最多 10000 条并随保留期限清理；不落截图内容或应用名称日志。

暂停、配置变化与系统状态会使旧采集代际失效。单条采集／编码链路不积压截图；超时 30 秒
显示错误，但保持在途任务所有权，直到平台实际返回才释放，绝不并发创建替代 writer。
系统恢复等待 5 秒；错误采样按 60／120／300／600 秒退避，连续 10 分钟失败等待人工恢复。

## 只读诊断

```bash
INSPECT=.runweave/screen-recording/build/Build/Products/Debug/ScreenJournalInspect
"$INSPECT" status --data-dir "$HOME/Library/Application Support/ScreenJournal" --json
"$INSPECT" verify --data-dir "$HOME/Library/Application Support/ScreenJournal" --json
"$INSPECT" extract --data-dir "$HOME/Library/Application Support/ScreenJournal" --capture-id UUID --output /tmp/new-frame.png
```

`status` 给出 PID／快照时刻／锁状态、段计数、最近 100 条采样 ID 和状态事件；陈旧快照或无锁
不能证明当前正在采集。`verify`／`extract` 必须先退出写入者，获取共享锁后只读打开数据库。
verify 解码全部段并比对帧索引，有 unavailable／writing 等未提交段会非零返回。
extract 区分不存在、未提交、过期、媒体缺失与已有输出，不覆盖文件，也不允许输出到数据目录。
提取的图片是用户主动导出副本，后续由用户管理，不参与原始目录自动清理。

## 隔离验收

[验收合同](../../docs/testing/screen-recording/capture-storage.testplan.yaml)是行为验收依据。
Debug 可显式传 `--validation-data-dir ABSOLUTE_PATH`。仅在隔离目录允许
`--validation-max-bytes N`／`--validation-free-bytes N`，状态会标注注入；Release 拒绝这些参数。
首个实例启动时不自动采集，仍通过原生控件启停。不得用正式目录做破坏性验证。

```bash
xcodebuild -project packages/screen-recording-macos/ScreenJournal.xcodeproj \
  -scheme ScreenJournalFixture -configuration Debug \
  -derivedDataPath .runweave/screen-recording/build CODE_SIGN_IDENTITY=- build
.runweave/screen-recording/build/Build/Products/Debug/ScreenJournalFixture \
  --data-dir "$PWD/.runweave/screen-recording/new-fixture" --scenario retention
```

fixture 只接受新的空白隔离目录，生成可解码的合成色块／移动白条和清单；支持 retention、quota、
recovery、deleting、availability、newer-schema。它不是单元测试，不自动判定业务通过，不能
替代真实采集。manifest 保存原 ID 与注入前媒体 SHA-256，便于人工核查恢复前后变化。

八小时验收使用默认参数和真实授权会话，每分钟记录 CPU 累计时间、RSS、实际目录增长与状态。
单核 CPU 百分比为累计 CPU 秒数增量／墙钟秒数 × 100，目标 ≤5%；RSS 峰值 ≤300 MiB。
有效启用时段成功采样／应有 tick ≥99%，忙碌、错误、编码失败均计缺失；系统暂停与手动暂停另记。
不足八小时或无权限时必须报告未完成，构建、fixture 与短跑都不能替代。

## 原生回放与在线读取

主窗口的“录屏记录”按采集 Mac 时区列出日期和时间范围，菜单栏“打开 ScreenJournal”可重新唤起窗口。范围最多 15 分钟，按会话、
显示器和时钟回拨拆分；只包含 ready 段。打开默认暂停，20×／40×／60× 使用真实采集时间；
逐帧保持暂停，末尾停止。关闭查看不停止采集，暂停采集不关闭读服务。

读服务由唯一 writer 持有，路径为 `runtime/read.sock`（0600，父目录 0700），仅接受同 UID。
清理先使读取失效、取消解码，实际读取许可归零后才删除。视图最多 8 个，空闲 60 秒、
绝对 30 分钟；单视图最多 900 帧，索引合计 8 MiB。最多 2 个解码任务，预取后续 2 帧；
图像缓存最多 16 帧／128 MiB，缩略图 16 MiB。JPEG 仅按需在内存生成，不另存回放视频。

Backend 路由 `/api/screen-recording` 复用现有 Bearer、隧道认证和服务端会话作用域。
Backend 只按需连接本机 socket，不管理采集生命周期。隔离验证可在 Backend 启动环境中指定
`RUNWEAVE_SCREEN_JOURNAL_SOCKET`，HTTP 不接受路径覆盖。iOS 入口在首页更多菜单，当前 UI
需要 iOS 17+；只在线查看，前后台及连接作用域变化清除画面，断线确认或超过 5 秒未确认后隐藏。
索引和媒体均经现有 APIClient，HTTP 不缓存；图像内存缓存最多 16 帧／64 MiB，缩略图 8 MiB。

集成工具 scheme 为 `ScreenJournalReadVerify`，仅接受显式隔离 socket 与合成 manifest：

```bash
ScreenJournalReadVerify --socket ABSOLUTE_SOCKET --fixture-manifest ABSOLUTE_MANIFEST
ScreenJournalFixture --data-dir NEW_EMPTY_ABSOLUTE_DIRECTORY --scenario playback
```

`playback` 生成可视帧号、重复时间、回拨、隐私和间隔样本，不能替代真实采集证据。
Debug 隔离实例的本地 `diagnostics` 方法只返回资源计数，不经过 HTTP 暴露。显式创建隔离目录
`runtime/hold-read` 可使一个已启动的 reader 最长停留 30 秒；`held-read.json` 标记实际持有许可。
移除 gate 后 reader 退出。该入口仅用于验证取消不提前释放文件；Release 不执行该行为。

验收合同见 [读取服务](../../docs/testing/screen-recording/read-service.testplan.yaml) 与
[原生回放](../../docs/testing/screen-recording/playback.testplan.yaml)。构建和合成集成通过不代表
全合同通过；真实 Mac、模拟器、资源压力与故障用例须分别取证。二期实施验收尚在进行。

## 事项分析（开发中，默认关闭）

分析不属于采集依赖。唯一 App owner 管理独立 `analysis.sqlite`；Backend 通过同用户 socket
领取有代际和期限的批次、续租并提交结果。HTTP 只公开鉴权后的事项、日期快照、证据解析和
有界重试，不公开 claim/commit。原始采集与回放在分析不可用时继续工作。

配置入口为 `screenRecording.analysis.*`，需显式绑定设备、生效时间、视觉模型与 effort。
Backend 每分钟检查，最多四批，常规最多十五帧；模型子进程受超时、输出和图片到期约束。
临时图片在子进程退出后清理，Backend 崩溃时独立 watchdog 回收自己创建的进程组。
屏幕来源只能形成 documented/discussed，Agent 自述不能独立升级为 verified。

Mac 与 iOS 均默认展示“录屏记录”；“整理事项”为辅助视图，空状态提供直接查看当天录屏的入口。录屏目录变化自动刷新；iOS 遇到服务重启或短暂断连自动重试，并区分连接故障、当天没有录屏和尚未生成事项。证据通过 captureID 在线重新解析，未保存 viewID
或媒体路径。日期导出冻结内容及哈希，修订按日期维护；文字与修订本地保留三十天，媒体仍按
原保留策略。Daily Record 的可选接入合同见 [CLI](../../docs/cli/README.md#屏幕事项冻结导出)。

分析验收工具只可操作独立 fixture 根目录：`ScreenJournalAnalysisVerify ISOLATED_FIXTURE_ROOT`。
完整需求与未完成项见 [三期计划](../../docs/plans/2026-10-31-screen-recording-phase-3.md)；工具通过
不等于真实来源启用、原任务定时运行、随记发布或手机通知已验收。

### 会话来源和清理缺口

Agent-only 事项通过设备、provider 和 thread ID 定位既有会话。Mac 使用
`runweave://screen-conversation` 交给 Runweave 桌面端；桌面端核对当前连接的设备身份后，
复用会话阅读器。iOS 在同一连接上解析目标并核对线程，再进入原生阅读页。
终端不存在、线程变化或来源不可读时保留文字并提示不可用，不自动恢复或启动 Agent。
Debug 隔离模式不向 Stable 发送链接；可显式传入
`--validation-conversation-app '/Applications/Runweave Beta pool-04.app'`，要求同时指定隔离数据目录，
并校验目标是 Beta 应用。Release 拒绝所有 validation 参数。

原始段删除前，在原有 `state_events` 中事务记录 `sourceRetired`：仅保存 capture ID 和实际采样时间，
保留 30 天，不保存截图或转写。它不参与采集状态和回放区间。尚未分析或仅分批但未完成的材料
删除后，导出明确标记 `expired-unprocessed`，已生成的文字继续保留。升级前已经删除且没有账本的
材料无法重建逐帧身份；过期日期采用保守覆盖结论。

现有集成诊断工具增加以下入口（不是屏幕捕获或完整 UI 验收）：

```bash
ScreenJournalAnalysisVerify NEW_EMPTY_ISOLATED_ROOT --boundaries
ScreenJournalAnalysisVerify NEW_EMPTY_ISOLATED_ROOT --queue-faults
ScreenJournalAnalysisVerify SAME_QUEUE_FIXTURE_ROOT --queue-reopen
ScreenJournalAnalysisVerify NEW_EMPTY_ISOLATED_ROOT --bad-analysis
ScreenJournalFixture --data-dir NEW_EMPTY_ISOLATED_ROOT --scenario playback
ScreenJournalAnalysisVerify SAME_PLAYBACK_ROOT --retirement
```

`--boundaries` 使用合成像素经过 CapturePermit、编码和 ready 索引验证日界、十五分钟批、writing、短尾和迟到帧。
`--queue-faults` 直接调整隔离库的持久化期限及退避时刻验证恢复，不声称等待了真实五分钟租约。
原进程退出后可用 `--queue-reopen` 在新进程读取同一账本，确认失败预算和永久过期状态仍保留。
`--bad-analysis` 注入不兼容的衍生库版本，检查原采集存储链路继续写入及旧帧解码不变。
`--retirement` 删除本例合成媒体，检查文字保留和未处理材料永久缺口；只可用于一次性 fixture。

### 事项关键词搜索

Mac 事项页的“搜索事项”打开原生 sheet；iOS 默认保留“录屏记录”，在“整理事项”下点“搜索已整理事项”
打开独立搜索页，不改变单日时间线的日期。
仅在点击搜索或键盘提交时请求；改变关键词或日期清空旧结果并取消旧请求，清空关键词回到初始态。
默认最近 7 个上海自然日，支持今天、近 7 天、近 30 天及最近 30 天内的自选闭区间；查询依据 cards.day。

只检索当前 Mac 已整理事项的 title/summary，不检索 OCR、detail、证据、会话全文或日报。
Unicode 空白拆词、去重、多个词 AND；中文连续子串、ASCII 字母忽略大小写，符号均按字面量匹配。
规范化后限制 100 个 Unicode 标量、8 个词；空词、NUL、非空白控制字符、非法日期或越界范围均拒绝。
只展示日期、首尾发生时间、多段标记、标题、三行摘要、本人／后台标记及命中字段；列表不取帧。
结果按实际最后发生时间和 cardID 倒序，最多 100 条，超出提示缩小范围，不分页或计算总量。
无匹配、服务不可达、查询失败和旧版本不支持分别提示。

HTTP 入口为 `GET /api/screen-recording/analysis/search?q=...&from=YYYY-MM-DD&to=YYYY-MM-DD&limit=100`；
DTO 见 [共享合同](../shared/src/screen-recording/analysis.ts)。Mac 直接调用同一 owner 的 `analysisSearch`。
能力由原生 `AnalysisStatus.keywordSearchVersion=1` 声明；旧 Backend 缺路由提示 UPDATE_REQUIRED。
复用现有 Bearer、连接校验、返回前令牌复核、取消链路与 no-store；iOS 查询文字和页面沿用 Clarity mask，
API 诊断仅记录不带 query 的路径。无新增服务、查询历史、缓存表或 schema 迁移。

SQLite 使用 cards_day 限定范围、绑定参数和 JSON 投影；同一 owner 同步读取版本与结果，不调用模型或导出。
同时排除 updated 早于原 30 天文字保留线的记录。SQL 执行预算 2 秒，progress handler 在查询结束时移除；
返回结果最多 1 MiB，超限返回可重试 BUSY。损坏记录报错，不伪装成无匹配。

点击结果按 day/cardID 重读当前导出，再核对 deviceID/serverEpoch；修订后展示当前内容并提示更新，
删除、替换或服务变化要求重新搜索。复用事项详情、capture 解析与会话入口；截图过期仍可读保留的文字。
iOS 连接代际、前后台、鉴权或健康状态变化会清除旧结果与详情，恢复后手动重新提交；返回列表保留查询。

验证入口（仅一次性隔离目录，合成数据）：

```bash
ScreenJournalAnalysisVerify NEW_EMPTY_ISOLATED_ROOT --search
ScreenJournalAnalysisVerify NEW_EMPTY_ISOLATED_ROOT --search-fixture
```

`--search` 验证匹配、范围、排序、保留、输入、超时恢复及损坏记录，并对 30 天 10,005 条事项的
四类查询各测量 20 次。`--search-fixture` 只生成相同合成事项，供原生页面验证，绝不向正式目录写入。
行为合同见 [关键词搜索验收](../../docs/testing/screen-recording/search.testplan.yaml)。
构建、隔离 SQL/HTTP 和原生合成交互不能替代正式部署、真机或真实采集压力验收。
