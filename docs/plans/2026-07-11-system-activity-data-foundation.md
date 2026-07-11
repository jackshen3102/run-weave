# Runweave Backend 内嵌行为数据底座实施计划

> 状态：方案已按“**不新增服务、由现有 Backend 直接写 SQLite**”重新收敛，尚未实施
> 计划粒度：L3（跨 Backend、Electron、Web、CLI、Hook、Shell、Terminal Browser、Agent Team 与 SQLite 多进程并发）
> 代码基线：`docs/activity-data-foundation-contracts@74f1151`，2026-07-11
> 配套架构流程：`docs/architecture-flows/system-activity-data-foundation-flow/`
> 配套验收：`docs/testing/system-activity-data-foundation-test-cases.md`

## 一句话结论

**不创建 Activity Hub，不增加 daemon、端口、服务发现、独立 token 或生命周期命令。** 在每个现有 Backend 进程内增加 `ActivityRecorder + ActivityStore + ActivityQueryService`；Stable、Beta、Dev Backend 共同读写 OS 用户级的 `~/.runweave/activity/activity.sqlite`，页面和 CLI 都通过当前已连接的 Backend 读写。

“行为数据独立存储”只表示它有独立 SQLite 文件、schema、保留策略和权限边界，不表示它是独立服务。

```text
Backend 内部业务边界 ── in-process record() ───────────────┐
Managed Hook ── Hook Token ── 当前 Backend internal API ─────┤
Electron / External Hook / Shell / CLI ── Bearer Backend API ┤
                                                             ▼
                                      Backend ActivityRecorder
                                      validate · redact · batch
                                                             ▼
                            ~/.runweave/activity/activity.sqlite
                              WAL · multi-process · 7/30 days
                                                             ▲
                          Backend ActivityQueryService ────────┘
                                                             ▲
                                         Facts / Timeline / Sources / Data Policy UI
```

## 决策边界

### 必须做到

- 行为事实单独存入 `~/.runweave/activity/activity.sqlite`，不落入 App Server JSONL、Backend LowDB、项目 `.runweave`、Thread 文件或诊断日志。
- Stable、Beta、Dev 的多个 Backend 可以同时打开同一数据库；`runtime.channel` 仍保留真实来源。
- Backend 内部来源直接调用进程内 recorder；进程外来源只能调用现有 Backend，不直接打开 SQLite。
- 页面使用当前 Backend 的 `/api/activity/*` 查询；不从浏览器连接数据库。
- CLI 复用已有 `--profile`、`--backend-port`、`RUNWEAVE_BASE_URL` 和 Bearer Auth；不增加 Activity 服务发现。
- P0 只展示 Recorded facts、确定性 Computed 值和 coverage gap，不展示模型臆测的 Task、Goal、Outcome、Rework 或 Learning。
- Query/回复/命令/excerpt 默认保留 7 天；规范化事实、关系和来源状态默认保留 30 天。
- 第一阶段只完成事实采集、SQLite、查询和页面。未来 Learning 由模型基于受控 Context Pack 生成，并写入另一份 `learning.sqlite`。

### 明确不做

- 不新增 `activity-hub/` package、独立进程、后台服务、监听端口、lock/discovery 文件或 start/stop/status 命令。
- 不把 App Server 改造成行为仓，也不依赖 App Server 是否运行。
- 不允许 Web、App、Electron、CLI、Hook、Shell、Agent Team、Verification runner 或模型直接导入 SQLite driver、解析数据库路径或持有数据库句柄。
- 不让 CLI 以任意 JSON 伪造高可信 Verification、Agent Team 或 Agent Hook 事实；每个入口受 Registry allowlist 约束。
- 不承诺在没有 Hook、Shell Integration 或显式 CLI 调用时自动捕获任意外部 TTY 的命令。
- 不保存 mousemove、hover、每个按键、每个 terminal byte、每个模型 token、隐藏思维链或完整网络 body。
- 不扫描现有 Thread、scrollback、日志或 Agent Team snapshot 来补造历史事实；上线前历史不 backfill。
- 不在本计划中实现模型调用、自动 Learning、向量检索或经验自动发布。

## 第一性原理判断

### 独立数据不需要独立服务

本需求的最小原语只有三项：结构化写入、SQLite 持久化、查询 API。现有 Backend 已经具备进程生命周期、HTTP、鉴权、CLI target 和页面承载能力，因此再创建 Activity Hub 只会重复一套发现、认证、升级、故障恢复和 Stable/Beta 协调机制。

### 集中化由共享数据库实现

Runweave 当前允许多个 profile Backend 并存。P0 不选举单一 Backend owner；每个 Backend 各持一个 SQLite connection，全部指向同一绝对路径。SQLite WAL 允许多 reader，并将 writer 事务串行化。行为事件是语义级低频数据，不是逐字节日志，适合这个模型。

### CLI 是传输层，不是数据库实现

CLI 可以触发写入，但实际链路必须是 `rw → 当前 Backend → ActivityStore → SQLite`。如果 CLI 自己打开数据库，schema migration、加密、留存、权限和并发逻辑会出现第二份实现，Stable/Beta 版本错位也无法控制。

### “真实”包含诚实暴露拿不到的数据

只有业务边界主动记录的内容叫 Recorded。缺少 Hook、shell marker、operation ID 或 target handshake 时，不按文本或时间邻近猜测。UI 显示 `unlinked`、`unknown actor` 或 coverage gap，而不是给出虚假的完整率。

## 当前代码事实

| 现状                                                                         | 代码证据                                                                                                | 对本计划的影响                                                               |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Backend 在 `RuntimeServices` 中统一创建和释放服务                            | `backend/src/bootstrap/runtime-services.ts`                                                             | `ActivityRecorder/Store` 应加入同一生命周期                                  |
| Backend 已有 `/internal/*`、`/api/*`、Tunnel Auth、Bearer Auth 和 Hook Token | `backend/src/index.ts`、`backend/src/auth/middleware.ts`                                                | 复用现有端口和鉴权，不建新服务                                               |
| 每个 browser profile 只有一个 Backend，但不同 profile 可并行                 | `packages/shared/src/browser-profile-node.ts`、`backend/src/server/profile-lock.ts`                     | 数据库不能放在 profile 目录；必须放 OS 用户级固定目录                        |
| Beta 明确隔离 browser profile、CLI config 和 App Server home                 | `electron/src/desktop-config.ts`                                                                        | Activity DB 不能跟随 Beta/Stable home，否则无法集中                          |
| packaged Backend 由 Electron 随应用启动/停止                                 | `electron/src/backend-runtime.ts`、`electron/src/packaged-backend-controller.ts`                        | Activity 能力随既有 Backend 生命周期运行                                     |
| CLI 已通过 profile/baseUrl/accessToken 调 Backend                            | `packages/runweave-cli/src/config/profile-store.ts`、`packages/runweave-cli/src/client/auth-context.ts` | Activity CLI 只需新增 command/client，不需发现协议                           |
| Hook 只有携带 Terminal ID/Hook Token 时才会投递当前 Backend                  | `plugins/toolkit/hooks/runweave-hook-bridge.cjs`                                                        | 当前可靠覆盖 Runweave Terminal；外部 TTY 需显式配置 CLI/profile 或新 adapter |
| TerminalEventService 只在每个 Backend 内存保留最近 500 条                    | `backend/src/terminal/terminal-event-service.ts`                                                        | 可作为 emitter 接线点，不能作为持久事实源                                    |
| packaged Backend 使用 Electron 33 的 Node 20，不能导入 `node:sqlite`         | `electron/package.json`、`electron/src/backend-runtime.ts`                                              | 不能把 `node:sqlite` 当实现前提；需打包兼容 driver                           |
| packaged Backend 可监听 `0.0.0.0`                                            | `electron/src/backend-runtime.ts`                                                                       | OS 用户级行为 API P0 必须额外限制 local-direct                               |

### 当前能力不能直接作为行为仓

| 当前数据                             | 边界                                          | 处理方式                                         |
| ------------------------------------ | --------------------------------------------- | ------------------------------------------------ |
| App Server `app-server-events.jsonl` | Stable/Beta home 分离、事件少、7 天、单 JSONL | 保持原职责，不复用、不迁移                       |
| Backend LowDB                        | profile/业务状态                              | 只在行为发生时提供字段，不作为查询事实源         |
| TerminalEventService                 | 内存 500 条、重启丢失                         | 接线到 recorder 后继续服务实时 UI                |
| Codex Thread                         | 结构和可见正文受 Agent 能力限制               | 只保存显式 Hook 字段或短期 ExternalRef           |
| Agent Team run/outbox                | 当前快照，不是逐状态历史                      | 在 durable transition 边界发事实；大对象只存 ref |
| rolling/diagnostic logs              | 面向排障、格式不稳定                          | 仅复用脱敏规则，不解析成事实                     |

## 目标运行拓扑

### Backend 内部写入

```text
terminal / agent-team / backend route / state transition
    → typed event builder
    → ActivityRecorder.recordBatch()
    → SQLite worker queue
    → schema + DLP + encryption
    → one short transaction
    → ACK / duplicate / reject
```

- 业务动作成功与否不由行为记录决定；调用方必须捕获记录失败并写 diagnostic log，不能反向让 Terminal、Agent Team 或 Browser 操作失败。
- 需要向 CLI/adapter 返回结果的 HTTP 写入会等待 SQLite commit。
- Backend 正常退出最多等待 2 秒 drain 已接受的 queue；超时后记录 dropped count，不伪造已持久化。

### 进程外写入

| 来源                | 写入路径                                                        | 身份与限制                                                           |
| ------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------- |
| Electron            | Electron → 当前 Backend `/api/activity/electron-events/batch`   | 复用 Backend Bearer；route 注入 Electron identity 与事件 allowlist   |
| Managed Hook        | hook bridge → `/internal/activity/hook-events/batch`            | 复用 `RUNWEAVE_HOOK_TOKEN`、Terminal/Thread context；不走 App Server |
| External Agent Hook | 显式配置的 hook → `rw activity record agent-hook` → Backend API | 复用所选 CLI profile/Bearer；未配置就不承诺捕获                      |
| Shell Integration   | zsh adapter/CLI → `/api/activity/shell-command-events/batch`    | 复用 CLI Bearer；只允许 command family                               |
| CLI                 | `rw` → 当前 profile/baseUrl → `/api/activity/...`               | 复用 Bearer Auth；只能写 CLI allowlist 事件或触发真实业务 API        |
| 外部 TTY            | 显式 `rw activity ... --profile ...` 或安装 adapter             | Backend 不可达时明确失败；不承诺后台无损捕获                         |
| Web UI              | 当前 Backend `/api/activity/*`                                  | P0 只读；用户行为应由对应业务 API 在服务端记录，不由页面自报         |

### 跨 Runtime 集中

- 默认路径固定为 `~/.runweave/activity/activity.sqlite`。
- `RUNWEAVE_ACTIVITY_HOME` 只在 `RUNWEAVE_ACTIVITY_TEST_MODE=true` 的 test harness 中生效；packaged Stable/Beta 和普通 Dev 启动忽略该 override，避免继承到 channel-specific path。
- Stable、Beta、Dev Backend 都直接打开这一个文件；不互相调用、不选 owner、不依赖 App Server。
- 查询页面由用户当前打开的 Backend 读取同一文件，因此能看到其它 channel 已提交的事实。

## SQLite 驱动与进程模型

### 驱动决策

采用 `better-sqlite3`，在 Backend 内的 dedicated worker thread 中执行同步 SQLite 调用：

- 普通 Node 开发 Backend 使用当前 Node ABI 的 binding。
- packaged Backend 使用针对 Electron 33/目标架构 rebuild 的 binding。
- Node ABI 与 Electron ABI 产物物理隔离：workspace `node_modules` 保留 Node 22 binding；Electron rebuild 只操作 staging copy `.native-artifacts/better-sqlite3/electron-<version>-<platform>-<arch>/`，禁止原地覆盖 Node binding。
- `electron/scripts/bundle.mjs` 将 `better-sqlite3` 标记为 external，并把 `backend/src/activity/sqlite-worker.ts` 构建为独立 `activity-sqlite-worker.cjs`；Backend bundle 只用 runtime release 给出的绝对路径启动 worker，不能依赖 repo cwd。
- `electron/scripts/prepare-better-sqlite3-runtime.mjs` 使用 `electron/package.json` 中显式加入的 `@electron/rebuild`，只在隔离 staging app 内 rebuild `better-sqlite3`。脚本同时构建 worker，并生成 `.native-artifacts/better-sqlite3/electron-<version>-<platform>-<arch>/resources-backend/activity-sqlite-runtime-manifest.json`；`.native-artifacts/` 必须加入根 `.gitignore`，不提交 ABI 产物。
- bundled manifest 固定 `schemaVersion=1`，记录 `electronVersion/nodeModuleAbi/platform/arch`，并用四个 role path 指明 `workerEntry`、`packageEntry`、`packageManifest`、`nativeBinding`。另有按相对路径字典序排序的 `files[]`，覆盖 worker 和 staged `better-sqlite3` package 目录下每一个 regular runtime file，逐项保存 `path/size/sha256`，再对 canonical file list 保存 `treeSha256`；路径不得绝对化、越出根目录、symlink 或重复。
- `electron/electron-builder*.yml` 通过 `extraResources` 把 staging 中的 worker、完整 JS package/native binding 和 manifest 一起复制到 `Resources/backend`。`resolveBundledRuntimeRelease()` 在启动 Backend 前重新扫描实际文件树，要求文件集合与 manifest 完全相等（新增、缺失或改名都失败），再校验 schema/平台/架构/ABI、每个文件 hash 和 tree hash，最后把 worker、package dir 和 native binding 的绝对路径写入 `RuntimeRelease`；不能只校验四个入口或靠验收脚本猜路径。
- external runtime package 在 release 内保存 `backend/activity-sqlite-worker.cjs` 与 `native/better-sqlite3/`；release manifest 使用相同的完整排序 `files[] + treeSha256` 合同覆盖 worker 和全部 JS/native runtime 闭包，`RuntimeRelease`、installer 和 Backend resolver 都校验后才携带 `workerEntry/packageDir/nativeBinding`。安装器原子安装完整 release 后才切换 current pointer。
- `sqlite-worker` 使用显式 package/native binding 绝对路径加载 `better-sqlite3`，不从全局 `NODE_PATH` 或当前 cwd 猜测。
- Dev/`pnpm start` 由现有 `tsx` runtime 直接加载 source worker URL；packaged/external Backend 必须通过 `RUNWEAVE_ACTIVITY_WORKER_ENTRY`、`RUNWEAVE_BETTER_SQLITE3_PACKAGE_DIR` 和 `RUNWEAVE_BETTER_SQLITE3_NATIVE_BINDING` 三个由 runtime resolver 生成的绝对路径启动，任一路径缺失即只禁用 Activity。
- 新增与 `node-pty` 类似的 native binding resolver；Backend 启动时找不到或 ABI 不兼容时，只将 Activity 标记为 unavailable，不让整个 Backend 启动失败。
- root `pnpm.onlyBuiltDependencies` 增加 `better-sqlite3`，构建脚本必须验证 Dev Node 与 packaged Electron 两种 ABI。

不采用 `node:sqlite`：当前 packaged Electron Node 20 实际不可用。也不采用 `sql.js`：它不提供本计划需要的可靠多进程文件锁与 WAL 行为。

### 每个 Backend 的连接规则

每个 Backend 只有一个 Activity SQLite worker 和一个长生命周期 writer/query connection。已确认的 export 可以在同一 worker 内额外打开一个有界、短生命周期的 read-only snapshot connection；它不是第二套 Store 或写入口，结束/断连即 rollback 并关闭。启动后执行：

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
```

- 写事务使用短 `BEGIN IMMEDIATE`，单 batch 最多 64 个事件或 512 KiB canonical payload。
- `SQLITE_BUSY` 在 5 秒窗口内有界退避；超时返回 `activity_store_busy`，不无限阻塞业务。
- `activity_offset INTEGER PRIMARY KEY AUTOINCREMENT` 提供全库 commit 序，不代表跨 producer 的真实发生顺序。
- Timeline 按 `(occurred_at_ms, activity_offset)` 排序；因果关系只看显式 ID。
- retention 删除通过带 fencing token 的 `maintenance_leases` 保证同一时刻只有一个有效 Backend 执行；passive checkpoint 用同一 lease 抑制重复调用，并由 SQLite checkpoint lock 保证并发安全。

### Maintenance lease 与 fencing

- acquire/takeover 必须在短 `BEGIN IMMEDIATE` 中条件 UPSERT：仅当 lease 不存在或已过期时写入 owner/时间，并把 `fencing_token` 原子增加 1；renew 只能以完整 `(lease_name, owner_backend_instance_id, fencing_token)` 匹配当前 row。
- 每个有删除行为的 sweep batch 都重新 `BEGIN IMMEDIATE`，在同一事务内检查 owner、token 和 `expires_at_ms > now`，检查通过后才允许 mutation；检查失败立即 rollback 并返回 `activity_maintenance_lease_lost`。`PRAGMA wal_checkpoint(PASSIVE)` 不能在写事务内执行，因此它在短事务成功校验 token 后立即单次调用，并依赖 SQLite 自身 checkpoint lock 保证安全；这里的 lease 只抑制重复 checkpoint，不把它误写成逻辑数据的 fencing 边界。
- 因为校验与 mutation 共用写锁，新 owner 不能在旧 owner 的有效事务中途接管；旧 owner 即使暂停超过 TTL、被接管后再恢复，也会因 token 过期而被拒绝，不能继续删除。

### Schema 版本错位

- `PRAGMA user_version = compatibilityMajor * 1000 + additiveMinor`；迁移在 `BEGIN EXCLUSIVE` 中执行。普通 writer 必须先取得 `BEGIN IMMEDIATE` 写锁，再在同一事务内读取/gate `user_version`，通过后才写任何 row；major migration 因拿不到并发写锁，不能在 gate 与 INSERT 之间提交。
- 同一 major 内只允许新增 nullable/default column、新表或新索引；row-level event 演进只增加 `eventName + schemaVersion`，不因新 event bump major。Stable、Beta、Dev 可以运行不同 minor writer。
- Backend 看到同 major 的更高 minor 时继续按稳定 core contract 读写并忽略未知 additive 结构；看到更高 major 时只禁用 Activity，返回 `activity_schema_too_new`，Terminal 等其它能力继续运行。
- 任何需要旧 writer 停止的 DDL 必须 bump major，并采用两阶段 rollout：先让全部活跃 channel 发布“理解新 major 但不迁移”的版本，再单独开启 migration。Stable/Beta/Dev 并存期间禁止提前 bump major。
- 旧 Backend 禁止降级、重建、删除或覆盖较新 major 数据库。destructive migration 只有在全部 channel 升级且旧字段最长 30 天数据已过期后才能进入后续计划。

## 写入合约

### Producer 输入

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
  eventId: string;
  eventName: EventName;
  schemaVersion: number;
  occurredAt: string;
  producer: {
    name: string;
    version: string;
    instanceId: string;
    bootId: string;
    bootStartedAt: string;
    sequence: number;
  };
  actor: {
    type: "user" | "agent" | "system" | "unknown";
    agent?: "codex" | "claude" | "trae" | "playwright" | "other";
  };
  runtime: {
    channel: "stable" | "beta" | "dev" | "external";
    surface: "backend" | "desktop" | "web" | "app" | "cli" | "hook" | "shell";
    appVersion?: string;
    sourceRevision?: string;
    backendProfileId?: string;
  };
  scope: ActivityScopeInput;
  correlationId?: string;
  causationId?: string;
  parentEventId?: string;
  result?: {
    status: "succeeded" | "failed" | "cancelled";
    code?: string;
  };
  payload: Payload;
  contents: ActivityContentInput[];
  externalRefs: ExternalRefInput[];
}

interface ActivityContentInput {
  contentId: string;
  role:
    | "query"
    | "response"
    | "command"
    | "tool_args"
    | "tool_result"
    | "excerpt";
  mediaType: string;
  bytes: Uint8Array;
}

interface ExternalRefInput {
  refId: string;
  role: "thread" | "scrollback" | "run" | "outbox" | "evidence" | "artifact";
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
```

HTTP body 在解析前是 `unknown`，必须先经过 `eventName + schemaVersion` discriminated union。业务代码中不允许 `ActivityEventInput<string, unknown>` 或通用 `payload: any`。

### Canonical Fact

Backend Store 在同一 SQLite transaction 内补充：

- `ingestedAt`：commit 前的接收时间。
- `activityOffset`：SQLite 分配的全库 commit 序。
- `ingestFingerprintSha256`：规范化 Event、Content descriptor 和 Ref descriptor 的 hash。
- `privacyClassification/redactionVersion/localOnly`：Registry 与最终 DLP 结果。
- `retentionAnchorAt = min(occurredAt, ingestedAt)`。
- `expiresAt`、`priority`、Content/Ref snapshot。

相同 `eventId` 或相同 `(producerInstanceId, bootId, sequence)` 只有 fingerprint 相同才返回 duplicate ACK；内容不同返回 `idempotency_conflict`，不能覆盖原 row。

`behavior_facts` 一旦 INSERT/COMMIT 就不可 UPDATE，尤其禁止改 `project_id/thread_id/activity_offset`；后续只允许 retention 或已确认 delete 物理删除。Content/Ref 也只能更新 availability/tombstone 字段，不能换 owner。这是 delete cutoff 集合只能缩小、不能扩张的前提，Store API 与 migration 都必须保持。

每个 Fact 最多拥有 16 个 Content+ExternalRef descriptor。Store 在加密/规范化后计算 `ownedMutationBytes`：Fact `payload_json` UTF-8 bytes + 所有 ciphertext/nonce/tag/locator/link snapshot bytes + 固定 64 KiB Fact/index envelope + 每个 owned descriptor 固定 8 KiB row/link/index envelope；总和必须 ≤8 MiB。这个保守公式属于 compatibility major core，同 major 新增索引仍吃固定 envelope，改变公式/上限必须 bump major。超过时拒绝 Content/locator 并要求大对象改为 ExternalRef/只留 digest，不能拆成多个同 Fact Content 绕过。预算存入不可变 Fact row，delete runner 直接求和选 batch，因而“至少删除 1 Fact”和“每批 ≤8 MiB owned mutation budget”可以同时成立。

### 公共字段来源

| 字段                            | 来源                      | 规则                                                        |
| ------------------------------- | ------------------------- | ----------------------------------------------------------- |
| `eventId`                       | typed adapter             | 首次观察业务边界时生成 UUIDv7；重试保持不变                 |
| `eventName/schemaVersion`       | Registry builder          | 代码常量；调用方不能传任意 event name                       |
| `occurredAt`                    | 业务源/adapter            | 优先使用源系统权威时间，否则在动作边界取 UTC wall clock     |
| `ingestedAt/activityOffset`     | Backend ActivityStore     | 事务内生成；Producer 不可提交                               |
| `ingestFingerprintSha256`       | Backend ActivityStore     | 对 schema-normalized input 计算 SHA-256                     |
| `producer.name/version`         | adapter manifest          | Registry allowlist；不由 payload 自报                       |
| `producer.instanceId`           | Backend/adapter bootstrap | 安装或配置实例稳定 ID；进程重启不变                         |
| `producer.bootId/bootStartedAt` | Backend/adapter bootstrap | 每次进程启动生成；该 boot 内稳定                            |
| `producer.sequence`             | typed recorder            | 同一 instance + boot 单调递增，从 1 开始                    |
| `actor.*`                       | Registry + 明确 initiator | 拿不到写 `unknown`，不按文本猜                              |
| `runtime.channel`               | Desktop channel/env       | stable/beta/dev/external；CLI/Hook 不是 channel             |
| `runtime.surface`               | adapter 常量              | backend/desktop/web/app/cli/hook/shell                      |
| version/revision/profile        | Runtime manifest          | 只有明确、非敏感、稳定值才写                                |
| `scope.*`                       | 业务对象/Hook/adapter     | 直接取 Project/Terminal/Thread/Run/operation ID；缺失不补猜 |
| correlation/causation/parent    | 上游调用链                | 仅显式传播；时间邻近不能生成                                |
| `result.*`                      | 业务完成边界/Registry     | 只记录真实终态；reported result 不能升级为 verification     |
| `payload`                       | event-specific producer   | 先按 schema 校验、限长、DLP，再写 JSON                      |
| privacy/retention/priority      | Registry + Store          | Producer 不可降低隐私等级或延长 TTL                         |
| Content digest/encryption       | Backend ActivityStore     | 对最终脱敏 plaintext 计算并用 Keychain key 加密             |
| ExternalRef availability        | 注册 resolver             | capture 时快照；后续状态另算，不改历史                      |
| `ownedMutationBytes`            | Backend ActivityStore     | 最终 bytes + major 固定 64KiB/8KiB envelopes；上限 8 MiB    |
| duration/count/gap summary      | QueryService              | Computed，不回写原 Fact                                     |

## SQLite canonical schema

`activity.sqlite` 是唯一行为事实源；删除它即删除行为事实。没有 JSONL canonical、副本投影或客户端 SQLite spool。

Content 和 ExternalRef descriptor 使用 **Fact-affine ownership**：每个 `(eventId, role, ordinal)` 拥有独立 row；相同 plaintext、digest 或外部 locator 在不同 Fact/Project/Thread 中也不跨 Fact 去重。HTTP retry 只能复用同一 event 的同一 content/ref ID。这样 Project/Thread scoped delete 先选中 Fact，再由 FK cascade 物理删除它独占的 Content/locator descriptor；另一个 scope 即使引用相同源对象，也保留自己的独立 descriptor。ExternalRef 指向的源对象仍由原系统负责，本库删除的是 Activity 自己的加密 locator，不伪装成删除源系统对象。

```sql
CREATE TABLE producer_instances (
  producer_instance_id TEXT NOT NULL,
  producer_boot_id TEXT NOT NULL,
  producer_name TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  runtime_channel TEXT NOT NULL,
  runtime_surface TEXT NOT NULL,
  boot_started_at_ms INTEGER NOT NULL,
  started_event_id TEXT,
  first_seen_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER NOT NULL,
  highest_seen_sequence INTEGER NOT NULL,
  highest_contiguous_sequence INTEGER NOT NULL,
  last_commit_latency_ms INTEGER,
  last_error_code TEXT,
  expires_at_ms INTEGER NOT NULL,
  CHECK (boot_started_at_ms >= 0),
  CHECK (first_seen_at_ms >= boot_started_at_ms),
  CHECK (last_seen_at_ms >= first_seen_at_ms),
  CHECK (highest_seen_sequence >= 0),
  CHECK (highest_contiguous_sequence BETWEEN 0 AND highest_seen_sequence),
  CHECK (expires_at_ms >= last_seen_at_ms),
  PRIMARY KEY (producer_instance_id, producer_boot_id)
) STRICT;

CREATE INDEX producer_instances_expiry_idx
  ON producer_instances (expires_at_ms, producer_instance_id, producer_boot_id);

CREATE TABLE behavior_facts (
  activity_offset INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  event_name TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  ingested_at_ms INTEGER NOT NULL,
  ingest_fingerprint_sha256 TEXT NOT NULL,
  producer_name TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  producer_instance_id TEXT NOT NULL,
  producer_boot_id TEXT NOT NULL,
  producer_boot_started_at_ms INTEGER NOT NULL,
  producer_sequence INTEGER NOT NULL,
  actor_type TEXT NOT NULL,
  actor_agent TEXT,
  runtime_channel TEXT NOT NULL,
  runtime_surface TEXT NOT NULL,
  app_version TEXT,
  source_revision TEXT,
  backend_profile_id TEXT,
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
  retention_anchor_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  priority TEXT NOT NULL,
  owned_mutation_bytes INTEGER NOT NULL,
  CHECK (schema_version >= 1),
  CHECK (occurred_at_ms >= 0 AND ingested_at_ms >= 0),
  CHECK (producer_sequence >= 1),
  CHECK (length(ingest_fingerprint_sha256) = 64),
  CHECK (retention_anchor_ms <= occurred_at_ms),
  CHECK (retention_anchor_ms <= ingested_at_ms),
  CHECK (expires_at_ms >= retention_anchor_ms),
  CHECK (owned_mutation_bytes BETWEEN 0 AND 8388608),
  UNIQUE (producer_instance_id, producer_boot_id, producer_sequence),
  FOREIGN KEY (producer_instance_id, producer_boot_id)
    REFERENCES producer_instances(producer_instance_id, producer_boot_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TRIGGER behavior_facts_immutable_update
  BEFORE UPDATE ON behavior_facts
BEGIN
  SELECT RAISE(ABORT, 'behavior_facts_immutable');
END;

CREATE INDEX facts_timeline_idx
  ON behavior_facts (occurred_at_ms, activity_offset);
CREATE INDEX facts_interaction_idx
  ON behavior_facts (interaction_id, occurred_at_ms, activity_offset)
  WHERE interaction_id IS NOT NULL;
CREATE INDEX facts_correlation_idx
  ON behavior_facts (correlation_id, occurred_at_ms, activity_offset)
  WHERE correlation_id IS NOT NULL;
CREATE INDEX facts_thread_idx
  ON behavior_facts (thread_id, occurred_at_ms, activity_offset)
  WHERE thread_id IS NOT NULL;
CREATE INDEX facts_thread_delete_cursor_idx
  ON behavior_facts (thread_id, activity_offset)
  WHERE thread_id IS NOT NULL;
CREATE INDEX facts_run_idx
  ON behavior_facts (run_id, occurred_at_ms, activity_offset)
  WHERE run_id IS NOT NULL;
CREATE INDEX facts_terminal_idx
  ON behavior_facts (terminal_session_id, occurred_at_ms, activity_offset)
  WHERE terminal_session_id IS NOT NULL;
CREATE INDEX facts_project_idx
  ON behavior_facts (project_id, occurred_at_ms, activity_offset)
  WHERE project_id IS NOT NULL;
CREATE INDEX facts_project_delete_cursor_idx
  ON behavior_facts (project_id, activity_offset)
  WHERE project_id IS NOT NULL;
CREATE INDEX facts_runtime_surface_idx
  ON behavior_facts (runtime_channel, runtime_surface, occurred_at_ms, activity_offset);
CREATE INDEX facts_event_idx
  ON behavior_facts (event_name, occurred_at_ms, activity_offset);
CREATE INDEX facts_expiry_idx
  ON behavior_facts (expires_at_ms, activity_offset);

CREATE TABLE activity_contents (
  content_id TEXT PRIMARY KEY,
  owner_event_id TEXT NOT NULL,
  owner_role TEXT NOT NULL,
  owner_ordinal INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  kind TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  compression TEXT NOT NULL,
  encryption TEXT NOT NULL,
  encryption_key_id TEXT NOT NULL,
  encryption_key_version INTEGER NOT NULL,
  ciphertext BLOB,
  nonce BLOB,
  auth_tag BLOB,
  created_at_ms INTEGER NOT NULL,
  retention_anchor_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  redaction_version TEXT NOT NULL,
  current_availability TEXT NOT NULL,
  deleted_at_ms INTEGER,
  CHECK (owner_ordinal >= 0),
  CHECK (byte_length >= 0),
  CHECK (current_availability IN ('available', 'expired', 'deleted')),
  CHECK (
    (current_availability = 'available' AND deleted_at_ms IS NULL
      AND ciphertext IS NOT NULL AND nonce IS NOT NULL AND auth_tag IS NOT NULL)
    OR
    (current_availability != 'available' AND deleted_at_ms IS NOT NULL
      AND ciphertext IS NULL AND nonce IS NULL AND auth_tag IS NULL)
  ),
  UNIQUE (owner_event_id, owner_role, owner_ordinal),
  UNIQUE (content_id, owner_event_id, owner_role, owner_ordinal),
  FOREIGN KEY (owner_event_id) REFERENCES behavior_facts(event_id)
    ON DELETE CASCADE
) STRICT;

CREATE TRIGGER activity_contents_owner_immutable
  BEFORE UPDATE OF owner_event_id, owner_role, owner_ordinal ON activity_contents
BEGIN
  SELECT RAISE(ABORT, 'activity_content_owner_immutable');
END;

CREATE INDEX contents_expiry_idx
  ON activity_contents (current_availability, expires_at_ms, content_id);

CREATE TABLE fact_content_links (
  event_id TEXT NOT NULL,
  role TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  content_id TEXT NOT NULL UNIQUE,
  sha256_snapshot TEXT NOT NULL,
  byte_length_snapshot INTEGER NOT NULL,
  expected_expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY (event_id, role, ordinal),
  FOREIGN KEY (event_id) REFERENCES behavior_facts(event_id) ON DELETE CASCADE,
  FOREIGN KEY (content_id, event_id, role, ordinal)
    REFERENCES activity_contents(content_id, owner_event_id, owner_role, owner_ordinal)
    ON DELETE CASCADE
) STRICT;

CREATE INDEX fact_content_reverse_idx
  ON fact_content_links (content_id, event_id);

CREATE TABLE external_refs (
  ref_id TEXT PRIMARY KEY,
  owner_event_id TEXT NOT NULL,
  owner_role TEXT NOT NULL,
  owner_ordinal INTEGER NOT NULL,
  authority TEXT NOT NULL,
  locator_ciphertext BLOB,
  locator_nonce BLOB,
  locator_auth_tag BLOB,
  encryption_key_id TEXT NOT NULL,
  encryption_key_version INTEGER NOT NULL,
  version_or_digest TEXT NOT NULL,
  captured_at_ms INTEGER NOT NULL,
  expected_expires_at_ms INTEGER,
  retention_anchor_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  current_availability TEXT NOT NULL,
  last_checked_at_ms INTEGER,
  deleted_at_ms INTEGER,
  CHECK (owner_ordinal >= 0),
  CHECK (retention_anchor_ms >= 0 AND expires_at_ms >= retention_anchor_ms),
  CHECK (current_availability IN ('available', 'expired', 'missing', 'deleted')),
  CHECK (
    (current_availability IN ('available', 'missing') AND deleted_at_ms IS NULL
      AND locator_ciphertext IS NOT NULL AND locator_nonce IS NOT NULL AND locator_auth_tag IS NOT NULL)
    OR
    (current_availability IN ('expired', 'deleted') AND deleted_at_ms IS NOT NULL
      AND locator_ciphertext IS NULL AND locator_nonce IS NULL AND locator_auth_tag IS NULL)
  ),
  UNIQUE (owner_event_id, owner_role, owner_ordinal),
  UNIQUE (ref_id, owner_event_id, owner_role, owner_ordinal),
  FOREIGN KEY (owner_event_id) REFERENCES behavior_facts(event_id)
    ON DELETE CASCADE
) STRICT;

CREATE TRIGGER external_refs_owner_immutable
  BEFORE UPDATE OF owner_event_id, owner_role, owner_ordinal ON external_refs
BEGIN
  SELECT RAISE(ABORT, 'external_ref_owner_immutable');
END;

CREATE INDEX external_refs_expiry_idx
  ON external_refs (expires_at_ms, ref_id);

CREATE TABLE fact_external_ref_links (
  event_id TEXT NOT NULL,
  role TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  ref_id TEXT NOT NULL UNIQUE,
  availability_at_capture TEXT NOT NULL,
  CHECK (availability_at_capture IN ('available', 'missing')),
  PRIMARY KEY (event_id, role, ordinal),
  FOREIGN KEY (event_id) REFERENCES behavior_facts(event_id) ON DELETE CASCADE,
  FOREIGN KEY (ref_id, event_id, role, ordinal)
    REFERENCES external_refs(ref_id, owner_event_id, owner_role, owner_ordinal)
    ON DELETE CASCADE
) STRICT;

CREATE INDEX fact_external_ref_reverse_idx
  ON fact_external_ref_links (ref_id, event_id);

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
  retention_anchor_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  CHECK (first_sequence >= 1 AND last_sequence >= first_sequence),
  CHECK (status IN ('open', 'closed')),
  FOREIGN KEY (producer_instance_id, producer_boot_id)
    REFERENCES producer_instances(producer_instance_id, producer_boot_id)
    ON DELETE CASCADE,
  FOREIGN KEY (source_event_id) REFERENCES behavior_facts(event_id)
    ON DELETE SET NULL
) STRICT;

CREATE INDEX source_gaps_expiry_idx
  ON source_gaps (expires_at_ms, gap_id);
CREATE INDEX source_gaps_source_event_idx
  ON source_gaps (source_event_id)
  WHERE source_event_id IS NOT NULL;
CREATE INDEX source_gaps_producer_idx
  ON source_gaps (producer_instance_id, producer_boot_id, gap_id);

CREATE TABLE ingest_rejections (
  rejection_id TEXT PRIMARY KEY,
  received_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  producer_name TEXT,
  producer_instance_id TEXT,
  event_name TEXT,
  schema_version INTEGER,
  request_sha256 TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  sanitized_error_json TEXT NOT NULL CHECK (json_valid(sanitized_error_json)),
  CHECK (received_at_ms >= 0 AND expires_at_ms >= received_at_ms)
) STRICT;

CREATE INDEX ingest_rejections_expiry_idx
  ON ingest_rejections (expires_at_ms, rejection_id);

CREATE TABLE retention_sweeps (
  data_class TEXT PRIMARY KEY,
  last_started_at_ms INTEGER,
  last_completed_at_ms INTEGER,
  last_deleted_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT
) STRICT;

CREATE TABLE maintenance_leases (
  lease_name TEXT PRIMARY KEY,
  owner_backend_instance_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL,
  acquired_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  CHECK (fencing_token >= 1),
  CHECK (expires_at_ms > acquired_at_ms)
) STRICT;

CREATE TABLE activity_delete_jobs (
  delete_job_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  auth_subject_hmac_sha256 TEXT NOT NULL,
  auth_hmac_key_version INTEGER NOT NULL,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  as_of_activity_offset INTEGER NOT NULL,
  membership_digest_version INTEGER NOT NULL,
  preview_membership_sha256 TEXT NOT NULL,
  preview_count_sha256 TEXT NOT NULL,
  preview_fact_count INTEGER NOT NULL,
  status TEXT NOT NULL,
  last_deleted_activity_offset INTEGER NOT NULL DEFAULT 0,
  deleted_fact_count INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  expires_at_ms INTEGER,
  last_error_code TEXT,
  CHECK (scope_type IN ('project', 'thread')),
  CHECK (length(auth_subject_hmac_sha256) = 64),
  CHECK (auth_hmac_key_version >= 1),
  CHECK (length(scope_id) > 0),
  CHECK (as_of_activity_offset >= 0),
  CHECK (membership_digest_version >= 1),
  CHECK (length(preview_membership_sha256) = 64),
  CHECK (length(preview_count_sha256) = 64),
  CHECK (preview_fact_count >= 0),
  CHECK (last_deleted_activity_offset >= 0),
  CHECK (deleted_fact_count >= 0),
  CHECK (status IN ('pending', 'running', 'blocked', 'completed')),
  CHECK (
    (status = 'completed' AND completed_at_ms IS NOT NULL
      AND expires_at_ms IS NOT NULL AND expires_at_ms >= completed_at_ms)
    OR
    (status != 'completed' AND completed_at_ms IS NULL AND expires_at_ms IS NULL)
  )
) STRICT;

CREATE TRIGGER activity_delete_jobs_confirmation_immutable
  BEFORE UPDATE OF
    delete_job_id,
    request_id,
    auth_subject_hmac_sha256,
    auth_hmac_key_version,
    scope_type,
    scope_id,
    as_of_activity_offset,
    membership_digest_version,
    preview_membership_sha256,
    preview_count_sha256,
    preview_fact_count,
    created_at_ms
  ON activity_delete_jobs
BEGIN
  SELECT RAISE(ABORT, 'activity_delete_job_confirmation_immutable');
END;

CREATE TRIGGER activity_delete_jobs_progress_monotonic
  BEFORE UPDATE ON activity_delete_jobs
  WHEN
    OLD.status = 'completed'
    OR NEW.last_deleted_activity_offset < OLD.last_deleted_activity_offset
    OR NEW.deleted_fact_count < OLD.deleted_fact_count
    OR NEW.updated_at_ms < OLD.updated_at_ms
    OR NOT (
      (OLD.status = 'pending' AND NEW.status IN ('pending', 'running', 'blocked'))
      OR (OLD.status = 'running' AND NEW.status IN ('running', 'blocked', 'completed'))
      OR (OLD.status = 'blocked' AND NEW.status IN ('blocked', 'running'))
    )
BEGIN
  SELECT RAISE(ABORT, 'activity_delete_job_progress_invalid');
END;

CREATE INDEX activity_delete_jobs_status_idx
  ON activity_delete_jobs (status, updated_at_ms, delete_job_id);
CREATE INDEX activity_delete_jobs_scope_idx
  ON activity_delete_jobs (scope_type, scope_id, status, as_of_activity_offset);
CREATE UNIQUE INDEX activity_delete_jobs_single_active_idx
  ON activity_delete_jobs ((1))
  WHERE status IN ('pending', 'running', 'blocked');
CREATE INDEX activity_delete_jobs_expiry_idx
  ON activity_delete_jobs (expires_at_ms, delete_job_id)
  WHERE expires_at_ms IS NOT NULL;

CREATE TABLE activity_access_audit (
  audit_offset INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL UNIQUE,
  occurred_at_ms INTEGER NOT NULL,
  backend_instance_id TEXT NOT NULL,
  auth_subject_hmac_sha256 TEXT NOT NULL,
  auth_hmac_key_version INTEGER NOT NULL,
  action TEXT NOT NULL,
  scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
  result_status TEXT NOT NULL,
  result_code TEXT,
  expires_at_ms INTEGER NOT NULL,
  CHECK (action IN ('content_read', 'export', 'delete_requested', 'delete_completed')),
  CHECK (auth_hmac_key_version >= 1),
  CHECK (result_status IN ('succeeded', 'failed')),
  CHECK (expires_at_ms >= occurred_at_ms)
) STRICT;

CREATE INDEX activity_access_audit_expiry_idx
  ON activity_access_audit (expires_at_ms, audit_offset);
```

### 辅助表字段来源

| 表                        | 字段组                                             | 来源与生成规则                                                                      |
| ------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `producer_instances`      | identity/name/version/channel/surface/boot         | 已验证 envelope；Store 不能从日志或当前 Reporter 猜旧 epoch                         |
| 同上                      | first/last seen、sequence、latency、error、expiry  | 每次 SQLite commit/失败更新；source 状态保留到 last seen 后 30 天                   |
| `activity_contents`       | content ID/owner event+role+ordinal/kind/media     | 当前 Fact + typed adapter + Registry；跨 Fact 不复用 row，retry 只复用同一 owner    |
| 同上                      | sha256/size/compression                            | Store 对最终脱敏 plaintext 计算；不信任调用方声明                                   |
| 同上                      | key ID/version/ciphertext/nonce/tag                | Store 从 macOS Keychain 取 key 后 AES-256-GCM 生成                                  |
| 同上                      | created/anchor/expires/redaction/availability      | Store + Registry；TTL 由唯一 owner Fact 决定                                        |
| `fact_content_links`      | event/content/role/ordinal                         | 当前事务验证 owner 四元组；content ID 只能出现一次                                  |
| 同上                      | digest/size/expiry snapshot                        | 从 content row 复制；正文过期后仍保留到 Fact 到期                                   |
| `external_refs`           | ref ID/owner event+role+ordinal/authority          | 当前 Fact + Registry resolver；相同 locator 在不同 Fact 仍建独立 descriptor         |
| 同上                      | encrypted locator/key fields                       | resolver 验证 locator 后由 Store 加密                                               |
| 同上                      | version/captured/expected expiry                   | 源系统或 resolver 明确值；拿不到不猜                                                |
| 同上                      | retention anchor/expires                           | Store 复制唯一 owner Fact 的 anchor/TTL                                             |
| 同上                      | current availability/check/delete time             | resolver/retention 的显式结果；expired/deleted 清空 locator，不覆盖 capture 快照    |
| `fact_external_ref_links` | event/ref/role/ordinal                             | Store 在同一事务验证 owner 四元组并生成；ref ID 只能出现一次                        |
| 同上                      | availability at capture                            | resolver 在 Fact commit 时的快照                                                    |
| `source_gaps`             | producer/range/status/time                         | Store 比较同一 boot 的已提交 sequence 生成、拆分或关闭                              |
| 同上                      | reason/source event                                | 只有已收到并验证的 `source.events_dropped` 才能给原因；未知保持 NULL                |
| `ingest_rejections`       | identity/event fields                              | 只从已通过长度/字符集检查的未信任 envelope 提取                                     |
| 同上                      | hash/reason/sanitized error                        | Store 对收到 bytes 计算；不保存被拒绝原文                                           |
| `retention_sweeps`        | class                                              | Registry 常量                                                                       |
| 同上                      | started/completed/count/error                      | 获得 lease 的 Backend 在每次 sweep 后更新                                           |
| `maintenance_leases`      | name/owner/fencing token/time                      | Backend 以条件 UPSERT 原子递增 token；每个维护事务按 owner+token+未过期状态重新校验 |
| `activity_delete_jobs`    | job/request/auth HMAC version/scope/cutoff/digests | 已验证 delete confirmation；与 requested audit 同事务创建，供 completion audit 复制 |
| 同上                      | status/cursor/count/time/error/expiry              | 持有 delete lease 的 Backend 每个物理删除 batch 在同一事务更新；完成后保留 30 天    |
| `activity_access_audit`   | request/time/backend/auth subject HMAC/version     | Backend request context；用版本化 audit HMAC subkey 计算，不存 username/token/正文  |
| 同上                      | action/scope/result/expiry                         | Content/export route 与 delete request/completion job 的最小 IDs、结果和 30 天 TTL  |

## P0 事实目录

### 核心 14 个事件族

| 领域         | 事件                                                    | 可靠采集边界                                                   | 直接存储                                           | 可能引用                  | 为何记录                                        |
| ------------ | ------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------- | ------------------------- | ----------------------------------------------- |
| Source       | `producer.instance.started`                             | Backend/adapter 完成启动并取得 boot identity                   | producer、boot、channel、surface、version/revision | 无                        | 锚定来源实例与版本，不伪造停止时间              |
| Terminal     | `terminal.session.created/deleted`                      | Terminal application service 真正创建或删除                    | session、project、cwd、runtime、status/reason      | 无                        | 确定行为所属 Terminal 的真实生命周期            |
| Terminal     | `terminal.command.started/completed`                    | 首期仅受控 zsh preexec/precmd marker                           | command ref、cwd、exit/result；duration 查询计算   | 无                        | 还原命令和终态，不把 scrollback 猜成单命令输出  |
| User         | `user.query.submit_requested`                           | Agent Hook `UserPromptSubmit` 的单一权威边界                   | interaction、thread、turn、query content ref       | Thread（resolver 可用时） | 保存 Agent 实际观察到的请求，不把输入预览当提交 |
| Agent        | `agent.thread.started/resumed`                          | Hook `SessionStart.source=startup/resume`                      | agent、thread、source、model、permission           | Thread                    | 区分新会话与显式续接                            |
| Agent        | `agent.response.observed`                               | 主 Agent 原始 `Stop.last_assistant_message`，排除 SubagentStop | thread、turn、model、response ref                  | Thread                    | 保存来源明确暴露的可见回复                      |
| Tool         | `agent.tool.requested/completed`                        | `PreToolUse/PostToolUse` 按 tool use ID 配对                   | tool、call ID、确定性 args/result summary          | 明确 artifact             | 区分请求与可观察执行后结果                      |
| Browser      | `browser.tab.created/activated/closed`                  | Electron tab manager create/attach/close                       | group、tab、reason、sanitized URL                  | 无                        | 固定浏览器活动目标，不声称键盘焦点              |
| Browser      | `browser.navigation.started/completed/failed/cancelled` | Electron main-frame lifecycle；取消只接受显式原因              | navigation、from/to、result、duration              | 无                        | 证明主页面真实导航及终态                        |
| Verification | `verification.started/completed`                        | 身份化 runner 校验 case manifest 和 target handshake           | case、target、attempt、verdict、duration           | report/screenshot/trace   | 区分 Agent 声称和 runner 实际验证               |
| Agent Team   | `agent_team.run.created/state_changed/completed`        | Run 首次 durable write 与结构化状态迁移                        | run、phase、round、status、reason                  | run snapshot              | 展示团队运行阶段、轮次和最终收敛结果            |
| Agent Team   | `agent_team.worker.dispatched/result_recorded`          | Prompt 投递成功与通过 identity/freshness 的 outbox             | worker、role、panel、attempt、reported result      | pane/outbox               | 识别角色工作和真实上报结果                      |
| Agent Team   | `agent_team.case.dispatched/result_recorded`            | Case 实际投递与 outbox 结构化结果                              | case、source、worker、attempt、reported result     | evidence                  | 追踪 Case 来源、分派和记录结果                  |
| Collector    | `source.events_dropped`                                 | Backend 已接收来源且明确发生 queue/policy drop 后              | producer、boot、sequence range、count、reason      | 无                        | 暴露已知丢弃；未知缺口不伪造原因                |

整族排除：`terminal.panel.focused`、`operation.retry.requested`、`runtime.connection.lost/restored`、`file.viewed/saved/renamed/deleted`、`git.diff.viewed/reset.completed`、`user.interrupt.requested`、`agent.turn.*`、`browser.automation.performed` 和 `human.review.recorded`。当前入口不能稳定取得这些事件的完整语义或可靠 actor，因此不列入承诺。

### Event-specific 字段来源

| Event family                     | 关键字段                              | 原始来源                                         | 约束                                                      |
| -------------------------------- | ------------------------------------- | ------------------------------------------------ | --------------------------------------------------------- |
| `producer.instance.started`      | pid/releaseId                         | `process.pid`、runtime manifest/env              | pid 可选；release 只有明确值才写                          |
| `terminal.session.created`       | project/session/cwd/runtime/status    | runtime ensure 后的 `createdSession`             | occurredAt 用 session createdAt                           |
| `terminal.session.deleted`       | previous status/exit/reason           | 删除前 snapshot + delete 调用方 reason enum      | destroy 成功后记录                                        |
| `terminal.command.started`       | operationId/cwd/command               | zsh preexec marker 与 `$1`                       | command 先 DLP 后进 7 天 Content                          |
| `terminal.command.completed`     | same operationId/cwdAfter/exit        | zsh precmd 第一条语句保存 `$?`                   | exit=0→succeeded，否则 failed                             |
| `user.query.submit_requested`    | thread/turn/model/permission/query    | Agent Hook `UserPromptSubmit`                    | 唯一 emitter；Backend send/CLI 不重复发，只表示 requested |
| `agent.thread.started/resumed`   | source/thread/model/permission        | `SessionStart` 原始结构字段                      | clear/compact 不映射为 started/resumed                    |
| `agent.response.observed`        | thread/turn/message                   | 主 Agent `Stop`                                  | 空 message 不发；不读 transcript 补猜                     |
| `agent.tool.requested/completed` | tool use ID/name/input/response       | `PreToolUse/PostToolUse`                         | canonical JSON + DLP + hash；PostToolUse 不自动等于成功   |
| `browser.tab.*`                  | group/tab/reason/url                  | Electron tab manager 显式参数                    | URL 删除 userinfo/query/fragment                          |
| `browser.navigation.*`           | navigation ID/from/to/result/duration | Electron main-frame events + monotonic clock     | `ERR_ABORTED` 单独不足以证明 cancelled                    |
| `verification.*`                 | runner/case/target/attempt/verdict    | 新身份化 runner、manifest hash、target handshake | 普通 Agent/worker 无权写 verification namespace           |
| `agent_team.run.*`               | state/round/reason/result             | durable Run 写入前后 snapshot                    | 日志文本不生成 reason                                     |
| `agent_team.worker.*`            | worker/role/dispatch/outbox/result    | prompt send 成功、验证过的 pane outbox           | result 永远标记 reported                                  |
| `agent_team.case.*`              | case/source/worker/result/evidence    | loader source + 实际 dispatch + outbox           | Agent reported pass 不升级为 verification                 |
| `source.events_dropped`          | affected epoch/range/count/reason     | Backend recorder 已知 queue full/policy drop     | Backend 未收到的事件不能补造此 Fact                       |

### Actor 映射

| Event family               | Actor                             | 依据                                    |
| -------------------------- | --------------------------------- | --------------------------------------- |
| producer/source            | system                            | Registry 固定                           |
| terminal session/command   | explicit user/agent，否则 unknown | 当前 API 无调用者 identity 时不能猜     |
| user query                 | user                              | Query send/Hook 的语义边界              |
| agent thread/response/tool | agent + adapter identity          | Hook producer allowlist                 |
| browser                    | user/agent/system/unknown         | 显式 UI/CDP/page/restore initiator      |
| verification               | agent/playwright                  | runner identity                         |
| Agent Team                 | system                            | Backend orchestrator durable transition |

### 关联主线

```text
user.query.submit_requested
  interactionId = Query 边界生成
  correlationId = interactionId
      ├─ agent.response.observed
      ├─ agent.tool.requested/completed
      ├─ terminal.command.started/completed
      ├─ browser.navigation.*
      ├─ verification.*
      └─ agent_team.*（仅显式传播 interactionId 时）
```

- Thread 可以包含多个 interaction；interaction 不等于 Task。
- Agent Team run 可跨 interaction；每个 worker/case 仍保留 runId 和 operationId。
- 缺 ID 的 Fact 正常入库并标记 `unlinked`；禁止按“前后五分钟”归组。

## Backend API 与 CLI

### API

```text
POST /internal/activity/hook-events/batch
POST /api/activity/hook-events/batch
POST /api/activity/electron-events/batch
POST /api/activity/shell-command-events/batch
GET  /api/activity/facts
GET  /api/activity/timelines?selector=interaction|correlation|thread|run&id=...
GET  /api/activity/sources
GET  /api/activity/schemas
GET  /api/activity/contents/:contentId
GET  /api/activity/delete-jobs/:deleteJobId
POST /api/activity/operations/preview
POST /api/activity/operations/confirm
```

- 不新增端口；routes 挂在现有 Express app。
- Activity routes 不直接复用现有 `isLocalDirectRequest`。新增 Activity local guard：直连只接受 loopback socket；Vite proxy 必须剥离外部 forwarded/custom provenance headers，再注入真实 `X-Runweave-Client-Address`，Backend 只在 immediate peer 为 loopback 时信任它并再次要求原始地址是 loopback。这样本机 dev 页面可用，LAN 直连和经 Vite 转发都被拒绝。
- `/internal/activity/hook-events/batch` 复用 Hook Token；外部 Hook、Electron、shell 三个 `/api` 写入口复用 Bearer Auth。四条 route 分别注入固定 producer identity/event allowlist，不存在 generic event batch route。
- Electron main 复用 `electron/src/packaged-backend-auth.ts` 已有 Backend credential/login 流程获取短期 access token，只保存在内存，401 时重新登录；不新增 Electron token。Backend 根据专用 route 注入 producer identity，payload 不能覆盖。
- P0 不虚构现有 Bearer 中并不存在的 Activity scope，也不要求用户输入 packaged Backend 的内部密码：metadata query 和 Content read 都要求 local guard + 当前 Backend Bearer；Content read 额外要求 audit。export/delete 使用同一 Bearer session 下的 preview + 短期单次确认票据防误操作；模型永远不拿数据库句柄。
- `POST /api/activity/operations/preview` 只接受 `action=export|delete` 和恰好一个 `projectId|threadId`。它在一致 read snapshot 中冻结 `asOfActivityOffset`，对范围内 Fact 以及其一对一 Content/Ref descriptor 的排序成员、digest、availability 计算 `membershipDigest`，并返回各类 count、scope digest、export byte estimate、5 分钟过期时间和签名 `confirmationTicket`，不导出或删除任何数据。
- `membershipDigestVersion=1` 的 canonical input 在 shared contract 固定：按 `eventId`，再按 `kind/role/ordinal/objectId` 排序，包含 Fact fingerprint、Content sha256/availability、Ref version-or-digest/availability 和每类 count；scope 也按固定 JSON key 顺序编码。Stable/Beta/Dev 必须用同一 serializer，未知 digest version 拒绝 confirm，不能各自 stringify。
- `confirmationTicket` 复用当前 Backend 的 JWT secret，但必须使用独立 `type=activity_confirmation`、`aud=runweave:activity-operation-confirm` 和专用 issue/verify 函数。它不是 Activity 服务 token、producer credential 或长期权限；access/refresh/temporary token verifier 必须拒绝它，confirmation verifier 也必须拒绝其它 token type。payload 只含 random request ID、当前 access session ID、action、scope digest、`asOfActivityOffset`、count digest、membership digest/version 和 expiry；不含 username、正文或 locator。
- `POST /api/activity/operations/confirm` body 必须同时包含调用方固定注入的 `expectedAction`、canonical `scope={projectId}|{threadId}` 与从安全 body/内存取得的 `confirmationTicket`。Backend 重新 canonicalize scope 并计算 digest，要求当前 Bearer access session 与票据 session 完全一致，再逐项校验签名/type/audience/expiry、`expectedAction === ticket.action`，以及票据内 scope/count/membership 字段未被篡改；省略/替换 scope 都失败，一个有效 delete ticket 也不能从 export 子命令或按钮执行。当前数据是否仍匹配 preview 按下述 action-specific 规则处理。
- export confirm 必须在 read-only `BEGIN` snapshot 内重算完整 membership/count digest 并保持该 snapshot 到响应结束；任何成员被其它 Backend retention/delete 改变时返回 `activity_operation_preview_stale`，提交 `export failed/stale_preview` audit 以消费 request ID，但 0 body。匹配后在同一 snapshot 先做 canonical encoder byte-count preflight，确认 ≤128 MiB 后由 writer 提交 audit，再从该 snapshot 第二遍流式编码，任何 body chunk 都不能早于 audit commit。snapshot 最多 5 分钟，超时或超限要求缩小 scope，避免长期钉住 WAL。
- delete 不在 writer transaction 内重扫整个 scope。Fact 的 `activity_offset` 只增不改，已提交 Fact 的 scope 不可更新，因此 preview 后 `<= cutoff` 的集合只能因 retention/其它 delete 缩小，不可能扩张；delete ticket 授权的是“该 scope 在 cutoff 以内仍存在的单调子集”。confirm 只在短 `BEGIN IMMEDIATE` 中校验 token domain/session/action/canonical scope/cutoff、replay 和当前无其它 active delete job，然后创建 durable job。若其它动作已移除一部分成员，job 删除剩余子集并在 audit 记录实际 count，不会越过用户预览的 scope/cutoff。
- delete 匹配后不在 confirm 事务里删除全 scope。该短事务要求当前没有其它 pending/running/blocked delete job，然后原子插入 `activity_delete_jobs(status=pending)` 与 `delete_requested/succeeded/accepted` audit 并返回 `202 + deleteJobId`。从 commit 起，只要 job row 仍留存，Facts/Timeline/Content/export/Learning Context Pack 查询就必须 fail-closed 排除该 scope 且 `activity_offset <= cutoff`；预览后 offset 更大的新 Fact 不受影响。这样用户立即看不到待删除数据，同时不会用一个大事务阻塞三个 Backend writer。
- `ActivityDeleteJobRunner` 是每个现有 Backend 的 ActivityStore 内部 timer/worker，不是新服务。任一 Backend 可竞争 `maintenance_leases['activity-delete']`；获得 owner+fencing token 后，每个 `BEGIN IMMEDIATE` batch 都重新校验 job、owner/token/expiry。候选查询用 `(project_id|thread_id, activity_offset)` partial index 按 cursor 依次读取不可变 `owned_mutation_bytes`，累计到 ≤1000 Facts 且总预算 ≤8 MiB；每个合法 Fact 自身已 ≤8 MiB，所以至少可处理 1 条，禁止 scope 全表重扫或 temp sort。随后依赖 FK cascade 删除并在同一事务更新 cursor/count。单批完成即释放写锁；runner 若本 Backend recorder queue 非空必须让行，批次间至少等待 50 ms 并使用同一 busy/backoff 预算，避免连续抢锁饿死其它 Backend writer。
- Backend 崩溃或 batch 失败时，job/cursor 已持久化；旧 owner 恢复会被 fencing 拒绝，lease 到期后其它 Backend 从最后 commit cursor 继续。可恢复错误将 job 标为 `blocked` 并保持查询 tombstone，不把数据重新显示；条件恢复后继续。没有剩余匹配 row 时，最终短事务写 `status=completed/completedAt/expiresAt(+30d)` 与独立 `delete_completed/succeeded` audit；completion audit 从 job 复制确认时保存的 versioned auth-subject HMAC，不依赖仍存在的 access session 或 requested audit row。P0 同时只运行一个全局 delete job；新 delete confirm 在它完成前返回 `activity_delete_in_progress`，Data Policy/CLI 通过 status API 展示进度与阻塞原因。
- 所有 Backend 都停止时没有后台进程继续物理删除，这是“无独立服务”的直接结果；durable job 和查询 tombstone 留在同一 SQLite，下一次任一 Backend 启动即恢复 runner。产品不得把“已接受/已隐藏”显示为“物理删除完成”。
- Web UI 必须在独立确认步骤重新展示 action/scope/count/cutoff，ticket 和 canonical scope 只留组件内存并由固定 action 按钮提交；CLI 必须是第二次显式命令，stdin 接受 preview 输出的 `{confirmationTicket, scope}` JSON envelope，不能把 ticket 放进 argv、shell history、URL、日志或落盘配置。
- 这套 confirm 是防误操作而不是权限升级：持有同一合法 Bearer 的代码仍有能力自行 preview/confirm；真正的更高权限或 OS user-presence 需要未来统一 Auth capability 设计，P0 不假装已有。Stable/Beta/Dev 都使用相同 session-bound 合同，不读取或暴露 Electron 内部随机密码，也不依赖 Beta 的默认密码。
- `activity_access_audit.request_id` 使用 ticket request ID 的 UNIQUE 约束提供 replay fence：export 先提交 audit 才返回 body；delete confirmation 将 requested audit 与 durable query tombstone/job 同事务提交，completion audit 使用派生的独立 request ID。票据过期、token domain/session/scope/action 不符、重复 confirm 或 audit 写失败全部失败且不返回敏感 body、不创建删除 job；用户必须重新 preview。
- Content read/export 必须先提交对应 `activity_access_audit` 再返回敏感 body；delete 只有 requested audit+job commit 后才返回 accepted，物理完成必须有 completion audit。audit 写失败时敏感操作失败，不返回“已完成”。
- P0 不新增 Activity WebSocket。页面使用 keyset pagination + 有界 polling；真实需要实时流后再复用 Backend 现有 WS server。
- 页面第一页冻结 `asOfActivityOffset`，后续使用 opaque keyset `(occurredAt, activityOffset)` 且限制 `activityOffset <= asOfActivityOffset`。

### CLI

新增 `rw activity` command，但它始终调用 Backend：

```text
rw activity facts [--profile <name>|--backend-port <port>]
rw activity timeline (--interaction-id|--correlation-id|--thread-id|--run-id) <id> [...]
rw activity sources [...]
rw activity export (--project-id <id>|--thread-id <id>) [...]
rw activity export --confirm-stdin [...]
rw activity delete (--project-id <id>|--thread-id <id>) [...]
rw activity delete --confirm-stdin [...]
rw activity delete status <delete-job-id> [...]
rw activity record terminal-command-started --operation-id ... --cwd ... --command-stdin [...]
rw activity record terminal-command-completed --operation-id ... --cwd ... --exit-code ... [...]
rw activity record agent-hook --file - --profile <name> [...]
```

- P0 `record` 只作为受控 zsh 与显式安装的 Agent Hook adapter 传输命令：前者固定映射 `terminal.command.started/completed`，后者只接受 Registry 支持的原始 Hook discriminated union；不提供任意 `--event-name/--payload-json` 逃生口。
- export/delete 第一次调用只执行 preview 并打印数量、scope、`asOfActivityOffset`、过期时间和 confirmation ticket；只有同一 profile/session 下第二次显式调用 `--confirm-stdin` 才执行，子命令固定注入 `expectedAction`，stdin JSON 同时带回 canonical scope。delete confirm 返回 durable job ID；CLI 用 `delete status` 查询 progress/blocked/completed。不提供 ticket argv 参数、一步完成、`--yes`、内部密码读取或跨 session 票据复用。
- Backend 强制把该入口标为注册 CLI/shell adapter identity；调用者不能覆盖 producer identity、runtime surface、actor、privacy、TTL 或 verification namespace。
- 现有 `rw terminal send --agent` 不直接发 `user.query.submit_requested`；只有 Agent 实际触发 `UserPromptSubmit` 后由 Hook 记录，避免 Backend send 与 Hook 双记。其它业务命令只在各自计划定义的唯一权威边界记录。
- Backend 不可达时 CLI 以非零码退出并说明“未记录”；P0 不在 CLI 本地创建 hidden spool，也不声称稍后自动补传。

## 查询页面

第一阶段只有四个页面/视图：

1. **Facts**：按时间、Runtime、Surface、Project、Terminal、Thread、Run、Event、Actor、Result 查询；详情区分 Recorded row 与短期 Content/ExternalRef。
2. **Interaction Timeline**：只按显式 interaction/correlation/thread/run 展开；高频 tool 折叠；缺关联显示 `unlinked`。
3. **Sources**：展示 producer instance/boot/version、last seen、highest seen/contiguous sequence、open gaps、rejections、last commit latency、last error、WAL/checkpoint 状态。
4. **Data Policy**：展示 7/30 天、磁盘占用和内容 availability；export/delete 必须先显示冻结 scope、影响数量与截止 offset，再由同一 Bearer session 显式 confirm；大范围 delete 显示立即隐藏、分批物理删除的 job progress/blocked/completed 状态。

页面不展示 Task、Goal、Outcome、Rework、节省时间、自动结论或没有分母的 coverage 百分比。`Duration`、显式事件数、sequence gap 等确定值标记为 Computed。

## 留存、容量与故障语义

### 默认留存

| 数据                                                  |         默认 | 清理语义                                             |
| ----------------------------------------------------- | -----------: | ---------------------------------------------------- |
| Query/回复/命令/excerpt ciphertext                    |         7 天 | 清空密文并保留 digest/size tombstone 至 Fact 到期    |
| ingest rejection metadata                             |         7 天 | 只含 hash/reason/脱敏错误，不含原始请求              |
| Behavior Fact、关系、ExternalRef、producer/source gap |        30 天 | 按各表 `expires_at_ms` 有界删除                      |
| Content read/export/delete request/completion audit   |        30 天 | 只留 request/scope/result metadata                   |
| `activity_delete_jobs`                                | 完成后 30 天 | 未完成时是查询 fail-closed tombstone；完成后审计留存 |
| `retention_sweeps/maintenance_leases`                 |     当前状态 | 覆盖更新，不作为行为 Fact                            |
| 未来未审核 Context Pack/Candidate                     |        30 天 | 位于独立 `learning.sqlite`，不在本阶段创建           |

- retention 每 15 分钟尝试取得 lease，每次最多处理 1000 rows，事务结束后释放或等待短 lease 过期。
- sweep 顺序固定：先清 7 天 Content ciphertext/到期 ExternalRef locator 并写 tombstone；再删除到期 Fact（FK cascade links）；再删除到期 `source_gaps`、`ingest_rejections`、`activity_access_audit`、已完成且到期并经 `NOT EXISTS` 证明 scope+cutoff 已无 Fact 的 `activity_delete_jobs`，以及已无 Fact/gap FK 的 stale `producer_instances`；最后物理删除已无任何 link 的 Content/ExternalRef orphan。每个不超过 1000 rows 的 sweep batch 独立事务，单 batch 任一步失败则整体 rollback；pending/running/blocked job 永不按 TTL 清除，completed job 若仍有目标 row 也保留 tombstone并报告 invariant error。`maintenance_leases` 是固定小闭集，过期 row 永不物理删除，只能原地 takeover 并单调递增 fencing token，避免 owner/token ABA。
- Content/Ref 到期不改变历史 Fact/link snapshot；查询返回 `expired/deleted/missing`，不返回空字符串冒充原内容。
- 单个 Fact 的 `payload + 最多 16 个 owned Content/Ref/link + table/index page allowance` 合计 `ownedMutationBytes ≤8 MiB`；更大的对象必须降为不复制大对象本体的 ExternalRef 或只保留 digest。默认容量预算 5 GB；P0 超限时拒绝新增大 Content，但仍尽力保存不含正文的 critical Fact，不能静默删除未过期事实。

### 可靠性语义

- 网络/API 重试是 at-least-once；eventId + producer epoch/sequence + fingerprint 实现幂等。
- SQLite commit 成功才返回写入 ACK。
- Backend 崩溃后依赖 WAL recovery；未 commit 的 queue item 不声称已记录。
- Backend 不可达期间，外部 CLI/Hook 没有事实；Sources 只能显示最后 seen，不能生成虚假 gap reason。
- `integrity_check` 或 `foreign_key_check` 失败时 Activity fail-closed，明确显示 unavailable；不从 JSONL、Thread 或日志重建。
- secondary index 可在同一数据库由 migration/rebuild 修复；删除 DB 等于删除事实，不能宣称可从其它源完整恢复。

规模验收预算：

- 典型 10,000–100,000 semantic events/day。
- 30 天上限约 3,000,000 facts。
- Backend `recordBatch` commit p95 < 50 ms。
- 3 个 Backend 并发各 50 events/s，连续 10 分钟无 busy loss。
- 3,000,000-row fixture 上，interaction/correlation/thread/run/project/runtime+surface 的最近 10,000 条 keyset query p95 < 500 ms；`EXPLAIN QUERY PLAN` 必须命中对应复合索引，不能退化为全表 scan。

## 隐私与安全

- 路径、URL、tool JSON 和正文先按 schema redaction；Store 再执行 token/header/cookie/password/private key/high-entropy secret scan。
- `.env`、Authorization、Cookie、完整 headers、环境变量、证书、Keychain 内容不得入库。
- Content 和 ExternalRef locator 使用 AES-256-GCM；目录 `0700`，DB/WAL/SHM `0600`。
- P0 macOS `ActivityKeyProvider` 使用固定 Keychain service `com.runweave.activity`、account `content-key-v1`。首次创建在 SQLite `BEGIN EXCLUSIVE` 初始化段内完成，避免多个 Backend 生成不同 key；通过 `/usr/bin/security add-generic-password ... -w` 的 stdin prompt 写入，禁止把 key 放入 argv、env、日志或数据库。读取使用 `find-generic-password -w`，stdout 只进入 Backend 内存并在 worker 关闭时释放引用。
- Content/ExternalRef row 保存 `encryption_key_id/version` 以支持未来轮换；本计划不自动轮换已有 ciphertext。非 macOS runtime 在没有等价安全 provider 时禁用 Content/locator 持久化，但仍可写不含敏感正文的 Fact，并明确返回 `content_key_unavailable`。
- Audit 主体标识不直接复用 AES key：从当前 Activity master key 通过 HKDF-SHA256 context `runweave/activity-audit-subject/v1` 派生 HMAC subkey，row 保存 `auth_hmac_key_version`；轮换时旧版本仍可区分和验证，不保存 username。
- `payload_json` 不放 Query、回复、命令正文或任意 locator。
- Activity query P0 仅 loopback + 已认证调用；远程/LAN 查看需另立权限设计，不随普通 Terminal API 自动开放。
- P0 信任同一 OS 用户下已认证的本机进程；专用 route/allowlist 防止远程或误接线伪造来源，不试图防御拥有该用户账号、Keychain 和数据库文件权限的恶意本机用户。
- Content read/export/delete 写 `activity_access_audit`；audit 不保存被读/删正文、username 或 token。

## Learning 的未来边界

Learning 不属于本次实现，但必须预留正确边界：

```text
activity.sqlite facts
  → Backend 确定性选择 + resolver + 二次脱敏
  → immutable Context Pack
  → Model / Learning Agent
  → Candidate + evidence refs
  → review
  → ~/.runweave/activity/learning.sqlite
```

- `learning.sqlite` 与 `activity.sqlite` 分开；模型产物永远不能写 `behavior_facts`。
- 模型只能看到冻结的 Context Pack，不能读取全库、SQLite path 或任意本地 locator。
- UI 点击、CLI 或 Agent 将来都调用同一个 Backend AnalysisJob API；生成是显式动作，不因页面查询自动发生。
- Learning 数据结构、模型调用、审核和发布另写独立计划；本计划不把占位表或假数据混入 P0。

## 实施阶段

### P0：合同与 SQLite runtime 验证

修改/新增：

- `packages/shared/src/activity/`：event union、DTO、query selector types、retention/privacy enums。
- `backend/package.json`、root `package.json`：`better-sqlite3` dependency/build allowlist。
- `electron/package.json`、root `.gitignore`：加入 staging rebuild 所需的 `@electron/rebuild`，并忽略 `.native-artifacts/`。
- `electron/scripts/bundle.mjs`、`electron/scripts/prepare-better-sqlite3-runtime.mjs`、`electron/electron-builder*.yml`、`electron/src/runtime-release.ts`、`electron/src/backend-runtime-types.ts`、`electron/src/backend-runtime.ts`、`scripts/build-runtime-package.mjs`、`scripts/install-runtime-package.mjs`：独立 worker、双 ABI staging、Resources/external release copy、manifest/hash、resolve 和 env。
- `scripts/verify-activity-sqlite-runtime.mjs`：分别验证普通 Node workspace、unpacked/packaged App `Resources` 与已安装 external runtime release 打开临时 DB、WAL 写读；同时证明 Node/Electron binding 物理路径和 ABI 不同。

验收：workspace Node、packaged Resources、external runtime 三条路径均成功打开同一 fixture，runtime rollback 后仍可读；不支持 ABI 时错误明确；没有 Activity daemon、端口、token 或 discovery 文件。

### P1：Backend ActivityStore 与 API

修改/新增：

- `backend/src/activity/activity-recorder.ts`：typed in-process facade、batch、error isolation。
- `backend/src/activity/sqlite-worker.ts`：长生命周期 writer/query connection、受限 export snapshot connection、事务、busy retry、shutdown drain。
- `backend/src/activity/migrations.ts`：DDL、`user_version`、前后版本 gate。
- `backend/src/activity/registry.ts`：producer/event allowlist、schema、actor/privacy/retention。
- `backend/src/activity/crypto.ts`：Keychain key、AES-GCM、DLP。
- `backend/src/activity/query-service.ts`：Facts/Timeline/Sources keyset query，并对仍留存的 delete job scope fail-closed。
- `backend/src/activity/retention.ts`：lease、sweep、checkpoint。
- `backend/src/activity/delete-job-runner.ts`：现有 Backend 内部可接管的 durable job、fencing、1000 rows/8 MiB 分批 cascade 与进度。
- `backend/src/routes/activity.ts`、`backend/src/routes/internal-activity.ts`：现有 Backend routes、敏感操作 preview/confirm 与 audit gate。
- `backend/src/auth/jwt.ts`：用独立 type/audience 和专用 verifier 签名 5 分钟、绑定当前 access session 的单次 confirmation ticket；不签发新长期 session/Activity credential。
- `backend/src/server/local-activity-request.ts`、`frontend/vite.config.ts`、`app/vite.config.ts`：可信本机来源传播；本机 dev 允许、LAN 直连/转发拒绝。
- `backend/src/bootstrap/runtime-services.ts`、`backend/src/index.ts`：创建、挂载、关闭。
- `backend/src/utils/path.ts`：全局 Activity path；不能从 browser profile 派生。
- `electron/src/packaged-backend-auth.ts` 与 Browser emitter：复用现有 Backend login，内存 access token 调专用 Electron route。

验收：同进程 record/query、重复、冲突、transaction rollback、7/30 天、删除、DLP、local-only auth 全部通过。

### P2：多 Backend 与 CLI

修改/新增：

- `packages/runweave-cli/src/commands/activity.ts`、client 与 command routing。
- Stable/Beta/Dev runtime env 只传播 channel/profile identity，不覆盖 Activity DB path。
- 多进程 integration harness：三个 Backend 同库并发写、查询、schema version 错位、lease 接管、WAL recovery。

验收：三个 Backend 的 facts 在任一 Backend 查询结果中可见；无 duplicate/corruption；CLI 只调用 Backend，`lsof` 不出现 CLI 持有数据库。

### P3：核心 Producer

按真实边界逐批接线：

- Backend Terminal：`backend/src/terminal/*` 的 session application service 与 shell integration。
- Agent Hook：`plugins/toolkit/hooks/runweave-hook-payload.cjs`、`runweave-hook-bridge.cjs`；Activity 写入 Backend，不依赖 App Server。
- Electron Browser：`electron/src/terminal-browser-tabs.ts`、`terminal-browser-view-lifecycle.ts` 等明确 tab/navigation 边界。
- Agent Team：`backend/src/agent-team/service-*` durable transition、dispatch、validated outbox 边界。
- Verification：新增身份化 runner/reporter 后才启用 `verification.*`；未完成 runner 时 registry 不注册此 family。

每个 producer 独立 feature flag：Dev → Beta → Stable。每批先观察 24 小时 rejection、gap、disk、redaction 与 commit latency。

### P4：事实页面

修改/新增：

- `frontend/src/services/activity.ts` 与 query keys。
- `/activity` 页面：Facts、Timeline、Sources、Data Policy。
- 详情抽屉只展示 Recorded/Computed；内容到期、ref missing、source gap 有明确状态。

必须用真实 Backend 数据和 `$playwright-cli` 验收，不用 mock 截图作为完成证据。

## 配套验收与门禁

测试合同：`docs/testing/system-activity-data-foundation-test-cases.md`。

每阶段按顺序执行：

```bash
pnpm architecture:check
pnpm typecheck
pnpm lint
pnpm build
node scripts/verify-activity-sqlite-runtime.mjs
git diff --check
```

- 浏览器页面必须执行 `$playwright-cli`。
- Desktop Stable/Beta 并行先用 `$computer-use` 准备环境，再用 `$playwright-cli` 验证页面。
- 后端/SQLite 行为使用独立临时 `RUNWEAVE_ACTIVITY_HOME` fixture；不得污染用户正式数据库。
- 静态检查、源码阅读、单张截图不能替代 API、SQLite、并发、保留和真实页面证据。
- 本仓库不新增单元测试文件；验证脚本、现有 Playwright E2E 与真实行为核对按仓库规则执行。

## 上线、回滚与数据安全

- 不 backfill 历史；feature enable 后才产生 Recorded fact。
- rollout 顺序：Dev → Beta → Stable；每阶段 schema 必须兼容前一已发布 writer。
- Producer 可单独关闭；关闭不删除历史事实，Sources 显示最后 seen。
- 回滚旧 Backend 时若数据库 schema 太新，只禁用 Activity 模块；绝不能降级数据库。
- 用户删除 `activity.sqlite` 是显式数据删除，不承诺从业务库恢复。
- 实现 PR 不能包含用户真实 Activity DB、WAL、SHM、Content 或导出文件。

## 冻结决策

- **不新增 Activity Hub 或任何新服务。**
- **Activity 能力属于现有 Backend 的进程内模块。**
- **Stable/Beta/Dev 多 Backend 直接共享一个 OS 用户级 SQLite；SQLite WAL 是写入协调者。**
- **CLI/Hook/Electron 只调用 Backend，任何客户端都不直接打开数据库。**
- **App Server 保持现状，不是 Activity 依赖或事实源。**
- **大范围删除先在同库写 query tombstone/job，再由现有 Backend 以 fenced 小事务可恢复清理，不新增常驻进程。**
- **采用 7 天 Content / 30 天 Fact，不永久保存原始行为。**
- **只记录可靠业务边界，缺失显式显示，不从日志或时间邻近推断。**
- **第一阶段只做事实、轨迹、来源与数据策略；Learning 另库、另计划、由模型显式生成。**
