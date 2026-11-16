# Runweave 质量巡检工作流（待评审方案）

原始目标：参考 [ByteTech 文章](https://bytetech.info/articles/7706822900388462630)，在当前项目建立异常发现、归因、跟踪与复验闭环。用户随后要求先做可视化方案；本目录仅用于讨论，不代表工作流已经实现。

打开 [index.html](./index.html)，使用当前项目的文件 Preview 或 Prototypes 入口，无需构建、外网或另起服务。修改后主动刷新同一文件。

- 源码基线：`06d2bd5167dce947cb3e3e42805a5e97c5a8563f`。
- 已确认：目标为当前 Runweave 项目；先盘点真实数据与样本，再确定方案。两端样本已核对，当前交付首版方案建议，不进入工作流实现。
- 建议但未确认：本机 Stable Backend 及其桌面 / 手机终端发送与连接生命周期，手动导入、本地台账、证据齐全后人工关闭；自动采集完成覆盖验证后再接调度。
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

## 当前调查进度（方案 04）

调查材料位于 `artifacts/quality-data-audit/2026-11-16/`，不随源码发布。入口 `report.md`，两端样本与最新首版建议见 `client-samples.md`，结构化摘要见 `client-samples-summary.json`。

- 用户已提供桌面与手机文件，原先缺导出的阻塞解除，无需重复提供。桌面文件扩展名 jsonl，实际是 JSON 对象；手机是逐行 JSON 合并录制。
- 桌面实取 256 条、81 个操作，其中 2 个没有 started，19 个连接操作先 confirmed 后 failed。手机 126 条、3 个操作；一次发送以相同 operationId 精确关联到 Backend 派发，369ms 确认、402ms 记录 UI 更新。均不等于 Agent 任务完成。
- 两端本地 launch / build 均与实际云端页面片段匹配。同一会话可跨启动和构建；筛选结果不能整段按单版本归属。手机本次发送的云端收录仍未证实，回放资源未加载完成。
- 方案改为分别记录连接建立结果与之后关闭；不使用最后状态计算建立失败率，不直接相减未校准的跨端时钟。
- 首版建议复用现有文件与短时诊断，新增格式识别、字段归一化、脱敏归档、覆盖回执和台账。Clarity 为辅助来源，不因云端缺口阻断本地分析。
- 拟议归档默认 30 天或 100 MiB，非固定证据先到先清；未结必要证据固定，容量不足明确阻塞。这是方案参数，未落地。自动采集需先补水位、丢弃计数和受控导出，并验证高负载覆盖。
- 连接到服务端的精确映射仍有缺口，需归因时再补终端 / attempt 对应与关闭原因码；现有正常发送无须新增全量成功日志。未实现工作流、埋点、产品或调度。

## 本轮验证

实际解析两份文件并保存哈希与安全字段摘要；检查阶段、操作 ID、跨端匹配及 Backend 滚动日志精确 ID 搜索。Clarity 两端页面标签已实际读取。下载捕获已释放，只关闭本轮标签页并 detach。

HTML 结构、脚本语法、文档链接与差异检查在方案修订后执行。原型真实浏览器交互及 iPhone 阅读验收仍未完成，沿用上文入口阻塞；Clarity 交互不代替原型验收。
