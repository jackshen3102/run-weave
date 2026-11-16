# Runweave 质量巡检工作流（待评审方案）

原始目标：参考 [ByteTech 文章](https://bytetech.info/articles/7706822900388462630)，在当前项目建立异常发现、归因、跟踪与复验闭环。用户随后要求先做可视化方案；本目录仅用于讨论，不代表工作流已经实现。

打开 [index.html](./index.html)，使用当前项目的文件 Preview 或 Prototypes 入口，无需构建、外网或另起服务。修改后主动刷新同一文件。

- 源码基线：`06d2bd5167dce947cb3e3e42805a5e97c5a8563f`。
- 已确认：目标为当前 Runweave 项目；先盘点真实数据与样本，再确定方案。两端样本已核对，当前交付首版方案建议，不进入工作流实现。
- 建议但未确认：本机 Stable Backend 及其桌面 / 手机终端发送与连接生命周期，客户端自动增量汇入、Backend 证据库、定时 Agent 归因、本地台账、复验后人工关闭；首版包含采集和调度。
- 待定：是否扩展多实例或先限定单功能，观察窗口，未来调度时间与通知/外部提单范围。
- 模拟边界：示例问题与全部场景均为虚构；阶段、复验条件、范围按钮只更新页面内存，不调用 API、不读日志、不写台账、不启动任务。

事实入口：[日志实现](../../../backend/src/logging/logger.ts)、[日志路径](../../../backend/src/utils/path.ts)、[调查来源](../../../packages/runweave-mcp/src/sources.ts)、[调查工具](../../../packages/runweave-mcp/src/tools.ts)、[日志合同](../../quality/backend-rolling-logs.md)、[状态协议](../../architecture/runtime-status.md)、[调度合同](../../cli/scheduled-task-cli.md)。

## 数据底座修订（2026-11-16）

用户指出异常数据可能缺失且已有埋点。方案增加数据覆盖矩阵、Clarity / 本地操作 / 服务端关联路径和指标口径，并将实际数据盘点放到巡检实现之前。初版只核对源码；后续已取得桌面环、手机与 Backend 合并录制，并实际读取两端云端页面标签。

新增依据：[客户端操作诊断](../../architecture/client-action-diagnostics.md)、[Clarity 采集合同](../../../frontend/docs/clarity-autocapture.md)、[本地操作实现](../../../frontend/src/lib/action-diagnostics.ts)、[原生操作实现](../../../packages/ios-diagnostics/Sources/IOSDiagnostics/ClientDiagnostics.swift)、[原生埋点](../../../packages/app-ios/Sources/RunweaveIOS/Services/MobileAnalytics.swift)、[桌面异常](../../../electron/src/desktop/incident-logger.ts)。

## 验证记录

- 静态检查通过：HTML 小于 1 MiB；普通 id 唯一；章节锚点均可解析；无外部资源；包含 viewport 与方案 meta。
- 内联 JavaScript 通过 `node --check` 语法检查；`pnpm docs:check` 通过。这些不证明交互或布局正确。
- Runweave Browser 已按当前解析的 Profile/Group 附着；打开既有 `/prototypes` 入口后重定向到 `/login`，无法访问方案。尝试直接打开同一文件时，Browser 明确禁止 `file:` 协议。未绕过登录、另起服务器或换独立浏览器。
- 实际页面交互、截图与窄屏布局检查受上述入口阻塞，尚未完成。

未执行 iPhone 真机阅读验收；响应式布局不构成手机验收证据。

数据底座修订后重新执行静态结构、脚本语法与文档链接检查；未重新进行浏览器交互，上一轮登录阻塞尚未解除。

## 当前调查进度

调查材料位于 `artifacts/quality-data-audit/2026-11-16/`，不随源码发布。入口 `report.md`，两端样本与最新首版建议见 `client-samples.md`，结构化摘要见 `client-samples-summary.json`。

- 用户已提供桌面与手机文件，原先缺导出的阻塞解除，无需重复提供。桌面文件扩展名 jsonl，实际是 JSON 对象；手机是逐行 JSON 合并录制。
- 桌面实取 256 条、81 个操作，其中 2 个没有 started，19 个连接操作先 confirmed 后 failed。手机 126 条、3 个操作；一次发送以相同 operationId 精确关联到 Backend 派发，369ms 确认、402ms 记录 UI 更新。均不等于 Agent 任务完成。
- 两端本地 launch / build 均与实际云端页面片段匹配。同一会话可跨启动和构建；筛选结果不能整段按单版本归属。手机本次发送的云端收录仍未证实，回放资源未加载完成。
- 方案改为分别记录连接建立结果与之后关闭；不使用最后状态计算建立失败率，不直接相减未校准的跨端时钟。
- 现有文件证明字段和关联可复用；日常流程采用自动增量汇入、字段归一化、脱敏归档、覆盖回执和台账。Clarity 为辅助来源，不因云端缺口阻断本地分析。
- 拟议归档默认 30 天或 100 MiB，非固定证据先到先清；未结必要证据固定，容量不足明确阻塞。这是方案参数，未落地。首版自动采集一起补连续确认水位、丢弃计数和有界待发送队列，并验证高负载覆盖。
- 连接到服务端的精确映射仍有缺口，需归因时再补终端 / attempt 对应与关闭原因码；现有正常发送无须新增全量成功日志。未实现工作流、埋点、产品或调度。

## 本轮验证

实际解析两份文件并保存哈希与安全字段摘要；检查阶段、操作 ID、跨端匹配及 Backend 滚动日志精确 ID 搜索。Clarity 两端页面标签已实际读取。下载捕获已释放，只关闭本轮标签页并 detach。

HTML 结构、脚本语法、文档链接与差异检查在方案修订后执行。原型真实浏览器交互及 iPhone 阅读验收仍未完成，沿用上文入口阻塞；Clarity 交互不代替原型验收。

## 自动化方向修订（方案 05）

用户明确要求自动归因与定时任务。方案 04 把调查阶段的手动导出当成日常入口，已被本版替代；历史样本结论仍有效。

- **首版主流程**：客户端增量汇入 + 服务端日志增量读取 → Backend 有界证据库 → 定时 Codex 关联与归因 → 同一问题台账 → 下一轮复验。无需每次手动导出。
- **采集拟议默认**：客户端在线时 30 秒或 64 条批量汇入，失败事件可提前触发；服务器连续确认水位、幂等去重、断线补发和丢弃回执。参数待实现验收验证，不是已运行配置。
- **数据归属**：操作发起时固定目标 Backend 和终端 / attempt；不能上传其他连接的记录。不承诺 iOS 挂起时持续上报，缺口显式保留。现有全局短时诊断录制不由周期任务自动开关。
- **自动归因**：规则先还原阶段并聚合，Agent 再读对应构建源码与服务端旁证，输出因果链、证据、修复建议和下一步。已定位原因与待验证假设分开，不能只凭事件名称判 Bug。
- **调度建议**：用户已确定每天一次；建议时区 Asia/Shanghai，Codex，具体时刻在启用时设置；先检查增量，无新证据和待复验项则跳过分析；同台账互斥、预算有界、游标续读。模型、执行策略、补跑及精确日程在启用配置中明确。
- **当前能力**：本轮 `rw scheduled-task capabilities --json` 实读 taskContextVersion=2、enabled=true、Codex available=true。没有创建或启用任务，没有改产品采集。
- **验收**：必须用不点导出的新操作跑通采集 → 定时运行 → 归因 / 台账，并检查离线补发、重复批次、截断缺口及跨轮复验。已有样本与静态检查不能替代这一验收。

新增实现落点建议：Web `action-diagnostics.ts` 与原生 IOSDiagnostics 的宿主回调接入有界发送队列；协议进入 packages/shared；Backend 独立接收 / 存储服务及游标读取；项目 Toolkit 技能负责证据归并和自动归因。不要复用只能保存 latestResult 的手动录制停止接口作为长期事件接收接口。

## 实施计划与每日频率

用户已确定每天运行一次归因任务；自动采集持续增量保全，不能改成每天才从设备读取一次。
具体每日时刻属于启用配置。本轮实施计划见
[每日自动归因实施计划](../../plans/2026-11-16-quality-workflow.md)，
配套 [18 条验收用例](../../testing/quality/automatic-attribution.testplan.yaml)。
计划编写阶段只进行格式 / 文档检查；后续源码实施与部分用例已执行，未创建每日任务。

实现进度与实测边界见 [实施验收记录](../../quality/quality-workflow-validation.md)；本原型不是运行状态页。

源码实施后更新了本页状态提示与 Backend 存储归属；此轮仅检查静态结构与脚本语法，未重跑本原型的布局或交互。
