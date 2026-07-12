# Runweave Backend 内嵌行为数据底座测试用例

> 状态：功能已实施并完成代表性集成/CLI/浏览器/native runtime 验证；放量级与完整故障矩阵尚未全部执行。
> 对应计划：`docs/plans/2026-07-11-system-activity-data-foundation.md`
> 配套产品原型：`docs/prototypes/system-activity-data-foundation/`
> 配套架构流程：`docs/architecture-flows/system-activity-data-foundation-flow/`
> 验证原则：不新增单元测试文件；使用临时数据库、可执行集成脚本、真实 Stable/Beta/Dev、真实 CLI 与 `$playwright-cli` 取证。

## 验收范围

覆盖：

- 不新增 Activity daemon/端口/发现/auth 生命周期。
- Backend 内嵌 `ActivityRecorder/ActivityStore/ActivityQueryService`。
- Stable、Beta、Dev 多 Backend 共同读写 `~/.runweave/activity/activity.sqlite`。
- CLI/Electron/Hook/Shell 只经 Backend 写入，不直接打开 SQLite。
- SQLite WAL、多进程并发、幂等、事务、schema version、retention lease、崩溃恢复。
- P0 14 个可靠事件族、字段来源、显式关联和 coverage gap。
- 7 天 Content / 30 天 Fact、DLP、加密、登录鉴权、删除与导出。
- Facts、Interaction Timeline、Sources、Data Policy 四个页面视图。

不覆盖：

- 历史 backfill、任意外部 TTY 的透明全量捕获。
- 模型调用、Learning Candidate、审核、发布、检索或反馈闭环。
- OTLP、云端仓库、跨设备同步。
- mousemove、按键、terminal byte、模型 token 或隐藏思维链。

## 前提事实

- Backend routes、Tunnel Auth、Bearer Auth 和 Hook Token 已存在于 `backend/src/index.ts`。
- Backend 是 per-profile 生命周期；不同 profile 可同时运行，见 `backend/src/server/profile-lock.ts`。
- Beta 使用独立 browser profile/CLI config/App Server home，见 `electron/src/desktop-config.ts`。
- CLI 已通过 profile/baseUrl/accessToken 调 Backend，见 `packages/runweave-cli/src/client/auth-context.ts`。
- packaged Backend 运行于 Electron 33/Node 20，不能把 `node:sqlite` 当可用前提。
- 正式数据默认在 `~/.runweave/activity/`；所有自动化必须设置临时 `RUNWEAVE_ACTIVITY_HOME`，不得读取或修改用户正式数据。

## 环境与证据

每次执行创建独立目录：

```bash
export RUNWEAVE_ACTIVITY_TEST_MODE=true
export RUNWEAVE_ACTIVITY_HOME="$(mktemp -d)/activity"
```

证据目录：

```text
artifacts/activity-data-foundation/<run-id>/
  environment.json
  processes/
  api/
  sqlite/
  concurrency/
  retention/
  privacy/
  cli/
  browser/
```

`environment.json` 至少记录 Git SHA、Node/Electron/SQLite driver version、CPU arch、三个 Backend 的 PID/port/channel/profile、临时 DB path、开始/结束时间和退出码。证据不得包含 Query/回复/命令明文、token、cookie、Authorization、Keychain key 或完整环境变量。

## 必跑门禁

按顺序执行，任一失败即停：

```bash
pnpm architecture:check
pnpm typecheck
pnpm lint
pnpm build
node scripts/verify-activity-sqlite-runtime.mjs
git diff --check
```

功能实现后再执行本文件的真实环境用例。浏览器用例必须使用 `$playwright-cli`；Desktop Stable/Beta 并行准备使用 `$computer-use`。静态检查和源码阅读只作前置门禁，不算功能通过证据。

## 测试用例

### ADF-001 未创建独立 Activity 服务

- **Given**：构建并启动实现后的 Runweave，记录启动前后的监听端口、进程树和 `~/.runweave/` 新增文件。
- **When**：分别启动 Stable、Beta、Dev 并打开 Activity 页面。
- **Then**：没有 `activity-hub`/activity daemon 进程、独立监听端口、lock/discovery/token 文件或 start/stop/status 命令；Activity routes 只存在于各自 Backend 端口。
- **失败判断**：出现独立 Activity PID/端口/服务发现/凭据，或页面依赖该进程才可用。
- **验证方式**：进程/端口快照 + Backend route 请求 + 文件树 diff。

### ADF-002 数据库位于 profile 外的固定 OS 用户目录

- **Given**：Stable、Beta、Dev 使用三个不同 browser profile，Activity home 指向同一个临时根目录。
- **When**：三个 Backend 各写入一个带唯一 channel 的 Fact。
- **Then**：只生成一个 `<RUNWEAVE_ACTIVITY_HOME>/activity.sqlite` 及其 WAL/SHM；任何 profile、App Server home、项目 `.runweave` 中都没有另一份 Activity DB。
- **失败判断**：按 profile/channel 生成多库，或数据落入现有业务/日志文件。
- **验证方式**：文件树、SQLite row 查询、profile 路径检查。

### ADF-003 只有 Backend 进程持有数据库句柄

- **Given**：一个 Backend、页面、CLI、Electron、Hook adapter 均处于活动状态。
- **When**：执行写入、查询和导出并在过程中采集 `lsof`。
- **Then**：数据库/WAL/SHM 只由 Backend PID 打开；CLI、Electron renderer、浏览器、Hook 和模型进程不持有句柄。
- **失败判断**：任何非 Backend runtime 直接打开 SQLite，或共享 SQLite driver/migration 代码存在第二份运行入口。
- **验证方式**：`lsof` 证据 + 进程树；停机后可用只读 `sqlite3` 取证，但它不是产品写入路径。

### ADF-004 Stable/Beta/Dev 在同一数据库集中展示

- **Given**：三个 Backend 同时连接一个临时 DB，各自 runtime channel/profile/revision 可区分。
- **When**：每个 Backend 提交 100 个事件，再分别通过三个 Backend 查询 Facts。
- **Then**：任一查询都看到 300 个事件；channel/profile 字段保留真实来源；App Server home 和 Backend 控制面仍彼此隔离。
- **失败判断**：任一 Backend 只能看到自己的 facts、出现重复/缺失，或为集中化而共享 Backend profile/App Server home。
- **验证方式**：三个 API 响应 + SQLite 聚合计数。

### ADF-005 CLI 通过所选 Backend 写入而非直写 SQLite

- **Given**：两个 CLI profile 分别指向 Stable 与 Beta Backend；DB 初始为空。
- **When**：使用 `--profile`、`--backend-port` 和 `RUNWEAVE_BASE_URL` 三种方式执行固定的 `rw activity record terminal-command-started/completed` 与真实业务命令，并尝试任意 event/payload 参数。
- **Then**：请求命中所选 Backend，最终写入共享 DB；Fact 的 producer/runtime 来自 Backend/Registry context，CLI 不能覆盖；CLI PID 不打开 DB。
- **失败判断**：CLI 绕过 Backend、target 解析错误、存在任意 `--event-name/--payload-json` 入口、允许伪造 verification/Agent Team identity，或存在本地 hidden DB/spool。
- **验证方式**：Backend access log、CLI JSON 输出、`lsof`、SQLite row。

### ADF-006 Backend 不可达时明确失败且不伪造补传

- **Given**：CLI/外部 adapter 已配置一个 Backend profile，随后停止该 Backend。
- **When**：尝试提交一个事件，等待超过所有客户端 retry 窗口后重启 Backend。
- **Then**：命令以非零码明确报告“未记录”；DB 不出现该事件；重启后新事件可以正常写入；没有自动创建 daemon 或隐式 spool。
- **失败判断**：命令返回成功但 DB 无 row、重启后凭空出现事件、或客户端自动启动新服务。
- **验证方式**：CLI stdout/stderr/exit code、进程树、重启前后 SQLite 查询。

### ADF-007 Activity 不依赖 App Server 生命周期

- **Given**：App Server 未启动或显式停止，Backend 与 Activity DB 可用。
- **When**：通过 Backend 内部 producer 和 CLI 写入并查询。
- **Then**：写入和查询成功；没有读取 App Server lock/token/JSONL；启动或停止 App Server 不改变 Activity rows。
- **失败判断**：App Server 不可达导致 Activity unavailable，或行为事实写入 `app-server-events.jsonl`。
- **验证方式**：App Server status、Backend API、文件 hash/mtime、SQLite row。

### ADF-008 Event schema、producer allowlist 与字段来源

- **Given**：准备 managed Hook、external Hook、Electron、shell 四个专用 route 的有效事件，以及未知 event/version、超限 payload、伪造 actor/runtime/TTL/privacy、错 route namespace、generic batch route、Electron 无/过期 Bearer 请求，并构造 16/17 个 owned descriptor 与 `ownedMutationBytes` 恰好低于/超过 8 MiB 的边界。
- **When**：分别通过 `/internal/activity/hook-events/batch`、`/api/activity/hook-events/batch`、`/api/activity/electron-events/batch`、`/api/activity/shell-command-events/batch` 提交；Electron 复用既有 login 在 401 后重新登录。
- **Then**：只有匹配 route allowlist 且 ≤16 descriptors/≤8 MiB conservative budget 的事件 commit；`owned_mutation_bytes` 由 Store 根据最终 row/BLOB/link/index allowance 计算并写入不可变 Fact，Producer 不能自报；Electron token 只在内存；其它请求以闭集 reason 拒绝并写 `ingest_rejections` metadata；generic `/events/batch` 不存在。
- **失败判断**：generic `payload:any` 落库、CLI/Hook 伪造 Electron/verification/Agent Team identity、Producer 延长 TTL/降低 privacy/自报 size、用多个 Content 绕过 8 MiB total、Tunnel Auth 被误当 Electron 身份，或拒绝原文被保存。
- **验证方式**：API 状态/错误码、Facts query、`ingest_rejections` 行。

### ADF-009 重复投递幂等且冲突不可覆盖

- **Given**：固定 eventId、producer instance/boot/sequence 和 canonical payload。
- **When**：相同 batch 提交 10 次，再使用相同 ID/sequence 提交不同 payload，并尝试 UPDATE 已提交 Fact 的 project/thread/payload 及 Content/Ref owner 四元组。
- **Then**：相同输入只存在 1 个 Fact/Content/link 并返回 duplicate；冲突输入返回 `idempotency_conflict`，原 row/fingerprint 不变；immutable triggers 拒绝 Fact UPDATE 和 Content/Ref owner 迁移。
- **失败判断**：重复 row、Content orphan、冲突覆盖、Fact scope 可被更新、或把不同内容当成功 retry。
- **验证方式**：API ACK、SQLite count/hash/link/FK 查询。

### ADF-010 Fact、Content、Ref 与 gap 更新事务原子

- **Given**：一个包含 Fact、Content、ExternalRef 和 sequence advance 的 batch，并在各写阶段注入失败。
- **When**：执行失败事务后再以相同 ID 重试完整事务。
- **Then**：失败后四类 row 都未部分出现，producer cursor 未提前；重试后一次性完整 commit。
- **失败判断**：Fact 有但 Content/link 缺失、cursor 跳过、orphan row 或重试冲突。
- **验证方式**：fault-injection integration script + FK/count 查询。

### ADF-011 三个 Backend 并发 WAL 写入无损

- **Given**：三个独立 Backend process 各有一个 SQLite worker/connection，共享 DB；WAL、foreign keys、busy timeout 已启用。
- **When**：每进程持续 50 events/s 写 10 分钟，同时页面执行 keyset query 和 passive checkpoint。
- **Then**：总 row 数、每 producer sequence 和提交 ACK 完全一致；无 corruption/duplicate/unreported busy loss；reader 不阻塞 writer 超过预算。
- **失败判断**：`database is locked` 泄漏给正常负载、row 丢失、FK 错误、WAL 损坏或查询长时间阻塞。
- **验证方式**：多进程 harness、ACK manifest、`integrity_check`、`foreign_key_check`、延迟分位。

### ADF-012 Schema migration 与版本错位 fail-closed

- **Given**：`user_version=major*1000+minor` 的旧 minor、当前 minor、同 major 未来 minor、未来 major DB，以及两个 Backend 同时尝试 additive migration。
- **When**：分别启动当前/前一 minor fixture Backend，并强制交错“旧 writer 尝试写”与“新 Backend 尝试 major migration”：覆盖 migration 先拿锁、writer 先拿锁两种顺序。
- **Then**：minor migration 只由一个 `BEGIN EXCLUSIVE` 成功执行；普通 writer 先 `BEGIN IMMEDIATE`，在同一事务内 gate version 后再写；同 major 前一 minor 可继续写，未来 major 只禁用 Activity 并返回 `activity_schema_too_new`，不影响 Terminal；migration 不可能插入 gate/INSERT 之间。
- **失败判断**：双迁移、部分 DDL、同 major 前一 writer被无故禁用、旧 writer 越过 major gate、出现 version-check TOCTOU，或整个 Backend 因 Activity version 退出。
- **验证方式**：multi-process migration harness、schema dump、Backend health/API。

### ADF-013 Backend 崩溃后只恢复已 commit 事务

- **Given**：一批已 commit 事件和一批事务中事件。
- **When**：在事务中强杀 writer，再重启任一 Backend。
- **Then**：SQLite WAL recovery 保留全部已 commit row，未 commit batch 完全不存在；新写入继续；integrity/FK check 通过。
- **失败判断**：半事务、已 commit 丢失、未 commit 被误报成功、自动从 JSONL/业务库补造。
- **验证方式**：kill harness、ACK manifest、SQLite checks、重启 API。

### ADF-014 Maintenance lease 用 fencing 阻止 stale owner 继续删除

- **Given**：三个 Backend 的 retention timer 同时触发，lease 初始为空；owner A 取得 token 1 后暂停超过 TTL，owner B 接管取得 token 2，随后 lease 再过期并由原 owner A 重新取得。
- **When**：B/A 分别执行 sweep，同时恢复最初持有 A/token1 的旧任务并让它 renew、删除和更新 sweep 状态；另并发触发 passive checkpoint 与 retention sweep。
- **Then**：固定 lease row 永不物理删除；每次 acquire/takeover 原子递增，原 owner A 再取得时必须是 token 3 而不是重建 token 1；每个删除 batch 在同一 `BEGIN IMMEDIATE` 中校验 owner+token+未过期状态；所有 stale task 以 `activity_maintenance_lease_lost` 失败且 0 mutation，当前 owner 每批最多删除 1000 rows；SQLite checkpoint lock 不阻塞正常写入。
- **失败判断**：过期 lease 被 sweep 删除、fencing token 重置/ABA、stale A/token1 继续删除、两个 owner 持有相同 token、误删未过期数据或 checkpoint 阻塞写入。
- **验证方式**：pause/resume 多进程 harness、lease/fencing/sweep rows、process logs、删除计数、WAL size。

### ADF-015 P0 事件只从可靠业务边界产生

- **Given**：为 14 个 P0 family 准备各自真实来源动作，并准备被排除的 focus/retry/connection/file/git/interrupt/turn/automation/review 动作。
- **When**：逐一执行来源动作并查询 Facts。
- **Then**：P0 family 的 event、scope、actor、result、payload/ref 均来自计划定义边界；被排除动作没有同名事实；不存在日志文本推断。
- **失败判断**：不存在业务边界的事件被记录、reported result 升级为 verification，或来源字段和计划不一致。
- **验证方式**：真实 Backend/Electron/Hook/Agent Team/runner 证据 + Facts rows。

### ADF-016 外部 TTY 覆盖边界诚实

- **Given**：一个未安装任何 integration 的外部 TTY、一个显式配置 `rw activity record agent-hook --profile ...` 的 Agent TTY、一个安装受控 zsh adapter 的 shell TTY。
- **When**：分别执行同样的 Query/command。
- **Then**：未集成 TTY 不产生伪事实；显式 Agent Hook 只记录真实 UserPromptSubmit/Stop/tool 事件，zsh adapter 只记录 command started/completed；Sources 清楚区分 active/inactive/last seen。
- **失败判断**：从 scrollback 猜出命令、宣称未集成 TTY 已覆盖、或 Bash/fish 未验收却标 active。
- **验证方式**：TTY transcript digest、Backend access log、Facts/Sources 页面。

### ADF-017 关联只使用显式 ID 且高基数查询命中索引

- **Given**：两个时间相近但 interaction/thread/run 不同的事件链、一组缺失 interactionId 的事件，以及含 3,000,000 Facts 的高基数 project/runtime/correlation fixture。
- **When**：分别调用 `selector=interaction|correlation|thread|run&id=...`，执行 CLI 四个互斥 selector，并查询 project、runtime+surface 的最近 10,000 条 keyset page；采集 `EXPLAIN QUERY PLAN` 与 p95。
- **Then**：四种 selector 都只返回精确 ID 范围；两条链不合并；缺 ID 事件显示 `unlinked`；duration/count 只对相同 operation/correlation 计算；零个或多个 selector 都返回 400/CLI exit 2；correlation/project/runtime+surface 查询命中对应复合索引且 p95 < 500 ms。
- **失败判断**：API/CLI 只支持 correlation、按时间窗口归 Task、把相邻事件错误串联、UI 隐藏未关联事实、高基数查询全表 scan 或超预算。
- **验证方式**：3M fixture + API/UI timeline + `EXPLAIN QUERY PLAN` + latency histogram。

### ADF-018 Sequence gap、已知 drop 与 rejection 可区分

- **Given**：提交 sequence 1、3；随后补 2；另触发 Backend 已知 queue/policy drop 和 schema reject。
- **When**：依次查询 Sources 和 Facts。
- **Then**：1→3 产生 unknown open gap，2 到达后关闭；只有已知 drop 产生 `source.events_dropped` 和 reason；schema reject 只进 `ingest_rejections`，不进 Facts。
- **失败判断**：未知 gap 被编造原因、late event 改写 activityOffset、reject 污染 Facts。
- **验证方式**：API、source_gaps/producer_instances/rejections/Facts rows。

### ADF-019 7 天 Content 与 30 天 Fact 分别过期

- **Given**：使用可控 clock 写入带 Content/Ref 的 6d23h、7d、29d23h、30d 边界数据、stale/active producer、gap、rejection、access audit、已完成到期/未到期和 pending/blocked delete job；另注入一个“completed 但仍残留 scope row”的 invariant fixture，并包含 occurredAt 早于 ingest 的迟到数据。
- **When**：取得 retention lease 执行 sweep。
- **Then**：TTL 锚点是 `min(occurredAt, ingestedAt)`；7 天 Content 清密文、到期 Ref 清 locator 并留 tombstone；Fact 到 30 天才删除并 cascade link 与它独占的 Content/Ref descriptor；相同内容/locator 的新 Fact 创建独立 owner row，不延长旧 row TTL；到期 gap/rejection/audit、完成后满 30 天且 scope+cutoff 已无 Fact 的 delete job 和无 FK 的 stale producer被删除；未到期 completed、残留 row 的 invariant job、所有 pending/running/blocked job和 active producer 保留，残留 job 继续遮蔽查询并报告错误；异常 orphan 被物理清理。Fact delete 的 `source_event_id` SET NULL 和 producer FK 检查都命中 child-key index，无 `source_gaps` full scan。
- **失败判断**：replay/迟到或相同内容的新 Fact 重置旧 row TTL、正文过期同时删 Fact、到期密文/locator 仍可读取、source/rejection/audit/completed job/stale producer 永久残留、未完成 delete job 被 TTL 清除、owner cascade 后 orphan 残留、或未到期/仍有 FK 数据被删。
- **验证方式**：clocked integration script、SQLite FK/link/orphan count、source_gaps FK `EXPLAIN QUERY PLAN`、API availability 查询。

### ADF-020 Secret、正文、locator 与共享 Keychain key 的存储边界

- **Given**：Query、回复、命令、tool JSON、URL、ExternalRef locator 中混入 token/cookie/password/private key/`.env` 内容；三个 Backend 首次同时初始化空 Keychain/DB。
- **When**：通过所有允许入口提交并执行 export/query，再重启三个 Backend 解密同一 Content。
- **Then**：禁止 secret 被拒绝或脱敏；正文只在加密 BLOB；locator 加密；`payload_json`、indexes、logs、export metadata 不含明文；三个 Backend 通过 `BEGIN EXCLUSIVE` 只创建/使用同一个 `com.runweave.activity/content-key-v1`，key 不进 argv/env/DB/log，重启后均能解密。
- **失败判断**：DB/WAL/SHM/API/export/log 可搜索到 secret 或原始 locator，多 Backend 生成不同 key，或 key 出现在进程参数/环境变量。
- **验证方式**：secret fixture、并发初始化 harness、文件 byte scan、进程参数/env scan、API/export、Keychain reference metadata。

### ADF-021 文件权限与 API 登录鉴权

- **Given**：本机和 LAN 客户端分别准备有效 Bearer、无 Bearer、错误 Bearer 与错误 Hook Token 请求。
- **When**：访问 metadata/content/export/delete 与 managed Hook、external Hook、Electron、shell 四个专用 write routes。
- **Then**：目录为 `0700`，DB/WAL/SHM 为 `0600`；本机和 LAN 请求均只按现有登录/Hook 鉴权判断，有效身份成功，无身份或错误身份拒绝。
- **失败判断**：已登录请求因来源地址被额外拒绝、无身份请求成功、任意 route 无身份写高可信事件，或文件可被其它用户读取。
- **验证方式**：stat、Backend/Vite HTTP auth matrix、network origin evidence。

### ADF-022 Facts 页面展示 Recorded 与 Computed 而不混淆

- **Given**：准备多 runtime/surface/project/thread/result 的 Fact、过期 Content、missing Ref 和可计算 duration。
- **When**：用 `$playwright-cli` 打开 `/activity`，过滤、排序、翻页并打开详情。
- **Then**：过滤与 API 一致；原始字段标 Recorded，duration/count 标 Computed；过期/missing 明确；没有模型生成字段。
- **失败判断**：把 Computed 写成 Fact、正文缺失显示空成功、offset pagination 重复/漏 row。
- **验证方式**：`$playwright-cli` DOM/snapshot + API 对照 + console。

### ADF-023 Timeline 在并发写入时保持冻结阅读窗口

- **Given**：一个 200 事件 interaction，另有 Backend 持续追加新事件。
- **When**：打开 timeline 第一页取得 `asOfActivityOffset`，继续翻页。
- **Then**：本次阅读只返回 `<= asOfActivityOffset` 的行，keyset 无重复/漏失；显式 causation/parent 可展开，unlinked 独立显示。
- **失败判断**：新写入导致翻页漂移、使用 occurredAt 作为增量 cursor 漏迟到事件。
- **验证方式**：并发 writer + `$playwright-cli` + API page manifest。

### ADF-024 Sources 页面提供可核对分母

- **Given**：healthy、open gap、closed gap、rejection、busy error、inactive 五类 producer 状态。
- **When**：打开 Sources 并与数据库/counters 对照。
- **Then**：显示 instance/boot/version/channel/surface、highest seen/contiguous、gap ranges、rejections、last seen/latency/error、WAL/checkpoint；不显示无法证明的“98% coverage”。
- **失败判断**：只给百分比无分母、把 Backend 未收到的期间标为完整、或隐藏错误。
- **验证方式**：`$playwright-cli` + producer_instances/source_gaps/rejections 对照。

### ADF-025 Data Policy 的删除与导出使用普通登录鉴权

- **Given**：Project A 有足以触发多批次的 3,000,000 Facts 和大量关联 source_gaps，Project B 有 bytes/locator 相同但 owner 独立的 Content/ExternalRef；另准备未登录/已登录请求、正常/失败 audit、并发 retention、三 Backend writer 和可暂停的 delete owner。
- **When**：未登录和已登录分别直接调用 `POST /api/activity/operations` 执行 export/delete；成功 delete 后尝试 UPDATE job 的 scope/cutoff/auth/digest、倒退 cursor/count或把 completed 复活，再立即查询；持续三 Backend 各 50 events/s，依次 kill owner、停止全部 Backend、再启动一个 Backend；分别注入 Content/export/delete requested/completed audit failure。
- **Then**：未登录返回 401；已登录 export 单次请求返回当前 snapshot，已登录 delete 单次请求在 500 ms 内提交 `pending job + delete_requested audit` 并返回 202。job scope/cutoff/auth/digest 不可更新，progress trigger 拒绝 cursor/count/time 倒退、非法状态转换与 completed 复活；job commit 后查询立即隐藏 cutoff 内目标；runner 每事务 ≤1000 Facts 且 owned mutation bytes ≤8 MiB，crash 后由新 owner 从最后 cursor 续跑，最终目标 rows/owned Content/Ref 为 0、新 Fact 与 B 不变，并有 delete_completed audit。
- **失败判断**：仍要求 preview/confirmation ticket、已登录普通请求不能执行、未登录可执行、delete 请求扫描/删除全 scope或持 writer lock >500 ms、job 前数据仍可查询、跨 cutoff/Project 删除、batch 越界、crash 后从头/永久停滞、audit 失败仍返回 body/创建 job/报告完成，或 username/正文/token 出现在 argv、URL、log、config、audit。
- **验证方式**：Stable/Beta/Dev API/CLI/UI、3M fixture、未登录/已登录矩阵、job pause/kill/takeover harness、cursor `EXPLAIN QUERY PLAN`、writer latency/ACK manifest、before/after SQLite owner/FK/count、audit rows 与 export scan。

### ADF-026 第一阶段没有 Task/Goal/Outcome/Learning

- **Given**：完整的 Facts/Timeline/Sources/Data Policy 数据集。
- **When**：遍历 Activity 页面、API schema 和 `activity.sqlite` tables。
- **Then**：没有 Task grouping、Goal/Outcome、Rework、Candidate、Generate、Published Learning 或 Learning 表；未来说明明确指向独立 `learning.sqlite` 和另行计划。
- **失败判断**：页面查询自动触发模型、模型产物混入 facts，或在 activity DB 预建假 Learning 数据。
- **验证方式**：`$playwright-cli` 全页面巡检、route/schema/table 清单。

### ADF-027 Node/Electron 双 ABI SQLite 产物在三种 runtime 可加载

- **Given**：`electron/package.json` 的显式 rebuild 依赖、被 `.gitignore` 排除的 staging root、workspace Node binding、独立 staged Electron binding、unpacked/packaged App Resources 和一个已安装 external runtime release；记录 Node/Electron ABI 与所有 binding hash/path。
- **When**：执行 staging + package；验证 bundled/external manifest 的 schema/platform/arch/ABI、四个 role path、排序 `files[]` 和 `treeSha256`；分别从三种 runtime 启动真实 worker 写读同一临时 WAL DB，再切换/回滚 external runtime，并逐一新增/删除/篡改 worker、entry、package manifest、native binding 和任一非入口 transitive JS 文件。
- **Then**：Node 与 Electron artifact 位于不同物理目录且 ABI 匹配；`.native-artifacts/` 无 tracked file；manifest 文件集合与 staging runtime 闭包完全相等且每个 regular file 有 size/hash；packaged/external resolver 在 Backend spawn 前全量扫描并校验逐文件/tree hash；三条路径及回滚成功，不依赖 repo cwd/NODE_PATH；任一树差异均 fail closed 且只禁用 Activity。
- **失败判断**：缺 rebuild dependency、staging 被提交、electron-rebuild 覆盖 Node binding、bundled manifest 未由构建生成、只校验四个入口、漏掉 transitive JS/symlink/额外文件、Resources/external release 文件集合或 ABI/hash 不匹配后仍 spawn，或 rollback 后 require 失败。
- **验证方式**：`scripts/verify-activity-sqlite-runtime.mjs` + unpacked/packaged App + external runtime install/rollback 证据。

### ADF-028 Activity 全故障不能反向破坏主业务

- **Given**：依次注入 `SQLITE_BUSY` 超时、`SQLITE_FULL`/5GB quota、corrupt/FK failure、native binding missing/ABI mismatch、Keychain unavailable，并准备 Terminal create/delete、Agent Team transition 和 Browser navigation 三类主业务动作。
- **When**：每种 Activity 故障下分别执行三类业务动作和 Activity query。
- **Then**：主业务按自身结果成功/失败，不被 Activity 记录异常改写；Activity 返回明确 unavailable/reject/error，写 diagnostic metadata，且不伪造 Fact/ACK；恢复后新事实可写，损坏库不会从日志/业务库补造。
- **失败判断**：Activity 异常导致 Terminal/Agent Team/Browser 额外失败或进程退出、调用方收到假成功、静默换新 DB、或已有数据被覆盖。
- **验证方式**：fault-injection integration harness + 主业务 API/Electron evidence + Activity/diagnostic/SQLite 对照。

### ADF-029 User Query 只有 Hook 单一权威 emitter

- **Given**：在 Runweave Terminal 中通过 Web/CLI `terminal send --agent` 发出 Query，随后 Agent 触发一次 `UserPromptSubmit`；另准备 Hook transport retry。
- **When**：观察 Backend send 边界、Hook 写入和最终 Facts。
- **Then**：Backend send 不产生 `user.query.submit_requested`；Hook 首次观察时生成唯一 event/interaction，transport retry 复用同一 identity；最终只有 1 个 Query Fact。
- **失败判断**：Backend send 与 Hook 各写一条、CLI 手工伪造 Query、或传输 retry 生成新 eventId。
- **验证方式**：Backend/Hook structured evidence、API/SQLite count 与 fingerprint。

## 覆盖矩阵

| 需求                                  | 用例                               |
| ------------------------------------- | ---------------------------------- |
| 不新增服务、复用 Backend              | ADF-001、ADF-006、ADF-007          |
| 独立 SQLite、跨 Runtime 集中          | ADF-002、ADF-003、ADF-004          |
| CLI/外部来源只经 Backend              | ADF-005、ADF-006、ADF-016          |
| schema、字段来源、可靠事件            | ADF-008、ADF-015、ADF-017、ADF-018 |
| 多进程 SQLite、幂等、原子、迁移、恢复 | ADF-009～ADF-014                   |
| 7/30 天、隐私、权限                   | ADF-019～ADF-021、ADF-025          |
| Facts/Timeline/Sources/Data Policy UI | ADF-022～ADF-025                   |
| 第一阶段不做 Learning                 | ADF-026                            |
| SQLite native runtime/双 ABI          | ADF-027                            |
| 主业务故障隔离                        | ADF-028                            |
| Query 单一权威入口                    | ADF-029                            |

## 验收通过标准

以下条件必须同时满足：

1. ADF-001～ADF-029 全部有真实证据且通过。
2. 三个 Backend 并发共享同库 10 分钟无丢失、重复、corruption 或未报告 busy failure。
3. CLI/Browser/Electron/Hook 不直接打开 SQLite；没有新 Activity 服务、端口或发现文件。
4. `integrity_check`、`foreign_key_check`、schema version、retention 和 security matrix 通过。
5. `$playwright-cli` 验证四个页面视图，console error 为 0；静态检查不替代此项。
6. 正式 `~/.runweave/activity/` 未被自动化测试污染，artifact 中无敏感正文。

## 执行记录

- 2026-07-11：依据用户新边界重写计划与测试合同；当前只完成文档/原型设计，功能代码与本文件用例均未执行。
- 2026-07-12：完成 P0～P4 功能实现与以下真实证据：
  - `pnpm activity:verify`：3 个独立进程首次并发初始化并共享 WAL，任一 Store 可见 300 Facts；幂等/冲突、sequence gap close、Content DLP+解密、冻结 export snapshot、Activity-key audit HMAC、7/30 天留存、delete cutoff、单 active job、blocked→恢复、maintenance fencing、低配额下丢弃 Content 但保留 metadata Fact、Verification 禁用、future schema fail-closed、`0700/0600` 权限全部通过。
  - `RUNWEAVE_ACTIVITY_PACKAGED_RESOURCES=... RUNWEAVE_ACTIVITY_EXTERNAL_RELEASE=... node scripts/verify-activity-sqlite-runtime.mjs`：workspace Node、Electron staged binding、packaged Resources、external runtime release 四条路径通过，Electron 版本为 `33.4.11`。
  - `pnpm toolkit:verify-hooks`：Toolkit Hook 源与 Electron Resources 同步，Query/Response 与 PreToolUse tool ID/name/input 显式字段随 Hook 投递且 App Server 不构成依赖。
  - 真实隔离 Backend `127.0.0.1:5129` + Frontend `127.0.0.1:5189`：`playwright-cli` 验证 Facts、Recorded detail、短期 Content、Sources、Data Policy 与 delete completed polling；console error 为 0，证据截图为 `artifacts/activity-real-ui.png`。
  - 真实 CLI：record started/completed 均返回 committed；facts/sources 在 `--plain` 下仍输出合法 JSON；不可达 Backend 退出码为 1 且明确输出 `Activity event was not recorded`。
  - 产品原型 `docs/prototypes/system-activity-data-foundation/` 和架构流程 `docs/architecture-flows/system-activity-data-foundation-flow/` 已用 `playwright-cli` 遍历全部视图/场景，console error 为 0。
  - 仓库门禁：`pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm architecture:check`、`git diff --check` 全部通过；架构报告为 `over600=0`、runtime/type-only cycle `0/0`。
- 尚未执行，因此不得标记 ADF-001～ADF-029 全量通过：ADF-013 的 3 Backend × 50 events/s × 10 分钟；ADF-016/023/025 的 3,000,000-row 性能与完整 snapshot/delete race；ADF-025 的完整 token/audit/crash/blocked/takeover 矩阵；ADF-028 的真实 `SQLITE_FULL`/corrupt/Keychain 故障矩阵；真实 Stable/Beta Desktop 并行与 external runtime rollback 安装流程。上述项目保持上线阻断门禁。
