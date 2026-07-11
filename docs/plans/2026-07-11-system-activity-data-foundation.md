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
- 只有完整 Thread、完整 tmux scrollback、大输出、截图/录屏、完整 Agent Team run/outbox 等大对象或已有权威副本保存 `ExternalRef`。
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

因此第一阶段 UI 是 Facts、Interaction Timeline 和 Sources，不是 Task 管理页。Task/Requirement 如未来需要，只能是事实之上的独立产品对象或确定性查询视图。

### 3. Goal、Outcome 和 Learning 不是基本事实

以下三类字段必须分开：

| 类型       | 示例                                                                           | 页面标识        | 生成者              |
| ---------- | ------------------------------------------------------------------------------ | --------------- | ------------------- |
| 直接事实   | Query request 正文、时间、Runtime、Thread ID、命令、退出码、状态迁移、验证结果 | Recorded        | 业务源主动记录      |
| 确定性计算 | 时长、显式 retry 次数、事件数量、阶段序列、覆盖缺口                            | Computed        | Activity Hub 查询层 |
| 模型产物   | Goal、Outcome 摘要、问题模式、建议、Learning                                   | Model-generated | Learning Agent/模型 |

Facts 页面不能把模型写出的 Goal/Outcome 当成已记录事实。`Duration` 可以由明确的开始/结束事件计算；`Rework` 只有在系统主动记录 retry/reopen/recheck 时才能计算，否则不展示。

## 目标与完成标准

全部满足才算完成事实底座：

- 行为数据写入独立 `~/.runweave/activity-hub/`，不落入 Stable/Beta App Server home、Backend LowDB、项目 `.runweave` 或诊断日志目录。
- Stable、Beta、Dev 和 external producer 可写入同一个 Hub，且事件保留真实 `runtimeChannel` 与 `surface`；两套产品运行时仍保持控制面、认证和 App Server 隔离。
- 核心行为在发生时主动写入；删除或停止对应业务源后，已写入的 30 天事实仍可查询。
- 规范化事件具备稳定 ID、producer sequence、schema、发生/接收时间、actor、runtime、scope、correlation、result、privacy 和 retention。
- 业务写路径不等待 Hub；Hub 下线时 producer spool，恢复后重放，重复投递不产生重复事实。
- Sources 页面能显示每个 producer 的 produced/acked sequence、缺口区间、丢弃数、最后心跳、SQLite commit 延迟和 WAL 状态，不使用没有分母的“98% coverage”。
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
- 当前 Shell Integration 能给 `runtime-recorder` 提供 cwd 与规范化后的 active command basename；Terminal stream 有 output，但没有逐命令全文、command ID、exit 与 duration。
- Hook 路径已识别 `SessionStart/UserPromptSubmit/Stop/PostToolUse` 及部分 session/thread/cwd 字段；当前 bridge 尚未把 prompt、session source、turn/tool use ID、tool input/response 统一转发到行为数据入口。
- Agent Team run 已有 worker、round、acceptance、evidence、human note、错误指纹、恢复与最终状态。
- Terminal Browser manager 有明确 tab create/attach/close 与 navigation handler；CDP proxy 只有底层 protocol command，Playwright 当前没有身份化 Activity reporter。Quick Input、Voice 与 CLI 另有各自结构化入口。
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
  discover/auth → validate schema → redact → SQLite transaction → ACK
                     │
                     ▼
        activity.sqlite · canonical truth
  behavior_facts · content BLOB · refs · sources · quarantine
          WAL · foreign keys · indexes · retention rows
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

### Producer 输入与 Canonical BehaviorFact

Producer 输入和 Hub 最终入库对象是两个类型。Producer 不能填写 Hub offset、接收时间、最终隐私分类、留存或优先级。

```ts
interface ActivityScopeInput {
  cwd?: string;
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
}

interface ActivityEventInput<EventName extends string, Payload> {
  eventId: string; // UUIDv7，由 Producer SDK 生成，retry 保持不变
  eventName: EventName;
  schemaVersion: number;
  occurredAt: string;

  producer: {
    name: string;
    version: string;
    instanceId: string;
    bootId: string;
    sequence: number;
  };

  actor: {
    type: "user" | "agent" | "system" | "unknown";
    agent?: "codex" | "claude" | "trae" | "playwright" | "other";
  };

  runtime: {
    channel: "stable" | "beta" | "dev" | "external";
    surface:
      | "backend"
      | "app_server"
      | "desktop"
      | "web"
      | "app"
      | "cli"
      | "hook"
      | "shell";
    appVersion?: string;
    sourceRevision?: string;
    backendProfile?: string;
  };

  scope: ActivityScopeInput;

  correlationId?: string;
  causationId?: string;
  parentEventId?: string;
  result?: {
    status: "succeeded" | "failed" | "cancelled";
    code?: string;
  };
  payload: Payload; // 有界、按 event schema 验证
  contentRefs: ActivityContentRef[];
  externalRefs: ExternalRefLink[];
}

type BehaviorFact<EventName extends string, Payload> = Omit<
  ActivityEventInput<EventName, Payload>,
  "scope"
> & {
  ingestedAt: string; // Hub 接收并完成 durable append 的时间
  hubOffset: string; // Hub 分配的单调 offset，只表示接收顺序
  scope: ActivityScopeInput & {
    deviceId: string; // Hub installation identity
  };
  privacy: {
    classification: string;
    redactionVersion: string;
    localOnly: boolean;
  };
  retentionClass: "fact_30d";
  priority: "critical" | "normal" | "sampled";
};
```

`occurredAt` 与 `ingestedAt` 必须分开。系统只保证同一 `(producer.instanceId, bootId)` 内的 sequence 顺序；跨 producer 不伪造全局发生顺序，因果关系依赖显式 correlation/causation。

#### 公共字段来源

来源分类固定为：`SDK`（Producer SDK 生成）、`Producer`（业务边界直接提供）、`Hub`（Activity Hub 写入）、`Registry`（Schema Registry 固定策略）、`Computed`（查询时从 SQLite 事实确定性计算）。同一个 `eventName + schemaVersion` 的字段来源属于 schema contract，不在每行事实里重复保存。

| 字段                                                   | 必填  | 来源类别          | 原始来源与生成规则                                                                                         | Hub 校验                              |
| ------------------------------------------------------ | ----- | ----------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `eventId`                                              | 是    | SDK               | 行为边界首次调用 typed builder 时生成 UUIDv7；spool/retry 原样复用                                         | UUID 格式、eventId 去重               |
| `eventName` / `schemaVersion`                          | 是    | Registry          | typed builder 常量；调用方不能传任意字符串                                                                 | schema 存在且 producer 在 allowlist   |
| `occurredAt`                                           | 是    | Producer          | 业务记录已有权威时间时直接使用；否则由对应 Producer adapter 在动作/观察边界读取 UTC wall clock             | 合法 RFC3339、记录 clock skew，不重写 |
| `ingestedAt` / `hubOffset`                             | 是    | Hub               | durable append 时由 Hub 读取时钟并分配 64-bit 单调 offset                                                  | Producer 输入中出现即拒绝             |
| `producer.name` / `producer.version`                   | 是    | SDK               | Producer 初始化时的静态 manifest                                                                           | 与 capability namespace 匹配          |
| `producer.instanceId`                                  | 是    | SDK               | 安装/配置实例的稳定 ID；进程重启不变                                                                       | token 绑定实例                        |
| `producer.bootId`                                      | 是    | SDK               | 每次进程启动生成 UUID；仅本次 boot 使用                                                                    | 与 instance 组成 sequence epoch       |
| `producer.sequence`                                    | 是    | SDK               | 同一 `(instanceId, bootId)` 的 durable 单调计数器                                                          | 唯一、检测 gap/倒退                   |
| `actor.type` / `actor.agent`                           | 是/否 | Producer/SDK      | 由明确入口或 Agent adapter identity 给出；Shell 等观察者拿不到发起者时写 `unknown`，禁止从文本猜           | 与 event producer allowlist 组合校验  |
| `runtime.channel` / `runtime.surface`                  | 是    | SDK               | Runtime manifest 与 adapter 常量；Backend/App Server 使用自身 surface，CLI/Hook/Shell 也只决定 surface     | 固定枚举，CLI 不能伪装 runtime        |
| `runtime.appVersion/sourceRevision/backendProfile`     | 否    | SDK               | Runtime manifest 明确暴露时写入；当前 backend 只有敏感目录路径，新增稳定 profile ID 前必须为空             | 格式、长度、secret scan               |
| `scope.deviceId`                                       | 是    | Hub               | Hub 从 `identity/device.json` 读取 installation identity 后写入 canonical Fact                             | Producer 输入中出现即拒绝             |
| `scope.cwd`                                            | 否    | Producer          | Terminal session、Shell `$PWD` 或 Agent Hook 原始 `cwd`；Hub 按 path policy 规范化/脱敏                    | 长度、路径脱敏、secret scan           |
| `scope.projectId/terminalSessionId/panelId/tmuxPaneId` | 否    | Producer          | Terminal request/session 或受控 `RUNWEAVE_*` 环境；外部 TTY 不猜 Terminal/Panel                            | ID 格式与 producer 权限               |
| `scope.threadId/turnId`                                | 否    | Producer          | 受支持 Agent Hook 原始字段；未暴露时为空                                                                   | 不允许通过正文或时间邻近补齐          |
| `scope.interactionId`                                  | 否    | SDK               | Query submit request 边界生成，并通过受控调用链显式传播                                                    | UUID；缺失事件标记 unlinked           |
| `scope.runId`                                          | 否    | Producer          | Agent Team `AgentTeamRun.runId`                                                                            | 对应 producer namespace               |
| `scope.operationId`                                    | 否    | Producer/SDK      | 输入 API 已有 operationId 时沿用；command/navigation/verification 新边界生成                               | 同一 operation 的事件类型兼容         |
| `scope.browserGroupId/tabId`                           | 否    | Producer          | Electron Terminal Browser runtime entry                                                                    | 只允许 Browser producer 写            |
| `correlationId` / `causationId` / `parentEventId`      | 否    | Producer/SDK      | 调用链显式传递的 interaction/event ID；`parentEventId` 仅控制 UI 树                                        | 被引用 ID 格式；不存在也不猜          |
| `result.status` / `result.code`                        | 否    | Producer          | 明确完成边界的结构化结果；没有统一成功语义的 Hook 不写 result                                              | event variant 限定枚举                |
| `payload`                                              | 是    | Producer          | 下方逐事件 payload schema；只收业务边界直接字段                                                            | Zod/JSON Schema、大小、字段 allowlist |
| `contentRefs` / `externalRefs`                         | 是    | Producer/Hub      | Producer 先写 Hub Content 或注册 resolver，再把稳定 ref 放入事件                                           | authority、digest、大小、ownership    |
| `privacy.*`                                            | 是    | Registry/Hub      | Registry 定义分类与 local-only；Hub 写实际 redaction 版本                                                  | Producer 不可覆盖                     |
| `retentionClass` / `priority`                          | 是    | Registry          | 每个 event schema 固定；P0 Fact 为 30 天                                                                   | Producer 输入中出现即拒绝             |
| `durationMs`                                           | 否    | Producer/Computed | 同一常驻 adapter 有 monotonic timer 时由该 event schema 直接允许；Command/Tool/Worker 等否则用成对事实计算 | 禁止用跨源时钟伪造                    |
| 当前 `availability`、coverage/gap 聚合等查询字段       | 否    | Computed          | 使用 SQLite row、resolver、sequence 与 watermark 确定性计算                                                | 不覆盖原始 Fact row                   |

#### SQLite Canonical 表

`activity.sqlite` 是唯一 canonical truth。Hub 在同一事务中完成去重、Fact、Content/Ref link、producer sequence 与 gap 状态写入；事务 `COMMIT` 成功后才返回 ACK。下表不是缓存或投影，删除数据库就等于删除行为数据。

```sql
CREATE TABLE behavior_facts (
  hub_offset INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  event_name TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  ingested_at_ms INTEGER NOT NULL,

  producer_name TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  producer_instance_id TEXT NOT NULL,
  producer_boot_id TEXT NOT NULL,
  producer_sequence INTEGER NOT NULL,

  actor_type TEXT NOT NULL,
  actor_agent TEXT,
  runtime_channel TEXT NOT NULL,
  runtime_surface TEXT NOT NULL,
  app_version TEXT,
  source_revision TEXT,
  backend_profile TEXT,

  device_id TEXT NOT NULL,
  cwd TEXT,
  project_id TEXT,
  terminal_session_id TEXT,
  panel_id TEXT,
  tmux_pane_id TEXT,
  thread_id TEXT,
  turn_id TEXT,
  interaction_id TEXT,
  run_id TEXT,
  operation_id TEXT,
  browser_group_id TEXT,
  tab_id TEXT,

  correlation_id TEXT,
  causation_id TEXT,
  parent_event_id TEXT,
  result_status TEXT,
  result_code TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),

  privacy_classification TEXT NOT NULL,
  redaction_version TEXT NOT NULL,
  local_only INTEGER NOT NULL CHECK (local_only IN (0, 1)),
  retention_class TEXT NOT NULL,
  priority TEXT NOT NULL,

  UNIQUE (producer_instance_id, producer_boot_id, producer_sequence)
) STRICT;

CREATE INDEX facts_timeline_idx
  ON behavior_facts (occurred_at_ms, hub_offset);
CREATE INDEX facts_interaction_idx
  ON behavior_facts (interaction_id, occurred_at_ms, hub_offset)
  WHERE interaction_id IS NOT NULL;
CREATE INDEX facts_thread_idx
  ON behavior_facts (thread_id, occurred_at_ms, hub_offset)
  WHERE thread_id IS NOT NULL;
CREATE INDEX facts_run_idx
  ON behavior_facts (run_id, occurred_at_ms, hub_offset)
  WHERE run_id IS NOT NULL;
CREATE INDEX facts_terminal_idx
  ON behavior_facts (terminal_session_id, occurred_at_ms, hub_offset)
  WHERE terminal_session_id IS NOT NULL;
CREATE INDEX facts_event_idx
  ON behavior_facts (event_name, occurred_at_ms, hub_offset);
```

`payload_json` 不是 `unknown` 逃生口：写入前已经按 `eventName + schemaVersion` 验证。需要索引的 payload 字段由 Registry migration 建立带 event 条件的 `json_extract(...)` expression index，不引入通用 EAV 表。

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

interface ActivityContentRef {
  role:
    | "query"
    | "response"
    | "command"
    | "tool_args"
    | "tool_result"
    | "excerpt";
  contentId: string;
  sha256: string; // 内容删除后仍随 Fact 保留
  byteLength: number;
  expectedExpiresAt: string;
}
```

Query、可见 Assistant 回复、命令文本等核心内容都加密后写入 `activity.sqlite.activity_contents` 的 BLOB 列，Fact 只保存 ref 与 digest/size 快照，不 inline 正文到 `payload_json`。7 天到期时在事务中删除 ciphertext，保留 Fact link 的 digest/size 快照至 30 天。

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
    | "verification_evidence";
  locator: string;
  versionOrDigest: string;
  capturedAt: string;
  expectedExpiresAt?: string;
}

interface ExternalRefLink extends ExternalRef {
  role: "thread" | "scrollback" | "run" | "outbox" | "evidence" | "artifact";
  availabilityAtCapture: "available" | "missing";
}
```

Ref 必须有 authority 与版本/哈希。`availabilityAtCapture` 是不可变事实，当前 `available/expired/missing/deleted` 由 SQLite 状态与 resolver 得出，不覆盖历史 Fact。`locator` 以 ciphertext BLOB 存入 SQLite，模型不能拿 locator 任意读取本机文件；Context Pack Builder 只能通过注册的 resolver 读取最小片段并再次脱敏。

### Content、Ref 与 Sources 辅助表

```sql
CREATE TABLE activity_contents (
  content_id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  kind TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  compression TEXT NOT NULL,
  encryption TEXT NOT NULL,
  ciphertext BLOB,
  nonce BLOB,
  auth_tag BLOB,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  redaction_version TEXT NOT NULL,
  current_availability TEXT NOT NULL,
  deleted_at_ms INTEGER,
  CHECK (
    (current_availability = 'available' AND ciphertext IS NOT NULL AND nonce IS NOT NULL AND auth_tag IS NOT NULL)
    OR
    (current_availability != 'available' AND ciphertext IS NULL AND nonce IS NULL AND auth_tag IS NULL)
  )
) STRICT;

CREATE TABLE fact_content_links (
  event_id TEXT NOT NULL,
  role TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  content_id TEXT NOT NULL,
  sha256_snapshot TEXT NOT NULL,
  byte_length_snapshot INTEGER NOT NULL,
  expected_expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY (event_id, role, ordinal),
  FOREIGN KEY (event_id) REFERENCES behavior_facts(event_id),
  FOREIGN KEY (content_id) REFERENCES activity_contents(content_id)
) STRICT;

CREATE TABLE external_refs (
  ref_id TEXT PRIMARY KEY,
  authority TEXT NOT NULL,
  locator_ciphertext BLOB NOT NULL,
  locator_nonce BLOB NOT NULL,
  locator_auth_tag BLOB NOT NULL,
  version_or_digest TEXT NOT NULL,
  captured_at_ms INTEGER NOT NULL,
  expected_expires_at_ms INTEGER,
  current_availability TEXT NOT NULL,
  last_checked_at_ms INTEGER
) STRICT;

CREATE TABLE fact_external_ref_links (
  event_id TEXT NOT NULL,
  role TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  ref_id TEXT NOT NULL,
  availability_at_capture TEXT NOT NULL,
  PRIMARY KEY (event_id, role, ordinal),
  FOREIGN KEY (event_id) REFERENCES behavior_facts(event_id),
  FOREIGN KEY (ref_id) REFERENCES external_refs(ref_id)
) STRICT;

CREATE TABLE producer_instances (
  producer_instance_id TEXT NOT NULL,
  producer_boot_id TEXT NOT NULL,
  producer_name TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  runtime_channel TEXT NOT NULL,
  runtime_surface TEXT NOT NULL,
  started_event_id TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER NOT NULL,
  highest_seen_sequence INTEGER NOT NULL,
  highest_contiguous_sequence INTEGER NOT NULL,
  PRIMARY KEY (producer_instance_id, producer_boot_id)
) STRICT;

CREATE TABLE source_gaps (
  gap_id TEXT PRIMARY KEY,
  producer_instance_id TEXT NOT NULL,
  producer_boot_id TEXT NOT NULL,
  first_sequence INTEGER NOT NULL,
  last_sequence INTEGER NOT NULL,
  status TEXT NOT NULL,
  detected_at_ms INTEGER NOT NULL,
  closed_at_ms INTEGER,
  reason_code TEXT,
  source_event_id TEXT,
  FOREIGN KEY (producer_instance_id, producer_boot_id)
    REFERENCES producer_instances(producer_instance_id, producer_boot_id)
) STRICT;

CREATE TABLE ingest_quarantine (
  quarantine_id TEXT PRIMARY KEY,
  received_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  producer_name TEXT,
  producer_instance_id TEXT,
  event_name TEXT,
  schema_version INTEGER,
  payload_sha256 TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  sanitized_error_json TEXT NOT NULL CHECK (json_valid(sanitized_error_json)),
  ciphertext BLOB,
  nonce BLOB,
  auth_tag BLOB,
  CHECK (
    (ciphertext IS NULL AND nonce IS NULL AND auth_tag IS NULL)
    OR
    (ciphertext IS NOT NULL AND nonce IS NOT NULL AND auth_tag IS NOT NULL)
  )
) STRICT;

CREATE TABLE retention_watermarks (
  data_class TEXT PRIMARY KEY,
  deleted_through_ms INTEGER NOT NULL,
  last_sweep_at_ms INTEGER NOT NULL
) STRICT;
```

- 上述表全部位于 `activity.sqlite`。`behavior_facts`、Content ciphertext、Ref descriptor、link、producer cursor 与 gap state 在一个 SQLite 事务边界内保持一致。
- Fact link 保存创建时 digest/size/availability 快照；Content 或外部对象过期后，历史事件仍能解释当时引用了什么。
- `source_gaps` 可以从 sequence 重新核对，但它仍是 canonical SQLite 中的来源健康状态，不维护第二份 JSONL 事实源。
- Quarantine 也在 SQLite。只有通过大小上限与 pre-ingest secret scan 的原始 bytes 才允许加密写入；secret-blocked 请求只留 hash、reason 与脱敏错误，不保存原文。
- 未知 sequence gap 的 `reason_code/source_event_id` 必须为 `NULL`；只有 `source.events_dropped` 能提供确定原因。

#### SQLite 辅助表字段来源

`behavior_facts` 的每列来源已由上方“公共字段来源”逐一覆盖；`payload_json` 内部字段再由下方各 P0 事件表覆盖。其余 canonical 表的所有列按下表生成，Producer 不能直接提交一整行 SQLite record。

| 表                        | 字段                                                                                                   | 来源类别          | 原始来源与生成规则                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------- |
| `activity_contents`       | `content_id`                                                                                           | Hub               | Content ingest transaction 生成的 UUID；同一 ref 重试复用                                      |
| 同上                      | `sha256/byte_length`                                                                                   | Hub               | 对最终脱敏、压缩前的 canonical plaintext bytes 计算；不信任 Producer 声明值                    |
| 同上                      | `kind/media_type`                                                                                      | Registry/Producer | `kind` 由 event content role 映射；`media_type` 来自 typed content API 且须在 schema allowlist |
| 同上                      | `compression/encryption`                                                                               | Registry          | 当前 schema 固定 `none                                                                         | gzip`与`aes-256-gcm`，Producer 不可覆盖 |
| 同上                      | `ciphertext/nonce/auth_tag`                                                                            | Hub               | Hub 使用 Keychain key 对允许落盘的 bytes 执行 AES-256-GCM 后生成                               |
| 同上                      | `created_at_ms`                                                                                        | Hub               | Content 与 Fact 同一事务开始写入时的 Hub 时间                                                  |
| 同上                      | `expires_at_ms`                                                                                        | Registry/Hub      | Registry 的 7 天 TTL 加 `created_at_ms`；受更短 Project policy 限制时取更早值                  |
| 同上                      | `redaction_version`                                                                                    | Hub               | 本次实际执行的最终 DLP/redactor 版本                                                           |
| 同上                      | `current_availability/deleted_at_ms`                                                                   | Hub               | 初始为 `available/NULL`；retention/delete 事务清空密文时写 `expired                            | deleted` 与时间                         |
| `fact_content_links`      | `event_id`                                                                                             | SDK/Hub           | 正在同一事务写入的 `BehaviorFact.event_id`；Hub 验证存在且归属当前 batch                       |
| 同上                      | `role`                                                                                                 | Registry          | 对应 event schema 的 content role allowlist                                                    |
| 同上                      | `ordinal`                                                                                              | Hub               | 按 Producer 输入中同 role ref 的稳定顺序从 0 分配                                              |
| 同上                      | `content_id`                                                                                           | Hub               | 已在本事务或既有 `activity_contents` 中验证成功的 ID                                           |
| 同上                      | `sha256_snapshot/byte_length_snapshot/expected_expires_at_ms`                                          | Hub               | 从所链接 `activity_contents` row 复制，不接受 Producer 单独声明                                |
| `external_refs`           | `ref_id`                                                                                               | Hub               | Resolver registration transaction 生成的 UUID；重试复用                                        |
| 同上                      | `authority`                                                                                            | Registry          | capability 对应的注册 resolver 常量，如 `codex_thread`、`terminal_scrollback`                  |
| 同上                      | `locator_ciphertext/locator_nonce/locator_auth_tag`                                                    | Hub               | 对 resolver 校验后的 locator 执行 AES-256-GCM 后生成；明文不写 Fact                            |
| 同上                      | `version_or_digest`                                                                                    | Producer/Resolver | 源系统明确提供的 immutable version、revision 或 canonical object digest                        |
| 同上                      | `captured_at_ms`                                                                                       | Hub               | resolver 成功确认对象与版本的时间                                                              |
| 同上                      | `expected_expires_at_ms`                                                                               | Producer/Resolver | 权威源明确暴露 TTL 时写；拿不到为 `NULL`，不猜                                                 |
| 同上                      | `current_availability/last_checked_at_ms`                                                              | Hub/Resolver      | 注册时及后续显式 resolver check 的结构化结果与检查时间                                         |
| `fact_external_ref_links` | `event_id/ref_id`                                                                                      | Hub               | 当前 Fact 与已注册 External Ref 的已验证主键                                                   |
| 同上                      | `role`                                                                                                 | Registry          | 对应 event schema 的 external ref role allowlist                                               |
| 同上                      | `ordinal`                                                                                              | Hub               | 按同 role ref 的稳定顺序从 0 分配                                                              |
| 同上                      | `availability_at_capture`                                                                              | Hub/Resolver      | Fact transaction 当时 resolver 返回的 `available                                               | missing` 快照；以后不改                 |
| `producer_instances`      | `producer_instance_id/producer_boot_id/producer_name/producer_version/runtime_channel/runtime_surface` | SDK               | 已通过 capability 与 schema 校验的 Producer envelope；Hub 不从目录或端口猜                     |
| 同上                      | `started_event_id/started_at_ms`                                                                       | Hub               | 同一 epoch 首个合法 `producer.instance.started` Fact 的 ID 与 occurred time                    |
| 同上                      | `last_seen_at_ms`                                                                                      | Hub               | 最近一次成功 COMMIT 该 epoch event 的 ingest time                                              |
| 同上                      | `highest_seen_sequence/highest_contiguous_sequence`                                                    | Hub               | 在事务中根据已提交 sequence set 更新；不是 Producer 自报水位                                   |
| `source_gaps`             | `gap_id`                                                                                               | Hub               | 第一次检测到连续缺口区间时生成的 UUID                                                          |
| 同上                      | `producer_instance_id/producer_boot_id/first_sequence/last_sequence`                                   | Hub               | 比较已提交 sequence 与 epoch cursor 后确定；迟到补齐时可拆分/关闭区间                          |
| 同上                      | `status/detected_at_ms/closed_at_ms`                                                                   | Hub               | gap 状态机与 Hub transaction 时间                                                              |
| 同上                      | `reason_code/source_event_id`                                                                          | Hub               | 只有验证通过的 `source.events_dropped` Fact 才能映射原因并链接 event ID；否则为 `NULL`         |
| `ingest_quarantine`       | `quarantine_id/received_at_ms/expires_at_ms`                                                           | Hub/Registry      | Hub 生成 UUID/接收时间；按 7 天或更短 policy 算过期时间                                        |
| 同上                      | `producer_name/producer_instance_id/event_name/schema_version`                                         | Hub               | 从未信任 envelope 中仅提取通过长度/字符集检查的标识；解析失败可为 `NULL`                       |
| 同上                      | `payload_sha256/reason_code/sanitized_error_json`                                                      | Hub               | 对收到 bytes 计算 digest，并由 ingress validator 输出闭集 reason 与脱敏错误                    |
| 同上                      | `ciphertext/nonce/auth_tag`                                                                            | Hub               | 仅在大小检查与 secret scan 通过后加密原始 bytes；否则三列均为 `NULL`                           |
| `retention_watermarks`    | `data_class`                                                                                           | Registry          | 固定的 retention class 名称，不接受任意 Producer 值                                            |
| 同上                      | `deleted_through_ms/last_sweep_at_ms`                                                                  | Hub               | 成功提交有界 retention transaction 后更新；失败事务不推进水位                                  |

数据库 schema 版本使用 SQLite `PRAGMA user_version`，只由 Hub migration 修改。它是数据库元数据，不是行为 Fact，也不依赖外部文件。

### Schema Registry

`packages/shared` 为每个 `eventName + schemaVersion` 保存：

- Zod/JSON Schema 与 TypeScript 类型；
- 每个字段的 JSON Pointer、必填性与来源类别（SDK/Producer/Hub/Registry/Computed）；
- producer allowlist；
- payload/content 大小上限；
- 可索引字段；
- PII/secret 分类与 redactor；
- retention 与 priority；
- upcaster 和废弃日期。

Producer SDK 编译期约束，Hub 入库时再次验证。未知或坏 schema 进入 7 天 quarantine，并写 Sources gap；不能作为 generic `payload: unknown` 混入 Facts。

```ts
interface ActivityFieldSpec {
  jsonPointer: string;
  required: boolean;
  source: "sdk" | "producer" | "hub" | "registry" | "computed";
  origin: string; // 例如 codex.UserPromptSubmit.prompt 或 AgentTeamRun.phase
  producerAllowlist: string[];
  privacy: "public" | "internal" | "private_content" | "secret_blocked";
  indexed: boolean;
}
```

Hub 使用这份 manifest 拒绝“来源不可能”的字段，例如 Hook producer 写 `hubOffset`、CDP producer 写高层 `click`、Agent Team outbox 写 `verification verdict`。字段 provenance 通过 `eventName + schemaVersion + producer identity` 可重放，不在每条 Fact 中复制一份描述文本。

## 事实目录与采集边界

### P0 核心 14 个事件族

| 领域         | 事件                                                    | 可靠采集边界                                                                       | 直接存储                                                       | 可能引用                       | 记录作用                               |
| ------------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------ | -------------------------------------- |
| Source       | `producer.instance.started`                             | Producer 完成启动并取得 boot identity                                              | producer、boot、channel、surface、version/revision（若有）     | 无                             | 锚定来源实例和版本，不伪造停止时间     |
| Terminal     | `terminal.session.created/deleted`                      | Terminal application service 创建或删除                                            | session、project、cwd、runtime、status/reason                  | 无                             | 确定行为所属 Terminal 的真实生命周期   |
| Terminal     | `terminal.command.started/completed`                    | 首期仅受控 interactive zsh；升级 marker 显式提供 commandId、正文与 exit            | command content ref、cwd、exit/result；duration 为 Computed    | 无，不把 output 归因到单命令   | 还原命令与终态，不伪造输出归属         |
| User         | `user.query.submit_requested`                           | Activity Hook 原样转发 `UserPromptSubmit`                                          | interaction、thread、turn、query content ref                   | 完整 Thread（resolver 成功时） | 保存用户请求发送的 Query，不声称已接受 |
| Agent        | `agent.thread.started/resumed`                          | Activity Hook 转发 `SessionStart.source=startup/resume`；忽略 clear/compact        | agent、thread、source、model、permission                       | 完整 Thread（resolver 成功时） | 区分受支持 Agent 的新会话与显式续接    |
| Agent        | `agent.response.observed`                               | Activity Hook 保留主 Agent原始 `Stop` 与 last assistant message；排除 SubagentStop | thread、turn、model、permission、response content ref          | 完整 Thread（resolver 成功时） | 保存来源明确暴露的完整回复段           |
| Tool         | `agent.tool.requested/completed`                        | 补齐 `PreToolUse`，并按 tool use ID 配对 `PostToolUse`                             | agent、turn、tool、call ID、确定性 args/result summary         | 注册 artifact（若明确提供）    | 区分工具调用请求和可观察的执行后结果   |
| Browser      | `browser.tab.created/activated/closed`                  | Electron Browser manager 的 create/attach/close                                    | group、tab、reason、sanitized URL（若有）                      | 无                             | 固定浏览器活动目标，不声称键盘焦点     |
| Browser      | `browser.navigation.started/completed/failed/cancelled` | Electron main-frame events；cancelled 仅限显式 Stop/被新 navigationId 取代         | navigation、tab、sanitized from/to、result、monotonic duration | 无                             | 证明主页面实际导航及其终态             |
| Verification | `verification.started/completed`                        | 独占写权限的身份化 runner 校验 case manifest hash 与 target handshake              | verification、runner、case、target identity、result、duration  | report/screenshot/trace        | 由 runner 实际 verdict 区分声称与验证  |
| Agent Team   | `agent_team.run.created/state_changed/completed`        | Run 首次写入及结构化状态迁移                                                       | run、phase、round、status、reason code                         | run snapshot                   | 展示团队运行阶段、轮次和最终收敛结果   |
| Agent Team   | `agent_team.worker.dispatched/result_recorded`          | Prompt 成功投递及通过 identity/freshness 校验的 outbox                             | run、worker role、panel、requestedAt、显式 finishedAt/result   | pane/outbox                    | 识别角色承担的工作及其真实上报结果     |
| Agent Team   | `agent_team.case.dispatched/result_recorded`            | Case 写入 review/verify/recheck prompt 且投递成功；outbox 批量结果                 | run、case ID、source、reported result                          | evidence                       | 追踪 Case 被分派及记录到的结果         |
| Collector    | `source.events_dropped`                                 | Producer 明确执行 quota/sampling drop 并保留 loss ledger                           | producer、boot、sequence range、dropped count、reason code     | 无                             | 暴露已知丢弃；未知 gap 不伪造原因      |

表中 slash 表示同一 schema family 的 variants；14 个事件族展开后的每个 event name 都在 registry 单独定义 schema。P0 只接能在真实业务边界稳定拿到的数据，不从文本或时间邻近推断。Project 与 Panel 仅作为有价值事件的 `scope.projectId`、`scope.panelId`，不定义独立的上下文切换或焦点事件。

本轮代码审计后，整族删除 `user.interrupt.requested`、`agent.turn.*`、`browser.automation.performed` 和 `human.review.recorded`：显式 `/interrupt` 只覆盖部分入口且没有用户 reason；`UserPromptSubmit` 发生在真正执行前、`Stop` 仍可要求继续，不能证明 Turn 已开始或结束；CDP 代理无法把多条底层命令可靠还原为一次高层自动化动作或 initiating actor；当前也没有通用 Human Review 对象及结构化 decision/reason。Runtime stop、Terminal open/close、Tool failed 和逐 Case started/completed 也已从 variants 中移除或改成可证明的事实。`agent.response.observed` 只接受主 Agent 原始 Stop，不把 SubagentStop 或宽泛文本 fallback 当作用户回复。`verification.*` 是唯一依赖新增明确流程的 P0 行；若不实施独占 producer 权限的身份化 runner、case manifest 与 target handshake，就必须从 registry 删除，不能拿 Playwright 标题、Agent 传入 verdict 或 Agent Team 自报结果代替。

重试、连接中断、恢复、文件浏览/修改与 Git 查看/撤销不单独进入行为事实；必要的大型产物作为对应 Query、Response、Command、Tool 或 Verification 事件的 evidence ref。Hub 发现的 sequence gap 是 Sources 状态；只有 producer 明知自己丢弃的区间才产生 `source.events_dropped`。

### P0 Payload 结构

公共 envelope 已有的 ID 不在 payload 重复。Command、Tool、Navigation、Verification 和 Worker dispatch 的稳定实例 ID 统一写 `scope.operationId`；Agent Team 使用 `scope.runId`；Browser 使用 `scope.browserGroupId/tabId`。

```ts
type EmptyPayload = Record<string, never>;
type CodexPermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "dontAsk"
  | "bypassPermissions";

interface SanitizedJsonSummary {
  sha256: string;
  byteLength: number;
  redactionCount: number;
  truncated: boolean;
}

type SanitizedBrowserUrl =
  | {
      kind: "http";
      policy: "origin_only" | "origin_and_path";
      origin: string;
      path?: string;
    }
  | { kind: "about_blank"; policy: "about_blank" };

interface VerificationCaseIdentity {
  caseId: string;
  manifestSha256: string;
}

interface VerificationTargetIdentity {
  kind: "web" | "desktop" | "app" | "backend" | "cli";
  targetInstanceId: string;
  handshakeSha256: string;
  runtimeChannel: "stable" | "beta" | "dev" | "external";
  surface: "desktop" | "web" | "app" | "backend" | "cli";
  origin?: string;
  routes?: string[];
  appVersion?: string;
  sourceRevision?: string;
  backendProfileId?: string;
  runtimeReleaseId?: string;
}

interface AgentTeamStateSnapshot {
  phase: "intake" | "proposal" | "executing";
  status: "clarifying" | "running" | "need_human" | "done" | "failed";
  round: number;
}

interface AgentTeamCaseSource {
  origin: "test_case_file" | "plan_file_generated" | "task_generated";
  sourceCaseId: string;
  sourceFileProjectRelative: string | null;
  caseDefinitionSha256: string;
}

type P0PayloadRegistry = {
  "producer.instance.started": {
    pid?: number;
    releaseId?: string;
  };

  "terminal.session.created": {
    cwd: string;
    runtimeKind: "pty" | "tmux";
    status: "running";
  };
  "terminal.session.deleted": {
    lastKnownCwd: string;
    runtimeKind: "pty" | "tmux";
    previousStatus: "running" | "exited";
    exitCode?: number;
    reasonCode: "session_delete_api" | "project_deleted" | "create_rollback";
  };
  "terminal.command.started": {
    cwd: string;
    shell: "zsh";
  };
  "terminal.command.completed": {
    cwdAfter: string;
    exitCode: number;
  };

  "user.query.submit_requested": {
    model: string;
    permissionMode: CodexPermissionMode;
  };
  "agent.thread.started": {
    sessionStartSource: "startup";
    model: string;
    permissionMode: CodexPermissionMode;
  };
  "agent.thread.resumed": {
    sessionStartSource: "resume";
    model: string;
    permissionMode: CodexPermissionMode;
  };
  "agent.response.observed": {
    model: string;
    permissionMode: CodexPermissionMode;
    stopHookActive: boolean;
  };
  "agent.tool.requested": {
    model: string;
    permissionMode: CodexPermissionMode;
    toolName: string;
    input: SanitizedJsonSummary;
  };
  "agent.tool.completed": {
    model: string;
    permissionMode: CodexPermissionMode;
    toolName: string;
    input: SanitizedJsonSummary;
    response: SanitizedJsonSummary;
  };

  "browser.tab.created": {
    reason: "initial" | "user_new" | "page_open" | "cdp_create" | "restore";
    url?: SanitizedBrowserUrl;
    openerTabId?: string;
  };
  "browser.tab.activated": {
    reason:
      | "user_select"
      | "created"
      | "page_open"
      | "cdp_activate"
      | "restore";
    previousTabId: string | null;
    url?: SanitizedBrowserUrl;
  };
  "browser.tab.closed": {
    reason:
      | "user_close"
      | "page_close"
      | "cdp_close"
      | "window_close"
      | "runtime_shutdown";
    url?: SanitizedBrowserUrl;
  };
  "browser.navigation.started": {
    from: SanitizedBrowserUrl | null;
    to: SanitizedBrowserUrl;
    sameDocument: boolean;
    initiator: "ui" | "cdp" | "page" | "restore" | "unknown";
  };
  "browser.navigation.completed": {
    from: SanitizedBrowserUrl | null;
    to: SanitizedBrowserUrl;
    sameDocument: boolean;
    durationMs: number;
    httpResponseCode?: number;
  };
  "browser.navigation.failed": {
    from: SanitizedBrowserUrl | null;
    to: SanitizedBrowserUrl;
    durationMs: number;
    errorCode: number;
    errorName: string;
  };
  "browser.navigation.cancelled": {
    from: SanitizedBrowserUrl | null;
    to: SanitizedBrowserUrl;
    durationMs: number;
    reason: "explicit_stop" | "superseded";
  };

  "verification.started": {
    case: VerificationCaseIdentity;
    target: VerificationTargetIdentity;
    attempt: number;
  };
  "verification.completed": {
    case: VerificationCaseIdentity;
    target: VerificationTargetIdentity;
    attempt: number;
    verdict: "passed" | "failed" | "skipped" | "cancelled" | "runner_error";
    durationMs: number;
    failureCode?: string;
    evidenceCount: number;
  };

  "agent_team.run.created": {
    state: AgentTeamStateSnapshot;
    reasonCode: "run_requested";
    acceptanceSource?:
      | "test_case_file"
      | "plan_file_generated"
      | "task_generated";
  };
  "agent_team.run.state_changed": {
    from: AgentTeamStateSnapshot;
    to: AgentTeamStateSnapshot;
    reasonCode: string; // Registry 闭集 enum，不接受日志文本
  };
  "agent_team.run.completed": {
    phase: AgentTeamStateSnapshot["phase"];
    round: number;
    terminalStatus: "done" | "failed";
    reasonCode:
      | "all_cases_passed"
      | "human_completed"
      | "test_case_prompt_failed";
  };
  "agent_team.worker.dispatched": {
    workerId: string;
    role: "code" | "code_review" | "behavior_verify";
    attempt: number;
    dispatchKind: "initial" | "serial" | "bounce" | "recheck" | "timeout_retry";
    caseIds: string[];
  };
  "agent_team.worker.result_recorded": {
    workerId: string;
    role: "code" | "code_review" | "behavior_verify";
    reportedStatus: "completed" | "failed";
    reportedFinishedAt: string;
    outboxSha256: string;
    resultCount: number;
  };
  "agent_team.case.dispatched": {
    caseId: string;
    source: AgentTeamCaseSource;
    workerId: string;
    workerRole: "code" | "code_review" | "behavior_verify";
    attempt: number;
    dispatchKind: "initial" | "serial" | "bounce" | "recheck" | "timeout_retry";
  };
  "agent_team.case.result_recorded": {
    caseId: string;
    source: AgentTeamCaseSource;
    workerId: string;
    workerRole: "code" | "code_review" | "behavior_verify";
    attempt: number;
    reportedResult: "pass" | "fail" | "skipped";
    reportedFinishedAt: string;
    evidenceCount: number;
    outboxSha256: string;
  };

  "source.events_dropped": {
    affectedProducerName: string;
    affectedInstanceId: string;
    affectedBootId: string;
    firstSequence: number;
    lastSequence: number;
    droppedCount: number;
    firstDroppedAt: string;
    lastDroppedAt: string;
    reasonCode: "sampled_by_policy" | "spool_quota_exceeded";
    priorityClass: "sampled" | "normal";
  };
};
```

`SanitizedBrowserUrl` 永不保存 userinfo、query 或 fragment；`origin` 保留必要端口，`path` 只有 Project policy 允许时才出现。Tool 的 input/response 先做 canonical JSON 与确定性脱敏，再计算 summary；不让模型生成 summary。Verification runner identity 使用 envelope 的 `producer.name/version`，不在 payload 重复。

### P0 字段来源

下表只列每个事件额外要求的 scope、result、payload 和 ref；公共 envelope 来源见“公共字段来源”。“需新增”表示代码中存在明确业务边界，但 Activity SDK/字段转发尚未实现，不表示当前已经入库。

#### Source 与 Terminal

| 事件                         | 字段                                                       | 必填  | 原始来源                                                         | 当前状态                                            |
| ---------------------------- | ---------------------------------------------------------- | ----- | ---------------------------------------------------------------- | --------------------------------------------------- |
| `producer.instance.started`  | `payload.pid`                                              | 否    | 进程型 Producer 的 `process.pid`                                 | Backend/App Server 已有原值；需接入 SDK             |
| 同上                         | `payload.releaseId`                                        | 否    | `RUNWEAVE_RUNTIME_RELEASE_ID` 或 App Server release config       | 已有原值；需接入 SDK                                |
| 同上                         | `actor.type`                                               | 是    | Registry 固定为 `system`                                         | 需新增                                              |
| `terminal.session.created`   | `scope.projectId/terminalSessionId`                        | 是    | runtime ensure 成功后的 `createdSession.projectId/id`            | `backend/src/routes/terminal.ts` 已有               |
| 同上                         | `occurredAt`                                               | 是    | `createdSession.createdAt`，不是 EventService 记录时刻           | 已有原值；需改 emitter                              |
| 同上                         | `payload.cwd`                                              | 是    | `createdSession.cwd`                                             | 已有                                                |
| 同上                         | `payload.runtimeKind`                                      | 是    | tmux ensure/fallback 后的 `createdSession.runtimeKind`           | 已有                                                |
| 同上                         | `payload.status`                                           | 是    | `createdSession.status`，schema 只接受 `running`                 | 已有                                                |
| 同上                         | `result.status`                                            | 是    | session 与 runtime 创建成功后固定 `succeeded`                    | 已有可靠边界                                        |
| 同上                         | `actor.type`                                               | 是    | 当前调用方无可信 actor，写 `unknown`                             | 需新增显式值                                        |
| `terminal.session.deleted`   | `scope.projectId/terminalSessionId`                        | 是    | 删除前 Session snapshot                                          | 单 Session 路径已有；Project cascade 需下沉 emitter |
| 同上                         | `payload.lastKnownCwd/runtimeKind/previousStatus/exitCode` | 是/否 | 删除前 Session record                                            | 已有原值                                            |
| 同上                         | `payload.reasonCode`                                       | 是    | 调用统一 delete application service 的路径常量                   | 需新增 reason 参数，禁止从日志猜                    |
| 同上                         | `occurredAt/result.status`                                 | 是    | `destroySession()` 真正成功后当前时间 / `succeeded`              | 已有可靠边界；需接 SDK                              |
| `terminal.command.started`   | `scope.operationId`                                        | 是    | zsh preexec adapter 生成的稳定 command ID                        | 需升级 marker                                       |
| 同上                         | `scope.cwd` / `payload.cwd`                                | 是    | preexec 时 `$PWD`；scope 为通用索引，payload 为事件快照          | 需升级 marker                                       |
| 同上                         | `payload.shell`                                            | 是    | adapter manifest 常量 `zsh`                                      | 需新增                                              |
| 同上                         | `contentRefs[role=command]`                                | 是    | zsh preexec 的完整 `$1` 经 DLP 加密写入 `activity_contents`      | 当前会截成 basename；需升级                         |
| 同上                         | `actor.type`                                               | 是    | 上游未显式传播 actor 时固定 `unknown`                            | 不得按命令文本/时间猜                               |
| `terminal.command.completed` | `scope.operationId`                                        | 是    | 与 started 相同的 command ID                                     | 需升级 marker                                       |
| 同上                         | `payload.cwdAfter`                                         | 是    | zsh precmd 时 `$PWD`                                             | 需升级 marker                                       |
| 同上                         | `payload.exitCode`                                         | 是    | precmd 第一条语句保存 `$?`                                       | 当前未保存；需升级                                  |
| 同上                         | `result.status/code`                                       | 是    | `exitCode === 0` 映射 succeeded，否则 failed；code 为 `exit:<n>` | Registry 确定性映射                                 |
| 同上                         | `durationMs`                                               | 查询  | 同 operationId 的 started/completed `occurredAt` 差值            | SQLite 查询时计算，不写 Fact row                    |

首期 Command coverage 只包含受控 interactive zsh。当前 Bash DEBUG trap 的 `BASH_COMMAND` 是 simple command/子命令，无法可靠代表一整条用户命令；fish 当前没有 adapter。相关现状在 `backend/src/terminal/shell-integration.ts` 的 zsh preexec/precmd 与 bash DEBUG trap 实现中可直接看到。

#### Agent Hook

| 事件                           | 字段                                              | 必填 | 原始来源                                                              | 当前状态                                  |
| ------------------------------ | ------------------------------------------------- | ---- | --------------------------------------------------------------------- | ----------------------------------------- |
| `user.query.submit_requested`  | `scope.threadId`                                  | 是   | `UserPromptSubmit.session_id`                                         | Hook 原始字段已有，bridge 需转发          |
| 同上                           | `scope.turnId`                                    | 是   | `UserPromptSubmit.turn_id`                                            | 当前 parser 丢弃；需转发                  |
| 同上                           | `scope.interactionId/correlationId`               | 是   | Activity client 首次观察 `(threadId, turnId)` 时生成并 durable 映射   | 需新增；不能按文本去重                    |
| 同上                           | `payload.model`                                   | 是   | `UserPromptSubmit.model`                                              | 需转发                                    |
| 同上                           | `payload.permissionMode`                          | 是   | `UserPromptSubmit.permission_mode`                                    | 需转发                                    |
| 同上                           | `contentRefs[role=query]`                         | 是   | `UserPromptSubmit.prompt` 脱敏后加密写入 `activity_contents`          | 需新增 Activity client                    |
| 同上                           | 事件语义                                          | 是   | Hook 表示“即将发送且仍可能被 block”                                   | 只能叫 submit_requested，不得叫 submitted |
| `agent.thread.started/resumed` | Event variant                                     | 是   | `SessionStart.source`：startup→started，resume→resumed                | clear/compact 不发这两个事件              |
| 同上                           | `scope.threadId`                                  | 是   | `SessionStart.session_id`                                             | bridge 已能读 session，需保留原始 source  |
| 同上                           | `payload.sessionStartSource/model/permissionMode` | 是   | `SessionStart.source/model/permission_mode`                           | 当前 bridge 丢字段；需转发                |
| `agent.response.observed`      | `scope.threadId/turnId`                           | 是   | 原始主 Agent `Stop.session_id/turn_id`                                | 必须在归一化前排除 SubagentStop           |
| 同上                           | `scope.interactionId`                             | 否   | `(threadId, turnId)` 的 durable 精确映射                              | 映射缺失则 unlinked，不按时间补           |
| 同上                           | `payload.model/permissionMode/stopHookActive`     | 是   | `Stop.model/permission_mode/stop_hook_active`                         | 需转发；stopHookActive 不推断终态         |
| 同上                           | `contentRefs[role=response]`                      | 是   | 非空 `Stop.last_assistant_message` 脱敏后加密写入 `activity_contents` | 为空不发事件；禁止 transcript/fallback 猜 |
| `agent.tool.requested`         | `scope.operationId/turnId`                        | 是   | `PreToolUse.tool_use_id/turn_id`                                      | 当前未注册 PreToolUse；需新增             |
| 同上                           | `payload.model/permissionMode/toolName`           | 是   | `PreToolUse.model/permission_mode/tool_name`                          | 需转发                                    |
| 同上                           | `payload.input` 与 `contentRefs[tool_args]`       | 是   | `tool_input` 经 canonical JSON、确定性 DLP、hash/size/truncation      | 需新增；不由模型摘要                      |
| `agent.tool.completed`         | `scope.operationId/turnId`                        | 是   | `PostToolUse.tool_use_id/turn_id`                                     | Hook 已注册，bridge 需补字段              |
| 同上                           | `payload.model/permissionMode/toolName`           | 是   | `PostToolUse` 同名字段                                                | 需转发                                    |
| 同上                           | `payload.input/response` 与对应 Content refs      | 是   | `tool_input/tool_response` 经相同确定性处理                           | 需新增                                    |
| 同上                           | `result`                                          | 不写 | PostToolUse 对 Bash 非零退出也会触发                                  | 不得自动标 succeeded/failed               |

Agent Hook 字段以当前官方 [Codex Hooks 文档](https://developers.openai.com/codex/hooks)为准。`transcript_path` 格式不稳定，不作为结构化来源或长期 External Ref。当前字段丢失点集中在 `plugins/toolkit/hooks/runweave-hook-payload.cjs` 的 `buildAppServerBaseEvent`；外部 TTY 采集不能复用现有 `RUNWEAVE_TERMINAL_SESSION_ID` gate。

#### Terminal Browser 与 Verification

| 事件                           | 字段                                                                         | 必填 | 原始来源                                                                  | 当前状态                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `browser.tab.*`                | `scope.browserGroupId/tabId`                                                 | 是   | Electron `TerminalBrowserEntry.browserGroupId` 与调用方 tab ID            | 已有原值；需接 Activity emitter                                                        |
| `browser.tab.created`          | `payload.reason`                                                             | 是   | get/create 调用方显式常量                                                 | 当前函数无 reason 参数；需新增，禁止按 tab 前缀猜                                      |
| 同上                           | `payload.url`                                                                | 否   | 创建时已有的初始/已提交 URL，经 `SanitizedBrowserUrl` policy              | 空白 Tab 不写                                                                          |
| 同上                           | `payload.openerTabId`                                                        | 否   | page-open 调用的 opener tab                                               | page-open 路径已有                                                                     |
| `browser.tab.activated`        | `payload.reason`                                                             | 是   | attach 调用方显式常量                                                     | 当前需新增参数                                                                         |
| 同上                           | `payload.previousTabId`                                                      | 是   | `attachedByWindowId` 切换前值                                             | 已有原值                                                                               |
| 同上                           | `payload.url`                                                                | 否   | 当前 committed URL 经 URL policy                                          | 需新增独立 committed URL 字段                                                          |
| `browser.tab.closed`           | `payload.reason`                                                             | 是   | close 调用方显式常量                                                      | 当前需新增参数                                                                         |
| 同上                           | `payload.url`                                                                | 否   | 删除 entry 前最后 committed URL                                           | 需在删除前快照                                                                         |
| `browser.navigation.started`   | `scope.operationId`                                                          | 是   | Electron producer 在 main-frame `did-start-navigation` 生成 navigation ID | 当前 Electron event 无 ID；需新增 active operation                                     |
| 同上                           | `payload.from`                                                               | 是   | Tab 的 `lastCommittedUrl` 经 URL policy                                   | 当前只有会被提前覆盖的 lastKnownUrl；需新增                                            |
| 同上                           | `payload.to/sameDocument`                                                    | 是   | main-frame `did-start-navigation.url/isSameDocument`                      | 需新增监听                                                                             |
| 同上                           | `payload.initiator`                                                          | 是   | UI/CDP/page/restore handler 显式 marker；无法确定写 unknown               | 不解析 JS/CDP payload 猜                                                               |
| `browser.navigation.completed` | `payload.from/to/sameDocument`                                               | 是   | started operation 与最终 committed URL                                    | 需 operation 状态                                                                      |
| 同上                           | `payload.durationMs`                                                         | 是   | Electron producer 同一 operation 的 monotonic clock                       | 需新增；属于 producer field                                                            |
| 同上                           | `payload.httpResponseCode`                                                   | 否   | main-frame `did-navigate` HTTP response code                              | 非 HTTP 不写                                                                           |
| 同上                           | `result.status`                                                              | 是   | 正常 `did-finish-load` 或 same-document commit 固定 succeeded             | 需新增监听                                                                             |
| `browser.navigation.failed`    | `payload.from/to`                                                            | 是   | active operation 的起止 URL                                               | 需新增                                                                                 |
| 同上                           | `payload.durationMs/errorCode/errorName`                                     | 是   | monotonic clock 与 main-frame `did-fail-load`                             | errorName 限长；不存任意错误正文                                                       |
| 同上                           | `result.status/code`                                                         | 是   | 固定 failed / Electron errorName                                          | 需新增                                                                                 |
| `browser.navigation.cancelled` | `payload.from/to/durationMs`                                                 | 是   | active operation 与 monotonic clock                                       | 需新增                                                                                 |
| 同上                           | `payload.reason`                                                             | 是   | 显式 Stop handler 或新 navigation 取代 active ID                          | 单凭 ERR_ABORTED 不产生 cancelled                                                      |
| 同上                           | `result.status`                                                              | 是   | 固定 cancelled                                                            | 需新增                                                                                 |
| `verification.*`               | `producer.name/version`                                                      | 是   | 独占 verification capability 的 runner manifest                           | 纯新增 runner；Agent/worker 无写权限                                                   |
| `verification.*`               | `scope.operationId`                                                          | 是   | runner 为每次 attempt 生成 verification ID                                | 需新增                                                                                 |
| 同上                           | `payload.case.caseId`                                                        | 是   | runner 读取的测试 manifest 固定 ID                                        | 不使用 Playwright 标题                                                                 |
| 同上                           | `payload.case.manifestSha256`                                                | 是   | runner 对 canonical case manifest 计算 SHA-256                            | 需新增                                                                                 |
| 同上                           | `payload.target.targetInstanceId/handshakeSha256`                            | 是   | 目标运行时 handshake 响应及其 canonical hash                              | 需新增，禁止读页面 badge 猜                                                            |
| 同上                           | `payload.target.kind/runtimeChannel/surface`                                 | 是   | handshake 的结构化 target identity                                        | 需新增                                                                                 |
| 同上                           | `payload.target.origin/routes`                                               | 条件 | handshake origin + runner 实际观察到的 routes                             | Case 可跨多个 route，不压成单一路由                                                    |
| 同上                           | `payload.target.appVersion/sourceRevision/backendProfileId/runtimeReleaseId` | 否   | handshake 明确暴露的非敏感 manifest 字段                                  | 当前 `/health` 信息不足；需扩展                                                        |
| `verification.started`         | `payload.attempt`                                                            | 是   | runner 对同一 case/target 的正整数计数                                    | 需新增                                                                                 |
| `verification.completed`       | `payload.verdict`                                                            | 是   | 真实 runner/test process 结果                                             | Agent/worker 传入 pass/fail 无效                                                       |
| 同上                           | `payload.durationMs`                                                         | 是   | runner monotonic clock                                                    | 需新增                                                                                 |
| 同上                           | `payload.failureCode`                                                        | 条件 | runner allowlist failure enum                                             | failed/runner_error 时必填                                                             |
| 同上                           | `payload.evidenceCount/externalRefs[evidence]`                               | 是   | runner 已落盘 report/screenshot/trace 的数量与 digest ref                 | passed/failed 至少一个 evidence ref                                                    |
| 同上                           | `result.status/code`                                                         | 是   | verdict 的 Registry 映射                                                  | passed→succeeded；failed/runner_error→failed；cancelled→cancelled；skipped 不写 result |

现有 `frontend/playwright.config.ts` 没有 Activity reporter、稳定 case ID 或 target handshake，因此 Verification 是明确的新增流程。Agent Team `acceptanceResults` 永远属于 reported result，不能复用 verification namespace。

#### Agent Team 与 Collector

| 事件                                | 字段                                               | 必填  | 原始来源                                                                        | 当前状态                                           |
| ----------------------------------- | -------------------------------------------------- | ----- | ------------------------------------------------------------------------------- | -------------------------------------------------- |
| `agent_team.run.*`                  | `scope.runId/projectId/terminalSessionId`          | 是    | `AgentTeamRun` 同名字段                                                         | 已有                                               |
| `agent_team.run.created`            | `payload.state`                                    | 是    | 基础 Run 首次 durable write 后的 phase/status/loop.round                        | 首次写入边界已有；需 emitter                       |
| 同上                                | `payload.reasonCode`                               | 是    | Registry 固定 `run_requested`                                                   | 需新增                                             |
| 同上                                | `payload.acceptanceSource`                         | 否    | 创建时已经解析出的 `AgentTeamVerificationConfig.acceptanceSource`               | 尚未解析时为空，不猜                               |
| `agent_team.run.state_changed`      | `payload.from/to`                                  | 是    | `updateRun` 写入前后的 phase/status/round 快照                                  | 已有原值；需统一 transition helper                 |
| 同上                                | `payload.reasonCode`                               | 是    | 每个状态迁移调用方传闭集 enum                                                   | 禁止从 `logs[]/loop.lastReason` 文本提取           |
| `agent_team.run.completed`          | `payload.phase/round/terminalStatus`               | 是    | Run 首次 durable 写入 done/failed 后的状态                                      | 自动通过/人工完成边界已有                          |
| 同上                                | `payload.reasonCode`                               | 是    | transition 分支常量                                                             | 进程退出/超时不补猜 completed                      |
| 同上                                | `result.status`                                    | 是    | done→succeeded，failed→failed                                                   | Registry 映射                                      |
| `agent_team.worker.dispatched`      | `scope.operationId`                                | 是    | 新增稳定 dispatch ID，并写入 active dispatch、prompt 与 outbox                  | 当前只有 requestedAt/mtime；需扩展结构             |
| 同上                                | `scope.panelId/tmuxPaneId`                         | 是/否 | 成功接收 prompt 的 Worker panel/pane                                            | 已有原值；tmux 缺失写空                            |
| 同上                                | `payload.workerId/role`                            | 是    | `AgentTeamWorker.id/role`                                                       | 已有                                               |
| 同上                                | `payload.attempt/dispatchKind`                     | 是    | dispatch orchestration 分支与 attempt counter                                   | 需统一生成                                         |
| 同上                                | `payload.caseIds`                                  | 是    | 本次成功投递 prompt 中实际列出的 Case ID；可为空                                | 不从整个 run acceptance 扩张                       |
| 同上                                | `occurredAt`                                       | 是    | `sendPromptToPane` 成功返回时刻                                                 | 不表示 worker 已开始执行                           |
| `agent_team.worker.result_recorded` | `scope.operationId`                                | 是    | 通过 identity/freshness 校验的 outbox `dispatchId`                              | outbox schema 需新增 dispatchId                    |
| 同上                                | `payload.workerId/role`                            | 是    | active worker 与已验证 outbox identity                                          | 已有原值                                           |
| 同上                                | `payload.reportedStatus/reportedFinishedAt`        | 是    | 原始 outbox 显式 `status/finishedAt`                                            | normalizer fallback 禁止生成 Activity 事件         |
| 同上                                | `payload.outboxSha256`                             | 是    | 原始 outbox canonical bytes SHA-256                                             | 需新增                                             |
| 同上                                | `payload.resultCount`                              | 是    | 原始 `acceptanceResults.length`                                                 | 已有原值                                           |
| 同上                                | `externalRefs[role=outbox]`                        | 是    | 通过 freshness/identity 校验的 pane-scoped outbox 版本化 ref                    | 需 resolver 注册                                   |
| 同上                                | `result`                                           | 不写  | reportedStatus 只是 Worker 自报                                                 | 不冒充系统成功/Verification                        |
| `agent_team.case.dispatched`        | `scope.operationId`                                | 是    | 所属 worker dispatch ID                                                         | 需新增                                             |
| 同上                                | `payload.caseId`                                   | 是    | 本次成功投递 prompt 实际包含的 Case                                             | 已有 Case ID；需 prompt builder 返回列表           |
| 同上                                | `payload.source.*`                                 | 是    | loader 的 source kind/case ID/project-relative path；加载时计算 definition hash | 当前缺 digest；需新增                              |
| 同上                                | `payload.workerId/workerRole/attempt/dispatchKind` | 是    | 所属 worker dispatch 的结构化字段                                               | 已有部分；需统一 dispatch record                   |
| `agent_team.case.result_recorded`   | `payload.caseId/reportedResult`                    | 是    | 已验证原始 outbox `acceptanceResults[]`                                         | synthesized review/watchdog 结果禁止写             |
| 同上                                | `payload.source/workerId/workerRole/attempt`       | 是    | Run Case 与对应 dispatch record                                                 | caseId 必须存在于该 dispatch.caseIds               |
| 同上                                | `payload.reportedFinishedAt/outboxSha256`          | 是    | 已验证原始 outbox                                                               | 需新增 hash/dispatchId                             |
| 同上                                | `payload.evidenceCount/externalRefs[evidence]`     | 是    | acceptance result evidence 数量及 resolver 注册结果                             | 任意 ref 字符串不自动成为可信证据                  |
| 同上                                | `result`                                           | 不写  | pass/fail/skipped 始终是 Agent 自报                                             | UI 必须显示 reported                               |
| `source.events_dropped`             | `payload.affectedProducerName/InstanceId/BootId`   | 是    | compact loss ledger 中被丢弃事件所属 producer epoch                             | reporter 可能已重启，不能用当前 envelope boot 代替 |
| 同上                                | `payload.firstSequence/lastSequence/droppedCount`  | 是    | 连续且 reason/priority 相同的 loss ledger 区间                                  | Hub 校验 count = last-first+1                      |
| 同上                                | `payload.firstDroppedAt/lastDroppedAt`             | 是    | loss ledger 的首尾 drop 时间                                                    | 需新增                                             |
| 同上                                | `payload.reasonCode/priorityClass`                 | 是    | 实际执行 sampling/quota drop 的分支常量                                         | 仅 sampled/normal；critical 禁止主动丢弃           |
| 同上                                | 事件资格                                           | 是    | loss ledger 先 durable，再用稳定 eventId 重放                                   | Hub 单方面发现 gap、磁盘写失败或进程突退不能生成   |

Agent Team 的 worker/case 事件都表达“成功投递”或“已记录自报结果”，不表达真实开始执行，也不升级成独立 Verification。`source.events_dropped` 本身使用新的 producer sequence；被丢弃区间仍保持为空，不生成伪事件填洞。

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

这些数据不进入需求承诺。外部 TTY 可靠覆盖分两级：Agent Query request/Reply 通过全局 Agent Hook；任意 shell command 首期只承诺受控 interactive zsh integration。Bash DEBUG trap 只能观察 simple command，fish 当前没有 adapter；二者只有在独立 adapter 通过同一组配对/exit 验收后才能加入 coverage。

## 关联模型

### Query 主线

```text
user.query.submit_requested
  interactionId = producer 生成
  correlationId = interactionId
      ├─ agent.response.observed
      ├─ agent.tool.requested/completed
      ├─ terminal.command.started/completed
      ├─ browser.navigation
      ├─ verification facts
      └─ Agent Team facts（若显式携带 interactionId）
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
  activity.sqlite        # 唯一 canonical behavior database
  activity.sqlite-wal    # SQLite 运行时文件，不作为独立事实源
  activity.sqlite-shm
  spool/                 # 每个 Producer 一个临时 SQLite spool
    <producer-instance>.sqlite
  backups/               # SQLite online backup 产物，按用户策略轮转
  learning.sqlite        # 第二阶段派生资产，与 behavior tables 分库
```

### 物理策略

- `activity.sqlite` 是唯一事实源；不存在 Fact JSONL、segment、manifest 或第二份事实文件。
- 新数据库在建表前设置 `auto_vacuum=INCREMENTAL`；每次打开固定执行 `PRAGMA journal_mode=WAL`、`synchronous=FULL`、`foreign_keys=ON`、`busy_timeout`，并校验 schema migration version。
- Hub 是唯一写入者，按 batch 使用 `BEGIN IMMEDIATE`：验证/脱敏后，在同一事务内完成 eventId/sequence 去重、Fact、Content ciphertext、Ref/link、producer cursor 与 gap 更新；`COMMIT` 成功后才 ACK。
- Facts 不提供 update API；只有 retention/delete capability 可以在审计事务中删除行。字段修正通过新事件或 schema upcaster 查询，不覆盖历史 row。
- Query/回复/命令/tool excerpt 以 AES-256-GCM ciphertext BLOB 存 `activity_contents`；nonce/auth tag 同行保存，key 仍在 macOS Keychain。WAL 中只出现 ciphertext，不写明文正文。
- 大型 Thread、scrollback、run/outbox、report、截图和 trace 不写 BLOB，只在 `external_refs` 保存加密 locator 与版本/哈希。
- 定期执行 passive checkpoint；达到 WAL 阈值时做受控 truncate checkpoint。备份使用 SQLite online backup API，恢复后执行 `integrity_check` 与 `foreign_key_check`。
- Retention 用有界 SQL batch 删除/清空 7 天 ciphertext 和 30 天 Fact row，再执行 incremental vacuum；不能为清理重写整个数据库。
- Producer spool 同样使用小型 SQLite，保存稳定 eventId/sequence 与 batch bytes；收到最高连续 ACK 前不删除，retry 不重新生成 ID。
- 当前本机 Node `v22.22.2` 的 `node:sqlite` 仍有 ExperimentalWarning。实现必须把 driver 封装在 Activity Hub storage adapter 并固定运行时；无论选择哪一驱动，底层格式和验收对象都必须是 SQLite。

### 默认留存

| 数据                                                |                 默认 | 清理语义                                                                   |
| --------------------------------------------------- | -------------------: | -------------------------------------------------------------------------- |
| Query/回复/命令正文、excerpt ciphertext、quarantine |                 7 天 | 清空/删除 SQLite ciphertext，Fact link 保留 digest、size 与 `expired` 状态 |
| 规范化 Fact、关系、Refs、Sources gap 与索引         |                30 天 | 有界删除 SQLite rows，更新 retention watermark                             |
| 未审核 Context Pack、Learning run、Candidate        |                30 天 | 到期删除；发布前提示证据即将过期                                           |
| Published LearningVersion                           | 用户删除或 supersede | 只保留最小脱敏 Support Capsule，不保留完整行为原文                         |

默认本机 quota 建议 5 GB；接近 quota 时先删除已过期内容，再按策略采样 `priority=sampled`，不能先丢 query/response/result。Producer 明确执行的任何丢弃都必须先持久化 compact loss ledger，并在可写时产生 `source.events_dropped`；Hub 另行保留检测到的 gap range，不猜 gap 原因。

规模目标不是事实陈述，而是实施验收预算：

- 典型 10,000–100,000 semantic events/day。
- 30 天最多约 3,000,000 facts。
- producer enqueue p95 < 5 ms，不能阻塞业务动作。
- Hub 持续 200 events/s，10 秒 burst 2,000 events/s。
- SQLite batch commit p95 < 50 ms；最近 10,000 条 timeline 索引查询 p95 < 500 ms。

## 可靠性与故障语义

- 交付语义：at-least-once + eventId 去重；不承诺 exactly-once 网络传输。
- Producer 身份：`instanceId + bootId + sequence`；Hub 分配 `hubOffset`。
- Hub 下线：SDK 写 disk spool，业务继续；恢复后按 sequence replay。
- sequence gap：持久化 gap interval；迟到事件补齐后关闭 gap，不改已有 hubOffset。
- schema 错误：进入 quarantine，producer 收到 reject，Sources 显示 invalid count。
- SQLite transaction 失败：整体 rollback、不 ACK；Producer 以相同 eventId/sequence 重放，不能出现 Fact 有而 Content/link 没有的半事务。
- WAL/进程崩溃：启动时由 SQLite recovery 恢复已 commit 事务；`integrity_check/foreign_key_check` 失败则 fail closed，并从 online backup 恢复，不能跳过损坏 row。
- Secondary index 失效：Fact rows 仍是 canonical；进入 degraded read 状态并在同一数据库重建索引，不切换到另一份数据源。
- Content ciphertext 已过期或 external object missing：Fact 仍可读，内容明确显示 expired/missing，不伪造空字符串。
- Backpressure：429 + retry-after；critical 不丢，normal spool，sampled 可采样并报告 loss。
- Activity Hub 自身 rolling log 不回灌 Activity Hub，避免递归。

## 隐私、权限与删除

- Producer 先按 schema redaction；Hub 再做 token/header/cookie/password/private key/high-entropy secret 扫描。
- `.env`、Authorization、Cookie、完整 HTTP headers、系统环境变量、证书和 Keychain 内容禁止入库。
- SQLite 中的 Content 与 locator 使用 AES-256-GCM field encryption；key 存 macOS Keychain；根目录 `0700`，database/WAL/SHM/backup 文件 `0600`。
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

Cursor 使用 opaque keyset `(occurredAt, hubOffset)`，不能用 offset pagination。所有 query 返回 `coverage`：source watermarks、gap ranges、SQLite commit/checkpoint 状态、expired/missing ref counts。

### 第一阶段 UI

1. **Facts**：按真实字段过滤、排序、打开详情；Recorded 与 Computed 分区。
2. **Interaction Timeline**：以显式 correlation/interaction/thread/run 展开 actor、action、result 和 refs；高频 tool/output 默认折叠。
3. **Sources**：每个 producer 的 runtime/surface/version、last heartbeat、produced/acked、gap、reject、drop、commit latency 与 WAL 状态。
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
- 建立 14 个核心事件族及其 variants 的 producer allowlist、字段、privacy、priority、retention 与 payload 上限。
- 固定 runtime/surface 枚举、ID 传播规则、外部 TTY 覆盖承诺和容量预算。

验收：schema fixture、secret fixture、未知版本、payload 超限、runtime/surface 组合、ID 关系全部通过；没有 generic `payload: unknown` 入口。

### P1：Activity Hub、独立存储与 Sources

改动范围：

- 新增 `activity-hub/` workspace package：discovery/auth、batch ingest、SQLite canonical storage、encrypted Content BLOB、refs、retention、quarantine、backup、query/WS。
- 新增 `packages/shared/src/activity/discovery.ts` 与 capability contract。
- 新增 `packages/runweave-cli/src/commands/activity.ts`：install/start/stop/status/query/export/delete。
- 新增 producer SDK 与 per-producer disk spool。
- 在 Web/Desktop 增加 Sources/Data Policy 最小只读面板。

验收：Hub 下线/replay、重复、gap、schema reject、transaction rollback、WAL crash recovery、online backup/restore、index rebuild、7/30 天 purge、Stable/Beta 同库隔离字段、5 GB quota 策略。

### P2：核心 Producer 与真实 Facts/Timeline

改动范围：

- Backend：在 terminal application service、runtime recorder、Voice、Quick Input、verification 边界主动记录。
- Electron：在 producer bootstrap、Terminal Browser tab lifecycle 与 main-frame navigation 边界主动记录。
- Hook：新增独立 `activity-client.cjs`，转发 SessionStart source、UserPromptSubmit、主 Agent 原始 Stop 和 Pre/PostToolUse 的允许字段；SubagentStop 不进入用户回复事件。不复用通知所需的 Runweave Terminal gate，有 Thread 时允许 external Agent Query/Reply 写入。
- Shell：首期实现并显式启用 interactive zsh preexec/precmd integration；bash/fish 保持 coverage inactive，直到各自 adapter 通过命令配对、管道、多行、exit 与 Ctrl-C 验收。
- Agent Team：在 run state、worker dispatch/validated outbox、case dispatch/result fold 边界记录事件；完整 run/outbox/evidence 只保存 ref。
- Playwright/verification：新增独占 verification producer 权限的身份化 runner；校验 case manifest hash 与 target handshake，由 runner 根据真实执行结果写 verdict 和 evidence ref。
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
