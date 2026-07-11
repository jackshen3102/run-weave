# Runweave 独立行为数据底座与经验生成系统计划

> 状态：方案已收敛，尚未实施
> 计划粒度：L3（跨 App Server、Backend、Electron、Web/App、CLI、Hook、Shell Integration、Agent Team 与模型任务）
> 代码基线：`feature@2c4572c`，2026-07-11
> 配套架构图：`docs/architecture-flows/system-activity-data-foundation-flow/`
> 配套验收：`docs/testing/system-activity-data-foundation-test-cases.md`

## 结论

新增一套独立的 **Activity Hub**，作为当前 OS 用户在一台设备上的统一行为数据面：Stable、Beta、Dev、Web、App、CLI、Hook、Shell、Terminal Browser、Playwright 和 Agent Team 都在行为发生时主动写入规范化事件。它不复用 App Server 的事件文件、不把现有业务库当事实仓，也不在模型运行时临时扫描 Thread、scrollback 或 Agent Team 文件拼结论。

数据边界固定如下：

- 绝大多数数据直接写入 Activity Hub 自己的 `BehaviorFact`、`ActivityContent` 和关系结构。
- 只有完整 Thread、完整 tmux scrollback、大输出、截图/录屏、完整 Agent Team run/outbox、Git/PR 权威对象等大对象或已有权威副本保存 `ExternalRef`。
- 正文、大输出和 Activity Hub 自有 Blob 默认保留 7 天。
- 规范化事实、关系、索引与来源健康信息默认保留 30 天。
- Learning 是模型生成的独立派生资产；它不能回写、覆盖或伪装成事实。

第一阶段只交付独立事实采集、存储、查询、轨迹与覆盖缺口，不生成 Learning。第二阶段再让 UI 或 Agent 基于冻结的 Context Pack 调模型生成 Candidate，并经过证据校验与审核后沉淀。

## 先纠正三个前提

### 1. “真实轨迹”不等于录制所有字节

系统记录语义动作和结果，而不是 mousemove、hover、每个按键、每个终端字节、每个模型 token 或每次 React render。真实的定义是：能够回答谁在何时、哪个 Runtime、哪个 Project/Terminal/Thread/Run 中发起了什么动作，系统或 Agent 做了什么，结果如何，证据在哪里，以及链路中是否存在缺口。

如果默认录制完整 terminal output、network body 或浏览器页面，单日数据会从约 10–100 MB 上升到 GB 级，并显著扩大隐私风险。这些内容只保存短期自有 Blob 或引用。

### 2. “一个任务”不能靠时间邻近猜出来

事实仓不新增靠模型或时间窗口猜测的 Task truth。用户 Query 被提交时生成 `interactionId`，Agent turn、tool、command、browser、verification 等事件只通过显式 `interactionId/threadId/runId/operationId/correlationId/causationId` 串联。缺少显式 ID 时保留为未关联事实，并显示 coverage gap，不用“前后五分钟”猜归属。

因此第一阶段 UI 是 Facts、Interaction Timeline 和 Sources，不是 Task 管理页。Task/Requirement 如未来需要，只能是事实之上的独立产品对象或查询投影。

### 3. Goal、Outcome 和 Learning 不是基本事实

以下三类字段必须分开：

| 类型       | 示例                                                                             | 页面标识        | 生成者                 |
| ---------- | -------------------------------------------------------------------------------- | --------------- | ---------------------- |
| 直接事实   | Query 正文、时间、Runtime、Thread ID、命令、退出码、状态迁移、文件路径、验证结果 | Recorded        | 业务源主动记录         |
| 确定性投影 | 时长、显式 retry 次数、事件数量、阶段序列、覆盖缺口                              | Computed        | Activity Hub 查询/投影 |
| 模型产物   | Goal、Outcome 摘要、问题模式、建议、Learning                                     | Model-generated | Learning Agent/模型    |

Facts 页面不能把模型写出的 Goal/Outcome 当成已记录事实。`Duration` 可以由明确的开始/结束事件计算；`Rework` 只有在系统主动记录 retry/reopen/recheck 时才能计算，否则不展示。

## 目标与完成标准

全部满足才算完成事实底座：

- 行为数据写入独立 `~/.runweave/activity-hub/`，不落入 Stable/Beta App Server home、Backend LowDB、项目 `.runweave` 或诊断日志目录。
- Stable、Beta、Dev 和 external producer 可写入同一个 Hub，且事件保留真实 `runtimeChannel` 与 `surface`；两套产品运行时仍保持控制面、认证和 App Server 隔离。
- 核心行为在发生时主动写入；删除或停止对应业务源后，已写入的 30 天事实仍可查询。
- 规范化事件具备稳定 ID、producer sequence、schema、发生/接收时间、actor、runtime、scope、correlation、result、privacy 和 retention。
- 业务写路径不等待 Hub；Hub 下线时 producer spool，恢复后重放，重复投递不产生重复事实。
- Sources 页面能显示每个 producer 的 produced/acked sequence、缺口区间、丢弃数、最后心跳和 projection lag，不使用没有分母的“98% coverage”。
- 7 天内容和 30 天事实分别过期；过期引用明确显示 `expired/missing/deleted`，不静默空白。
- Facts/Timeline 能按时间、Runtime、Surface、Project、Terminal、Thread、Run、Kind、Actor、Result 检索，并暴露未关联和丢失区间。
- 任何 token、cookie、Authorization、密码、环境变量 secret 或未授权私有正文不能进入事实、Blob、导出或模型 Context Pack。
- 配套用例通过真实 API、文件、浏览器和运行时验证；静态检查不能替代行为验收。

Learning 阶段另需满足：

- UI、CLI 和 Agent 使用同一个 `AnalysisJob` 管线；模型不能直接读全库或任意本地路径。
- 每次模型运行输入都是不可变 Context Pack，保留 Pack hash、模型、Prompt、脱敏策略和 coverage gap。
- 每条 Candidate claim 必须引用 Pack 内证据；数字由系统根据 refs 计算，不接受模型自报。
- Candidate 默认进入人工审核，发布后形成不可变 Learning version；模型不能改事实。

## 非目标

- 不保存或推断模型隐藏思维链。
- 不承诺在没有 Hook 或 Shell Integration 时捕获任意第三方 Terminal 的任意命令。
- 不把现有 rolling logs、diagnostic logs、scrollback、Thread 或 Agent Team JSON 整包复制进事实表。
- 不以 OTLP + ClickHouse/OpenSearch 或 cloud-first warehouse 作为当前本机阶段的必需依赖。
- 不为第一阶段实现自动 Learning、经验检索注入、向量搜索或自动发布。
- 不把 Activity Hub 变成运行时控制面；它只接受、存储、查询、导出和提供分析输入。
- 不新增单元测试；按仓库规则使用 typecheck、lint、集成验证、Playwright 与真实行为核对。

## 当前代码事实

### 已有能力

- `packages/shared/src/app-server-events.ts` 已有 `source/scope/dedupeKey/correlationId/payload/createdAt`，ThreadRef 可关联 Project、Terminal、Panel、Run 与 cwd。
- `app-server/src/event-store.ts` 已有 append-only JSONL、去重、查询和默认 7 天保留。
- `packages/shared/src/terminal/events.ts` 已定义 Project、Session、Panel、Focus、Input、Completion 等语义事件。
- `backend/src/terminal/runtime-recorder.ts` 能从 Shell Integration 读取 cwd、active command、command output 与 exit。
- Hook 已识别 `SessionStart/UserPromptSubmit/Stop`，并能携带 Thread、Terminal、Panel、tmux、cwd、command 和 completion summary。
- Agent Team run 已有 worker、round、acceptance、evidence、human note、错误指纹、恢复与最终状态。
- Terminal Browser manager、CDP proxy、annotation、Preview/File/Git、Quick Input、Voice、CLI 和 Playwright 路径都有明确命令边界，可以在动作发生处写结构化事实。
- Backend rolling log 和 Diagnostic Log 已有基础敏感信息脱敏逻辑，可作为 Activity DLP 的输入之一。

### 当前能力不能直接满足目标

| 当前实现                         | 真实边界                                       | 为什么不能直接作为行为仓                                                    |
| -------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------- |
| App Server event store           | 单 JSONL、全量读入内存、7 天、清理时整文件重写 | 事件种类少；没有 runtime/schema/producer seq/privacy；Stable/Beta home 隔离 |
| Backend TerminalEventService     | 进程内最近 500 条                              | 重启丢失，不能跨 Backend/Runtime 集中查询                                   |
| Hook bridge                      | 缺少 `RUNWEAVE_TERMINAL_SESSION_ID` 时直接退出 | 当前只覆盖 Runweave Terminal，不覆盖外部 TTY；也没有保存 prompt/tool/result |
| Codex Thread snapshot            | `thread/read(includeTurns: false)`             | 只能取 preview/status，完整可见 turn 需要受控采集器                         |
| LowDB / scrollback               | 业务状态与每 Session 有界日志                  | 是运行时权威数据，不是跨系统行为事实仓                                      |
| Agent Team run JSON              | 项目 `.runweave/agent-team/<runId>.json`       | 是当前 run 快照，不是逐状态转移的全局事件流                                 |
| rolling / diagnostic logs        | 3 天或显式录制、面向排障                       | 日志级别和格式会变，不能承担用户行为协议                                    |
| Electron Browser tab persistence | 保存当前 tab 状态                              | 没有历史动作轨迹                                                            |

现有数据只允许两种用途：

1. 作为 producer 在行为发生时写 Activity Fact 的输入。
2. 作为少量大对象/权威对象的 External Ref，或上线迁移时的一次性 backfill。

它们不能成为模型分析时的主查询源。

## 方案比较

| 方案                             | 优点                                   | 根本问题                                               | 结论               |
| -------------------------------- | -------------------------------------- | ------------------------------------------------------ | ------------------ |
| 扩展现有 App Server Event Center | 改动最少                               | Stable/Beta 隔离、单 JSONL、协议和职责都不适合海量行为 | 不采用             |
| 独立 per-user Activity Hub       | 主动写入、跨 Runtime、本地隐私、可离线 | 新增一个本机服务和 producer SDK                        | **采用**           |
| 每个 Runtime 独立行为库再复制    | 隔离强                                 | 复制、去重、gap、查询和运维复杂                        | 不采用             |
| 运行时联邦查询现有存储           | 无迁移                                 | 违反独立存储边界，源数据过期/结构变化后不可复现        | 排除               |
| OTLP + ClickHouse/OpenSearch     | 大规模生态成熟                         | 本机部署、成本、隐私和离线负担过重                     | 后续远端汇聚再评估 |
| Cloud-first warehouse            | 跨设备集中                             | 网络依赖、上传隐私、成本和账号隔离提前复杂化           | 当前不采用         |

## 目标架构

```text
Stable / Beta / Dev / External producers
  Web · App · Backend · Electron · CLI · Hook · Shell · Agent Team · Playwright
       │  typed Activity SDK, producer eventId + seq
       ├─ memory queue
       └─ durable per-producer spool（Hub 不可用时）
                     │
                     ▼
          per-user Activity Hub daemon
  discover/auth → validate schema → redact → dedupe → durable append → ACK
                     │
        ┌────────────┼─────────────┐
        ▼            ▼             ▼
  Fact segments   Content Vault   Quarantine/Gaps
  30 days         7 days          explicit health
        │            │
        └──────┬─────┘
               ▼
     rebuildable SQLite query projection
               │
      ┌────────┴──────────┐
      ▼                   ▼
 Facts / Timeline UI   Context Pack Builder
                          │
                          ▼
                    Model / Agent
                          │
                          ▼
             Candidate → Review → Learning Version
```

### 部署与隔离

- Activity Hub 是每个 OS 用户、每台设备一个本机 singleton。
- 固定根目录：`~/.runweave/activity-hub/`；不能跟随 Stable/Beta home 切换。
- Stable、Beta、Dev 只是 producer 的 `runtimeChannel`。CLI/Hook/Shell 是 `surface`，不能被错误建模成 Runtime。
- 每个 producer 使用只允许 append 指定 namespace 的 capability token；UI read、export、delete、Learning Agent read 使用不同 capability。
- Hub 不能启动、停止、更新或修改 Backend/Electron/App Server；单向采集避免它成为新的控制面单点。
- 跨设备集中不是第一阶段承诺。未来可增加只上传脱敏事件的 remote sink，Hub 本地协议不变。

## 核心数据模型

### BehaviorFact

```ts
interface BehaviorFact<EventName extends string, Payload> {
  eventId: string; // UUIDv7，由 producer 生成，retry 保持不变
  eventName: EventName;
  schemaVersion: number;
  occurredAt: string;
  ingestedAt?: string; // Hub 写入
  hubOffset?: string; // Hub 单调 offset，只表示接收顺序

  producer: {
    name: string;
    version: string;
    instanceId: string;
    bootId: string;
    sequence: number;
  };

  actor: {
    type: "user" | "agent" | "system";
    agent?: "codex" | "claude" | "trae" | "playwright" | "other";
  };

  runtime: {
    channel: "stable" | "beta" | "dev" | "external";
    surface: "desktop" | "web" | "app" | "cli" | "hook" | "shell";
    appVersion?: string;
    sourceRevision?: string;
    backendProfile?: string;
  };

  scope: {
    deviceId: string;
    projectId?: string;
    terminalSessionId?: string;
    panelId?: string;
    tmuxPaneId?: string;
    threadId?: string;
    turnId?: string;
    interactionId?: string;
    runId?: string;
    operationId?: string;
    browserGroupId?: string;
    tabId?: string;
  };

  correlationId?: string;
  causationId?: string;
  parentEventId?: string;
  result?: {
    status: "succeeded" | "failed" | "cancelled" | "unknown";
    code?: string;
  };
  payload: Payload; // 有界、按 event schema 验证
  contentRefs: ActivityContentRef[];
  externalRefs: ExternalRef[];
  privacy: {
    classification: string;
    redactionVersion: string;
    localOnly: boolean;
  };
  retentionClass: "content_7d" | "fact_30d";
  priority: "critical" | "normal" | "sampled";
}
```

`occurredAt` 与 `ingestedAt` 必须分开。系统只保证同一 `(producer.instanceId, bootId)` 内的 sequence 顺序；跨 producer 不伪造全局发生顺序，因果关系依赖显式 correlation/causation。

### ActivityContent

Activity Hub 自己拥有的短期内容，不是现有业务库引用：

```ts
interface ActivityContent {
  contentId: string;
  sha256: string;
  kind:
    | "query"
    | "assistant_message"
    | "command"
    | "excerpt"
    | "transcript_chunk";
  mediaType: string;
  byteLength: number;
  compression: "none" | "gzip";
  encryption: "aes-256-gcm";
  createdAt: string;
  expiresAt: string; // 默认 7 天
  redactionVersion: string;
}
```

Query、可见 Assistant 回复、命令文本等核心内容主动写入 Activity Hub；较小内容可 inline，超过 schema 上限后进入 Hub 自有 Content Vault。两者都属于独立行为存储。

### ExternalRef

只用于少量大对象或源系统权威对象：

```ts
interface ExternalRef {
  refId: string;
  authority:
    | "codex_thread"
    | "terminal_scrollback"
    | "agent_team_run"
    | "browser_artifact"
    | "git_object"
    | "verification_evidence";
  locator: string;
  versionOrDigest?: string;
  capturedAt: string;
  expectedExpiresAt?: string;
  availability: "available" | "expired" | "missing" | "deleted";
}
```

Ref 必须有 authority、版本/哈希和 availability。模型不能拿 locator 任意读取本机文件；Context Pack Builder 只能通过注册的 resolver 读取最小片段并再次脱敏。

### Schema Registry

`packages/shared` 为每个 `eventName + schemaVersion` 保存：

- Zod/JSON Schema 与 TypeScript 类型；
- producer allowlist；
- payload/content 大小上限；
- 可索引字段；
- PII/secret 分类与 redactor；
- retention 与 priority；
- upcaster 和废弃日期。

Producer SDK 编译期约束，Hub 入库时再次验证。未知或坏 schema 进入 7 天 quarantine，并写 Sources gap；不能作为 generic `payload: unknown` 混入 Facts。

## 事实目录与采集边界

### P0 核心 24 个事件族

| 领域         | 事件                                             | 直接存储                                                       | 可能引用                |
| ------------ | ------------------------------------------------ | -------------------------------------------------------------- | ----------------------- |
| Runtime      | `runtime.instance.started/stopped`               | channel、surface、version、revision、profile、reason           | 无                      |
| Context      | `project.opened/switched`                        | project ID、repo root digest、from/to                          | Git object              |
| Terminal     | `terminal.session.created/opened/closed`         | session、project、source、reason                               | scrollback              |
| Terminal     | `terminal.panel.focused`                         | panel、session、operation                                      | 无                      |
| Terminal     | `terminal.command.started/completed`             | command content/ref、cwd、exit、duration                       | 大输出/scrollback       |
| User         | `user.query.submitted`                           | interaction、thread、text/ref、length、hash、input mode        | 完整 Thread             |
| User         | `user.interrupt.requested`                       | target、reason、operation                                      | 无                      |
| Agent        | `agent.thread.started/resumed`                   | agent、thread、project、terminal                               | 完整 Thread             |
| Agent        | `agent.turn.started/completed/failed/cancelled`  | turn、interaction、status、duration、token usage if exposed    | 完整 Thread             |
| Agent        | `agent.message.completed`                        | visible message/ref、role、length、hash                        | 完整 Thread             |
| Tool         | `agent.tool.started/completed/failed`            | tool、call ID、duration、status、sanitized args/result summary | tool artifact           |
| Browser      | `browser.tab.created/focused/closed`             | group、tab、URL origin/path policy、reason                     | 无                      |
| Browser      | `browser.navigation.started/completed/failed`    | tab、from/to sanitized URL、status、duration                   | screenshot/DOM          |
| Browser      | `browser.automation.performed`                   | protocol、command family、target、status                       | screenshot/trace        |
| Artifact     | `file.viewed/saved/renamed/deleted`              | path、operation、size/digest、result                           | Git blob/diff           |
| Git          | `git.diff.viewed/reset.completed`                | repo、path set、revision、result                               | diff/Git object         |
| Verification | `verification.started/completed`                 | runner、case、target identity、result、duration                | report/screenshot/trace |
| Agent Team   | `agent_team.run.created/phase_changed/completed` | run、phase、round、status、reason                              | run snapshot            |
| Agent Team   | `agent_team.worker.dispatched/completed`         | run、worker role、panel、status、duration                      | pane/outbox             |
| Agent Team   | `agent_team.case.started/completed`              | run、case ID、source、result                                   | evidence                |
| Human        | `human.review.recorded`                          | target、decision、reason category                              | note body               |
| Recovery     | `operation.retry.requested`                      | target operation、attempt、explicit reason                     | 无                      |
| Recovery     | `runtime.connection.lost/restored`               | source、duration、cause code                                   | diagnostic bundle       |
| Collector    | `source.loss.reported`                           | producer、gap range、dropped count、reason                     | 无                      |

表中 slash 表示同一 schema family 的 start/finish variants；24 个事件族展开后的每个 event name 都在 registry 单独定义 schema。P0 只接能在真实业务边界稳定拿到的数据，不从文本或时间邻近推断。

### 第二批事件

- Quick Input used/pinned/unpinned：记录 source、长度、useCount 与内容 ref，不复制当前 service 的未充分脱敏正文。
- Voice transcription requested/completed/accepted：音频不进事实表，转写文本走 7 天 Content。
- Clipboard image attached/removed：记录大小、类型、digest，图片走 7 天 Blob。
- Auth session started/ended、connection changed：不记录 token、账号 secret 或请求 header。
- Settings changed：只记录 allowlist key 和 from/to 分类，不做通用 localStorage clickstream。
- Learning retrieved/applied/feedback：在 Learning 发布与 Agent 检索阶段加入，形成经验使用闭环。

### 明确拿不到或不可靠的数据

- 未安装 Hook/Shell Integration 的外部 TTY 任意 shell 命令。
- 第三方 Agent 未暴露的内部 tool/reasoning/hidden state。
- 仅凭 scrollback 猜“哪一行是用户命令”、仅凭时间邻近猜 Task、仅凭最终文件猜具体编辑过程。
- 没有 target identity 的浏览器验证、没有 case ID 的“看起来通过”。
- 鼠标移动、hover、每个按键、每个终端 byte、每个模型 token。

这些数据不进入需求承诺。外部 TTY 可靠覆盖分两级：Agent Query/Reply 通过全局 Agent Hook；任意 shell command 必须显式安装 zsh/bash/fish preexec/precmd integration。

## 关联模型

### Query 主线

```text
user.query.submitted
  interactionId = producer 生成
  correlationId = interactionId
      ├─ agent.turn.started
      ├─ agent.message.completed
      ├─ agent.tool.started/completed
      ├─ terminal.command.started/completed
      ├─ browser.navigation / automation
      ├─ file/git/verification facts
      └─ agent.turn.completed/failed/cancelled
```

- Thread 可包含多个 interaction；interaction 不等同于 Thread。
- Agent Team run 可跨多个 interaction，但每个 worker/case 事件保留 runId 与自身 operationId。
- `causationId` 指向直接触发本事件的事件；`parentEventId` 用于 UI 树，不替代 correlation。
- 关联 ID 丢失时，事实仍入库，并在 Timeline 标记 `unlinked`；禁止后台自动猜测。

## 存储、留存与容量

### 目录

```text
~/.runweave/activity-hub/
  discovery.json
  tokens/
  identity/device.json
  spool/                 # Hub 自身恢复队列
  facts/
    active/
    30d/YYYY/MM/DD/*.jsonl
    manifests/
  content/
    7d/sha256/...
  index/activity.sqlite
  quarantine/7d/
  cursors/
  audit/
  learning/              # 第二阶段，和 facts 命名空间隔离
```

### 物理策略

- Canonical Fact Store 是 Activity Hub 自己的 immutable segmented JSONL，不复用 App Server JSONL。
- Active segment 到 128 MB 或 1 小时即封口；封口后 gzip，并写 count、first/last offset、SHA-256 manifest。
- ACK 只在 canonical append durable 后返回；SQLite 投影异步更新，失败不阻断事实写入。
- SQLite 只承担 timeline、thread、terminal、run、source-health 和安全字段全文索引，可从 30 天 segment 重建。
- 当前本机 Node `v22.22.2` 可加载 `node:sqlite`，但 API 仍输出 ExperimentalWarning。实现时必须把 SQLite 隔离在 projection adapter，并固定 Activity Hub runtime；不能假设任意 Electron/系统 Node 都兼容。
- Producer spool 使用 producer 生成的稳定 eventId 与 sequence；收到最高连续 ACK 前不删除。retry 重发同一事件，不重新生成 dedupe key。

### 默认留存

| 数据                                           |                 默认 | 清理语义                                               |
| ---------------------------------------------- | -------------------: | ------------------------------------------------------ |
| Query/回复/命令正文、excerpt、Blob、quarantine |                 7 天 | 到期删除内容，Fact 保留 digest、size 与 `expired` 状态 |
| 规范化 Fact、关系、Sources gap、SQLite 投影    |                30 天 | 删除 segment/索引行，记录 retention watermark          |
| 未审核 Context Pack、Learning run、Candidate   |                30 天 | 到期删除；发布前提示证据即将过期                       |
| Published LearningVersion                      | 用户删除或 supersede | 只保留最小脱敏 Support Capsule，不保留完整行为原文     |

默认本机 quota 建议 5 GB；接近 quota 时先删除已过期内容，再按策略采样 `priority=sampled`，不能先丢 query/completion/result。任何丢弃必须保留 `source.loss.reported` 和 gap range。

规模目标不是事实陈述，而是实施验收预算：

- 典型 10,000–100,000 semantic events/day。
- 30 天最多约 3,000,000 facts。
- producer enqueue p95 < 5 ms，不能阻塞业务动作。
- Hub 持续 200 events/s，10 秒 burst 2,000 events/s。
- projection lag 正常 < 1 秒；最近 10,000 条 timeline 查询 p95 < 500 ms。

## 可靠性与故障语义

- 交付语义：at-least-once + eventId 去重；不承诺 exactly-once 网络传输。
- Producer 身份：`instanceId + bootId + sequence`；Hub 分配 `hubOffset`。
- Hub 下线：SDK 写 disk spool，业务继续；恢复后按 sequence replay。
- sequence gap：持久化 gap interval；迟到事件补齐后关闭 gap，不改已有 hubOffset。
- schema 错误：进入 quarantine，producer 收到 reject，Sources 显示 invalid count。
- projection 失败：canonical append 已成功，query 标记 lag；可停机/在线 rebuild。
- Blob missing：Fact 仍可读，内容显示 missing，不伪造空字符串。
- Backpressure：429 + retry-after；critical 不丢，normal spool，sampled 可采样并报告 loss。
- Activity Hub 自身 rolling log 不回灌 Activity Hub，避免递归。

## 隐私、权限与删除

- Producer 先按 schema redaction；Hub 再做 token/header/cookie/password/private key/high-entropy secret 扫描。
- `.env`、Authorization、Cookie、完整 HTTP headers、系统环境变量、证书和 Keychain 内容禁止入库。
- Content Vault 使用 AES-256-GCM；key 存 macOS Keychain；目录 `0700`、文件 `0600`。
- Query/回复/command content 默认 local-only；Project 可配置 `modelAccess=none|local-only|approved-provider`。
- 模型只读取 Context Pack，不持有 Activity Hub 全库 read token。
- read/export/delete/model-job 都写独立 audit；audit 不包含被访问的正文。
- 用户/Project 删除优先于 Learning 证据留存：Support Capsule 被 tombstone 后，相应 Learning 进入 `needs_revalidation` 或 `deprecated`。

## 查询与事实页面

### API

```text
POST /v1/events:batch
GET  /v1/events
GET  /v1/timeline/:correlationId
GET  /v1/sources
GET  /v1/schemas
GET  /v1/content/:contentId
POST /v1/exports
DELETE /v1/data?projectId=...|threadId=...
WS   /v1/events/stream?after=...
```

Cursor 使用 opaque keyset `(occurredAt, hubOffset)`，不能用 offset pagination。所有 query 返回 `coverage`：source watermarks、gap ranges、projection lag、expired/missing ref counts。

### 第一阶段 UI

1. **Facts**：按真实字段过滤、排序、打开详情；Recorded 与 Computed 分区。
2. **Interaction Timeline**：以显式 correlation/interaction/thread/run 展开 actor、action、result 和 refs；高频 tool/output 默认折叠。
3. **Sources**：每个 producer 的 runtime/surface/version、last heartbeat、produced/acked、gap、reject、drop、lag。
4. **Data Policy**：7/30 天、quota、Project model access、删除和导出。

UI 不显示 Task、Goal、Outcome、Rework、节省时间或百分比“置信度”。后续模型摘要必须带 Model-generated 标识和生成 run。

## Learning 生成系统（第二阶段）

### 核心对象

| 对象                | 性质               | 规则                                                                      |
| ------------------- | ------------------ | ------------------------------------------------------------------------- |
| `ContextPack`       | 冻结模型输入       | 记录 query、fact IDs/hash、resolved excerpts、schema、coverage、redaction |
| `LearningRun`       | 不可变模型运行审计 | 模型、Prompt、参数、token/cost、状态、output hash                         |
| `LearningCandidate` | 模型产物           | 每条 claim 必须引用 Pack 内 evidence                                      |
| `LearningVersion`   | 已审核经验         | 单版本不可变，支持 supersede/merge/conflict                               |
| `LearningFeedback`  | 使用事实           | useful/stale/wrong/unsafe 与使用结果                                      |
| `SupportCapsule`    | 最小证据胶囊       | 只保留审核 claim 所需的脱敏事实片段和哈希                                 |

### 统一生成链路

```text
UI Generate / rw activity analyze / Learning Agent
  → 确定性选择 facts
  → resolve 注册的 refs
  → 二次脱敏与预算裁剪
  → seal Context Pack + hash + coverage report
  → 模型 Extractor 分片提取 observations
  → 模型 Consolidator 合并模式并检索反例
  → deterministic evidence/number validator
  → LearningCandidate
  → human review / edit / narrow / reject / merge
  → immutable LearningVersion + SupportCapsule
```

模型运行时禁止临时扫业务库或打开任意 source locator。数字、次数、时间范围、Project/Thread/Run 数由系统从 refs 计算。单个 Thread 可以生成 `single_case` 候选，但要泛化为跨场景经验，默认至少需要两个独立 Thread/Run 证据组；否则缩小 applicability。

### 触发方式

- UI 手动：先预览将发送的 facts、excerpts、脱敏数和 coverage，再确认生成。
- CLI/Agent 手动：`rw activity analyze` 或 `learning.generate` 调同一个 API，只能创建 Candidate，不能跳过审核直接发布。
- 定时 Agent：事实底座稳定后再开放；按 source watermark 增量分析，7 天内容过期前做 sweep。
- 事件触发：completion、run done/failed、verification fail→pass 只创建待分析窗口，quiet period 后再生成，不为每个事件单独调用模型。

## 实施阶段

### P0：协议、事件目录与预算冻结

改动范围：

- 新增 `packages/shared/src/activity/`：envelope、event schemas、refs、retention、query/stream DTO。
- 新增 `docs/architecture/activity-data-foundation.md`：稳定架构事实与事件目录。
- 建立 24 个核心事件族及其 variants 的 producer allowlist、字段、privacy、priority、retention 与 payload 上限。
- 固定 runtime/surface 枚举、ID 传播规则、外部 TTY 覆盖承诺和容量预算。

验收：schema fixture、secret fixture、未知版本、payload 超限、runtime/surface 组合、ID 关系全部通过；没有 generic `payload: unknown` 入口。

### P1：Activity Hub、独立存储与 Sources

改动范围：

- 新增 `activity-hub/` workspace package：discovery/auth、batch ingest、segmented store、Content Vault、SQLite projection、retention、quarantine、query/WS。
- 新增 `packages/shared/src/activity/discovery.ts` 与 capability contract。
- 新增 `packages/runweave-cli/src/commands/activity.ts`：install/start/stop/status/query/export/delete。
- 新增 producer SDK 与 per-producer disk spool。
- 在 Web/Desktop 增加 Sources/Data Policy 最小只读面板。

验收：Hub 下线/replay、重复、gap、schema reject、crash、projection rebuild、7/30 天 purge、Stable/Beta 同库隔离字段、5 GB quota 策略。

### P2：核心 Producer 与真实 Facts/Timeline

改动范围：

- Backend：在 terminal application service、runtime recorder、Preview/File/Git、Voice、Quick Input、verification 边界主动记录。
- Electron：runtime、Terminal Browser tab/navigation/CDP/annotation、update/recovery 边界主动记录。
- Hook：新增独立 `activity-client.cjs`，不复用通知所需的 Runweave Terminal gate；有 Thread 时允许 external Agent Query/Reply 写入。
- Shell：可选 zsh/bash/fish preexec/precmd integration，明确用户启用与内容策略。
- Agent Team：在 run/worker/round/case/human/recovery 状态 transition 处记录事件；完整 run/outbox/evidence 只保存 ref。
- Playwright/verification：由 runner 写 target identity、case/result 和 evidence ref。
- Frontend/App：只记录 backend 无法知道的高价值语义 UI 动作，不做 clickstream。
- 新增 Facts、Interaction Timeline 和 Sources 完整页面。

验收：至少一次真实 Stable、Beta、Dev、CLI、external Hook、Agent Team、Browser、verification 轨迹集中显示；source 删除后事实仍在；未安装 shell integration 的外部命令明确显示不在 coverage。

### P3：Context Pack 与手动 Learning

改动范围：

- Activity Hub 增加 AnalysisJob、Context Pack、resolver、pack-time DLP、model provider port。
- 新增 LearningRun、Candidate、Review、Version、SupportCapsule 独立 store/API。
- UI 增加 Generate、Runs、Candidates、Review、Published；CLI/Agent 调同一 API。
- 引入 evidence ref、数字、scope、反例和重复候选校验。

验收：同一 Pack + model/prompt 可审计复跑；伪造 evidence/数字被拒；UI 和 Agent 生成一致；行为原始内容过期后 Published Learning 仍有最小胶囊且明确原始证据状态。

### P4：增量 Agent、检索与反馈闭环

改动范围：

- 定时/事件触发 Learning Agent 与 source watermark。
- Published Learning 的结构化 + semantic 检索。
- `learning.retrieved/applied/feedback` 事实。
- stale/wrong/unsafe 反馈复审与版本 supersede。

验收：只向 Agent 返回 published version；负反馈不会静默删除或自动改经验；所有使用可追溯到 `learningId@version`。

## 上线与迁移

- 不做全量历史迁移。上线时只从启用后的行为开始主动写入，保证语义可信。
- 可提供一次性 7 天 backfill 工具读取 App Server event、当前 Agent Team run 与有限 Thread metadata；所有 backfill 事件标 `producer=migration`、`captureMode=backfill`，不能混成实时采集。
- Producer 按 Runtime/Surface 分批开启：Dev → Beta → Stable；每批先观察 24 小时 Sources gap、disk、redaction 与 reject。
- Hub schema 必须向后兼容至少当前 Stable 与一个 Beta 版本；未知 Beta schema quarantine，不能拖垮 Stable 查询。
- 任一 producer 可独立关闭；关闭时 Sources 显示 inactive 和最后 watermark，不删除历史事实。

## 必跑门禁与证据

每个实施阶段按顺序执行：

```bash
pnpm architecture:check
pnpm typecheck
pnpm lint
pnpm build
git diff --check
```

涉及页面必须执行 `$playwright-cli`；涉及桌面启动、Stable/Beta 并行和系统权限先用 `$computer-use` 准备环境，再用 `$playwright-cli` 页面验收。不得用静态检查、源码阅读或截图冒充实际行为。

证据目录建议：

```text
artifacts/activity-data-foundation/<phase>/
  environment.json
  commands/
  api/
  storage/
  retention/
  privacy/
  browser/
  desktop/
  learning/
```

每份证据记录 Git SHA、Activity Hub version/home、Runtime channel、surface、producer instance/boot/sequence、project/session/thread/run、开始结束时间和完整退出码；敏感正文只记录 digest 与 redaction count。

## 冻结决策

- 采用独立 per-user Activity Hub，不扩展现有 App Server 为行为仓。
- 采用“主动写入为主，External Ref 为辅”，不采用运行时联邦扫描。
- 采用 7 天内容 / 30 天事实，不做永久原始行为归档。
- 采用显式 ID 关联，不做时间邻近 Task 推断。
- 第一阶段只做 Facts/Timeline/Sources，不生成 Learning。
- Learning 必须由模型基于冻结 Context Pack 生成，确定性代码只负责选择、脱敏、数字和证据校验。
- Published Learning 与事实分离、版本化、可删除；模型永远不能修改事实。
