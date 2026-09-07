# Runweave 运行状态面板实施计划

> 状态：已实现并完成 required 验收
> 粒度：L3（跨 shared、Backend、App Server、Electron、CLI、Frontend 与真实桌面验收）
> 代码基线：`main@75938f19`
> 配套测试计划：
> `docs/testing/platform/runtime-status-providers.testplan.yaml`、
> `docs/testing/runbooks/runtime-status-panel.testplan.yaml`

## 结论

在现有 `RuntimeMonitorBadge` 基础上建设统一的操作型运行状态入口，而不是引入传统监控平台。
各运行时只判断自己拥有的运行依赖，通过统一合同提供当前状态；Frontend 定时拉取 Electron、本机
Backend 和当前连接 Backend 的报告，合并为节点视图。右上角常显当前连接地址与整体状态，点击地址
复制完整 URL，点击其余区域打开右侧抽屉。

状态按真实故障边界注册，按用户可理解的能力域聚合。单次失败只进入“恢复中”；拥有者的重试或
宽限策略耗尽后才进入异常。上游异常时，下游显示“无法判断”，不重复计数或提醒。第一版只提供
查看、复制、重新检查和导航，不增加启停、重启、终止或自动修复能力。

## 当前代码事实

| 领域               | 当前事实                                                                                               | 本计划差异                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| 右上角入口         | `frontend/src/components/runtime-monitor-badge.tsx` 仅在 Electron 展示 CPU/内存，并使用小型 Dropdown   | 升级为 Web/Electron 都可用的运行状态入口，主信息改为连接地址与健康状态，展开使用右侧 Sheet  |
| 资源监控           | `useElectronRuntimeStats` 每 2 秒通过 IPC 取 Electron/Backend 资源，`/system-monitor` 展示详细系统资源 | 保留资源采样与 System Monitor；CPU/内存只作为抽屉次级信息，不参与异常计数                   |
| 节点连接           | Electron 连接管理器保存多个 Backend；`/health` 无业务鉴权，`/api/*` 使用 Bearer Token                  | 只观察本机节点和当前连接节点，以 Backend `serviceInstanceId` 去重；新增受保护状态快照 API   |
| Terminal 实时链路  | `/ws/terminal` 最多自动重连 5 次；`/ws/terminal-events` 持续指数退避，但其状态目前未进入全局 UI        | 两条连接分别注册；保留原重连策略，不为监控再建立 WebSocket                                  |
| Workspace Services | Manager 已拥有 `stopped/starting/ready/stopping/failed`、目标端口、稳定 URL 和具体错误                 | 直接投影已有状态；停止/未配置为中性，启动中为恢复中，失败为异常                             |
| App Server         | 独立 singleton，提供 `/healthz`、`/readyz`、事件流、sync 状态和 30 秒 Thread reconciler                | App Server 提供自己的标准报告；Backend 只转发报告并单独报告自身 event consumer 状态         |
| Feishu Bridge      | `rw feishu bridge` 持有单实例 lease；Lark WS 与 Backend 校验每 15 秒检查，断开 120 秒后重建            | Bridge 用现有认证向 Backend 上报脱敏状态；不把真实消息投递结果纳入面板                      |
| Electron 本地设施  | packaged Backend、CDP Proxy、Companion 和每个 Profile 的 Whistle 都已有生命周期状态                    | Electron 通过窄 IPC 提供本机报告与可供手机连接的 LAN 地址，不让 Frontend 读取主进程内部状态 |
| 后台任务           | Agent Team watchdog、Evolution recovery/lease、App Server reconciler 均有自己的周期与错误处理          | 在对应拥有者内部记录最近开始、成功、失败和心跳时间，不由中央组件从日志推断                  |

现状入口：

- `packages/shared/src/monitoring/runtime.ts`
- `packages/shared/src/desktop/bridge.ts`
- `backend/src/index.ts`
- `backend/src/bootstrap/runtime-services.ts`
- `backend/src/app-server/event-consumer.ts`
- `backend/src/evolution/runtime.ts`
- `backend/src/agent-team/service/recheck.ts`
- `backend/src/terminal/workspace-service/manager.ts`
- `app-server/src/index.ts`
- `app-server/src/server/http.ts`
- `app-server/src/state/reconciler.ts`
- `packages/runweave-cli/src/commands/feishu.ts`
- `packages/runweave-cli/src/feishu/bridge-runtime.ts`
- `electron/src/main.ts`
- `electron/src/backend/packaged/controller.ts`
- `electron/src/browser/whistle/runtime.ts`
- `electron/src/companion/agent.ts`
- `frontend/src/App.tsx`
- `frontend/src/features/terminal/connection/use-connection.ts`
- `frontend/src/features/terminal/connection/use-events.ts`

## 目标

1. 用户在主要页面右上角持续看到当前连接节点的可复制完整 URL 和整体运行状态。
2. Desktop 展示本机节点；当前连接是另一节点时再展示相同结构的当前节点；两者身份相同时合并。
3. 用户展开右侧抽屉后，先看到能力域，再展开查看真实进程、端点、连接、心跳和周期任务状态。
4. 每个状态来源保留自己的健康语义和恢复策略；只有恢复策略耗尽的稳定异常才计数和提醒。
5. 一个上游故障只形成一个根因异常，下游依赖统一显示为“无法判断”。
6. 前台稳定异常显示一次非阻塞提示；Electron 窗口隐藏或失焦时显示一次系统通知。
7. 首版覆盖节点、Terminal、飞书、App Server、Workspace Services、Electron 本地设施和关键后台任务。
8. 状态 API、IPC 与报告不泄露 token、secret、完整命令、用户消息或原始日志。

## 非目标

- 不建设指标时序库、历史趋势、Tracing、日志搜索、SLO 或通用告警规则平台。
- 不自动发送飞书消息、写入 Terminal 或用其他有副作用的业务操作证明健康。
- 不在状态面板里启动、停止、重启、终止或自动修复任何服务；既有控制入口保持不变。
- 不新增状态专用 WebSocket、独立 daemon 或第二套进程管理器。
- 不把 CPU、内存高低直接解释为运行异常；System Monitor 继续拥有资源诊断。
- 不主动监控其他已保存但未选中的远程连接。
- 不在第一版为 Ionic `app/` 新增面板；共享 Backend 合同允许后续单独接入。
- 不持久化状态历史或提示历史；只保留当前报告、当前页面会话内的转移去重和最后已知状态。
- 不新增单元测试或测试代码；使用现有静态门禁、YAML 验收合同和真实进程/UI 取证。

## 用户可见行为

### 右上角入口

1. 入口主信息为当前连接节点地址和整体状态，不再以 CPU/内存为主摘要。
2. 地址区域点击后复制完整 `http(s)://host:port`；其他区域点击后打开右侧状态抽屉。
3. 当前节点是本机时，优先展示手机可访问的 LAN IPv4 地址；不把 `127.0.0.1` 表达为手机可用。
4. 当前节点是远程时，展示连接管理器中实际使用的 URL；本机 LAN 地址仍在本机节点卡片中可复制。
5. 地址不可达时保留原值并标红；没有可用 LAN 地址时显示“仅本机可用”。
6. IP 或端口在保持可用的情况下变化只更新文本，不触发异常提示。
7. 入口显示异常能力域数量，而不是底层异常状态项数量。

### 右侧抽屉

1. 抽屉不离开当前页面，使用现有 `Sheet`，宽度能够同时容纳节点卡、能力域与状态项详情。
2. Desktop 始终显示本机节点；当前连接不是本机时再显示当前节点。Web/PWA 只显示当前节点。
3. 本机与当前节点用 Backend `serviceInstanceId` 去重；无法取得身份时才按规范化连接 URL 回退。
4. 节点卡结构一致，只通过“本机”“当前连接”标签表达上下文，不维护两套字段或组件。
5. 一级按 `节点连接 / Terminal / 飞书接入 / App Server / Workspace Services / Desktop / 后台任务`
   分组；二级显示独立状态项、摘要、最后观察时间、恢复进度、可复制事实和导航目标。
6. 抽屉提供“重新检查”，它只立即重新拉取无副作用的当前报告，不重置服务、不发消息、不写 Terminal。
7. CPU/内存显示在本机节点的次级区域，并提供 `/system-monitor` 导航，不影响任何状态颜色或计数。

### 状态与提醒

统一展示状态为：

| 状态           | 展示                                 | 计入异常         | 触发提醒         |
| -------------- | ------------------------------------ | ---------------- | ---------------- |
| `healthy`      | 绿色“正常”                           | 否               | 否               |
| `recovering`   | 黄色“恢复中”，显示尝试次数或持续时间 | 否               | 否               |
| `unhealthy`    | 红色“异常”                           | 是，按能力域去重 | 仅稳定转入时一次 |
| `blocked`      | 灰色“无法判断”，显示上游根因         | 否               | 否               |
| `checking`     | 中性“检查中”                         | 否               | 否               |
| `unconfigured` | 中性“未配置”                         | 否               | 否               |
| `disabled`     | 中性“已停用”                         | 否               | 否               |
| `unsupported`  | 中性“版本不支持”                     | 否               | 否               |

聚合优先级固定为
`unhealthy > recovering > checking > blocked > healthy > unconfigured > disabled > unsupported`。
只有 `unhealthy` 能增加右上角数字。首次载入一个已经异常的快照只高亮，不弹提示；同一页面会话内，
只有从非异常稳定转入异常时提示一次。恢复后再次异常可以再次提示。

当 Backend 不可达时，Frontend 生成“节点连接”根因异常；最后已知的 Backend、App Server、飞书和
后台任务状态全部转为 `blocked`，但 Electron 仍可直接取得的本机状态继续判断。Backend 恢复后立即
重取报告，下游只有在自身宽限期结束后仍失败才独立变红。

## 共享协议

### 类型与身份

新增 `packages/shared/src/monitoring/runtime-status.ts`，并只通过
`@runweave/shared/runtime-status` 明确子路径导出，避免扩大根入口浏览器 bundle。

核心合同固定为：

```ts
type RuntimeStatusState =
  | "healthy"
  | "recovering"
  | "unhealthy"
  | "blocked"
  | "checking"
  | "unconfigured"
  | "disabled"
  | "unsupported";

type RuntimeStatusCapabilityId =
  | "node"
  | "terminal"
  | "feishu"
  | "app-server"
  | "workspace-services"
  | "desktop"
  | "background-tasks";

interface RuntimeStatusRecovery {
  startedAt: number;
  attempt: number | null;
  maxAttempts: number | null;
  nextAttemptAt: number | null;
  deadlineAt: number | null;
}

interface RuntimeStatusFact {
  id: string;
  label: string;
  value: string;
  kind: "address" | "port" | "text" | "time";
  copyable: boolean;
}

interface RuntimeStatusNavigation {
  label: string;
  route: string;
}

interface RuntimeStatusItem {
  id: string;
  capabilityId: RuntimeStatusCapabilityId;
  label: string;
  state: RuntimeStatusState;
  summary: string;
  observedAt: number;
  dependsOn: string[];
  recovery: RuntimeStatusRecovery | null;
  facts: RuntimeStatusFact[];
  navigation: RuntimeStatusNavigation | null;
}

interface RuntimeStatusSource {
  id: string;
  runtime: "frontend" | "backend" | "electron" | "app-server" | "feishu-bridge";
  instanceId: string;
  capabilityId: RuntimeStatusCapabilityId;
}

type RuntimeStatusTarget =
  | { kind: "node"; nodeId: string }
  | { kind: "local-host" };

interface RuntimeStatusReport {
  protocolVersion: 1;
  target: RuntimeStatusTarget;
  source: RuntimeStatusSource;
  observedAt: number;
  validForMs: number;
  items: RuntimeStatusItem[];
}

interface RuntimeNodeStatusSnapshot {
  protocolVersion: 1;
  generatedAt: number;
  node: {
    id: string;
    serviceInstanceId: string;
  };
  reports: RuntimeStatusReport[];
}
```

实现者可把纯显示常量和聚合函数放在同一文件，但不得改变以下语义：

- `id` 在同一节点内稳定且包含拥有者前缀；动态资源在后缀中使用稳定 project/session/profile identity。
- Backend 自身报告使用真实 `node` target；最初不知道 Backend 身份的 Electron 与 App Server 使用
  `local-host` target，不得伪造 `nodeId`。
- `dependsOn` 引用同一节点中的状态项 ID；依赖不存在时不得把状态误判为健康。
- `validForMs` 只决定报告来源是否过期，不代替拥有者自己的重试策略。
- 状态事实已经是可展示、可复制的脱敏值；Frontend 不接收任意 JSON、日志或命令。
- `navigation.route` 只接受应用内绝对路径；状态协议不提供 URL scheme、shell command 或远程控制动作。
- 聚合、过期判断和因果抑制写成不依赖 DOM/Node 的纯函数，供 Backend 与 Frontend 复用。

### HTTP 与 IPC

Backend 新增：

- `GET /api/runtime-status`：需要现有 Bearer Token，返回当前 Backend 节点快照。
- `PUT /api/runtime-status/reports/feishu-bridge`：需要现有 Bearer Token，只接收
  `source.runtime === "feishu-bridge"` 的报告，成功返回 `204`。

报告接收端必须限制 `protocolVersion === 1`、最多 32 个状态项、64 KiB body、字符串长度、状态枚举、
应用内导航路径和 `validForMs` 范围。Backend 把收到的 Feishu 报告和从 App Server 拉取的报告绑定到
自身真实 `node` target，并覆盖外部提交的 target 与接收时间；不信任客户端时钟决定过期，也不接受
其它 source 冒充 Feishu Bridge。

App Server 新增受自身 bearer token 保护的 `GET /runtime-status`，返回 App Server 自己的一个
`local-host` `RuntimeStatusReport`。`/healthz` 和 `/readyz` 保持兼容，不塞入详细状态。

Electron bridge 新增：

```ts
getRuntimeStatusReport(): Promise<RuntimeStatusReport>;
showRuntimeStatusNotification(input: {
  capabilityId: RuntimeStatusCapabilityId;
  title: string;
  body: string;
}): Promise<boolean>;
```

两个 IPC 都只允许主窗口 renderer 调用。通知 handler 再检查窗口确实隐藏或失焦；前台调用返回
`false`，不会同时产生系统通知。标题和正文限制长度，不接受文件路径、URL 或任意 Electron 参数。

## 第一版状态清单与恢复策略

| 拥有者        | 稳定状态项                                            | 正常/中性条件                                               | 进入异常的边界                                                             |
| ------------- | ----------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| Frontend      | `frontend.node.http`                                  | `/health` 返回当前 Backend 身份                             | 连续 2 次或持续 10 秒不可达；其余远端状态受阻                              |
| Frontend      | `frontend.node.auth`                                  | 当前连接已有有效会话                                        | 真实 401 为异常；网络失败归上游 HTTP，不清登录态                           |
| Frontend      | `frontend.terminal.websocket:<sessionId>`             | 当前运行 Terminal WS 已连接                                 | 复用现有最多 5 次重连；Terminal 正常退出或组件卸载为停用                   |
| Frontend      | `frontend.terminal-events.websocket`                  | 收到服务端 connected                                        | 持续重连 30 秒仍未连接；恢复后清除 failure window                          |
| Backend       | `backend.process`                                     | HTTP 已监听并持有 profile lock                              | Backend 不可达由 Frontend 根因项表达，不靠旧报告自证                       |
| Backend       | `backend.activity-store`                              | Activity store 初始化成功                                   | 初始化失败即异常，因为 Activity 用户能力不可用                             |
| Backend       | `backend.app-server-event-consumer`                   | event stream 已收到 connected                               | 重连中先恢复中；持续 60 秒未连接后异常                                     |
| Backend       | `backend.agent-team-recheck-watchdog`                 | 最近一轮在 30 秒内完成                                      | 启动宽限后超过 3 个周期无完成，或连续失败，才异常                          |
| Backend       | `backend.evolution-maintenance`                       | 空闲时 maintenance 新鲜，运行时 lease heartbeat 新鲜        | store 不可用为已停用；超过对应周期 3 倍仍无成功/心跳为异常                 |
| Backend       | `backend.workspace-service:<projectId>:<serviceName>` | 已启用服务为 ready                                          | starting 使用现有 30 秒窗口；failed 异常；stopped 为停用，配置缺失为未配置 |
| App Server    | `app-server.process`                                  | owner 报告可达且 ready                                      | 报告来源过期形成根因异常，其余 App Server 项受阻                           |
| App Server    | `app-server.event-center`                             | store、projector 与 HTTP 已完成启动                         | 初始化失败时进程无法 ready；运行期写错误使用最后错误摘要                   |
| App Server    | `app-server.cloud-sync`                               | `lastError` 为空                                            | 同步错误经过下一次写入重试仍存在时异常；不阻断事件中心                     |
| App Server    | `app-server.thread-reconciler`                        | 最近一轮在 90 秒内完成                                      | 首轮前恢复中；3 个 30 秒周期无完成或连续失败后异常                         |
| Feishu Bridge | `feishu.configuration`                                | 进程已通过必需配置校验                                      | 不上报 secret、chat ID 或 open ID；无报告的新安装显示未配置                |
| Feishu Bridge | `feishu.bridge-lease`                                 | 当前 Bridge 持有单实例 lease                                | 报告过期表示 owner 丢失并成为飞书能力根因                                  |
| Feishu Bridge | `feishu.lark-websocket`                               | Lark SDK 状态 connected                                     | 保留 15 秒检查和重建；连续断开 120 秒后异常，不因重建重置 failure window   |
| Feishu Bridge | `feishu.backend-auth`                                 | `/api/auth/verify` 成功                                     | 检查失败先恢复中，持续 30 秒后异常；Backend 根因不可达时在 UI 受阻         |
| Electron      | `electron.process`                                    | 主进程可响应 IPC                                            | IPC 整体失败由 Frontend 生成 Electron 来源异常                             |
| Electron      | `electron.packaged-backend`                           | 现有 packaged/external Backend state available              | 沿用现有 30 秒启动检查；失败后异常，不由面板重启                           |
| Electron      | `electron.local-network`                              | 至少存在一个非 loopback LAN IPv4 且本地 Backend 对 LAN 监听 | 无候选时异常摘要为“仅本机可用”；保留 loopback 诊断值                       |
| Electron      | `electron.cdp-proxy`                                  | `desktopRuntime.cdpProxy` 已监听                            | 应用 ready 后仍为空即异常；端口作为可复制事实                              |
| Electron      | `electron.companion`                                  | 未启用为停用；启用后 child ready                            | 复用 5 秒 readiness 和指数重启；连续 30 秒无 ready 后异常                  |
| Electron      | `electron.whistle:<profileId>`                        | 未使用/直连为停用；启用且 ready                             | starting 使用现有 15 秒窗口；failed 异常；仅影响对应 Profile               |

Activity retention 等不直接造成当前用户功能失效的低风险循环不进入第一版。

## 实施阶段

### Phase 1：共享合同与纯聚合规则

- [x] 新建 `packages/shared/src/monitoring/runtime-status.ts`，实现上述 DTO、状态枚举、能力域顺序、
      状态严重度、报告过期判断、能力域聚合和因果抑制纯函数。
- [x] 修改 `packages/shared/package.json`，增加 `./runtime-status` 明确导出；不修改根 `src/index.ts`。
- [x] 在纯函数中保证输入不可变；对未知协议或未知状态返回 `unsupported`，不得抛错导致整个面板消失。
- [x] 给动态状态 ID 提供只做字符规范化的 helper，禁止把 cwd、URL token、chat ID 或消息文本编码进 ID。

完成标准：所有运行时只从一个共享子路径取得状态合同；相同输入在 Backend 和 Frontend 得到相同的
严重度、异常计数和受阻结果。

### Phase 2：Backend 注册表、HTTP API 与 Backend 拥有状态

- [x] 新建 `backend/src/runtime-status/registry.ts`：注册同步/异步 provider、合并当前报告、缓存最后成功
      报告、按接收时间判断外部来源过期，并在 `dispose()` 清理 provider timer。
- [x] 新建 `backend/src/runtime-status/provider.ts`：把 Backend 监听身份、Activity store、App Server
      consumer、Agent Team watchdog、Evolution runtime 和 Workspace Services 转为共享状态项。
- [x] 新建 `backend/src/routes/runtime-status.ts`：实现受认证的 GET 和 Feishu PUT；用严格 schema、来源
      allowlist、条目数/大小/长度限制校验输入，响应中不返回 token、环境变量、命令、cwd 或原始错误对象。
- [x] 修改 `backend/src/bootstrap/runtime-services.ts`：创建 `RuntimeStatusRegistry`，把它加入
      `RuntimeServices`，在各 service 构造完成后注册 provider；Activity 初始化失败保留现有降级并报告异常。
- [x] 修改 `backend/src/index.ts`：挂载 `/api/runtime-status`，监听成功后写入 Backend host/port/instance
      状态，shutdown 时 dispose registry。
- [x] 修改 `backend/src/app-server/event-consumer.ts`：公开只读连接快照，记录 connection、failureSince、
      reconnectAttempt、lastConnectedAt 和 lastErrorSummary；不改变游标与指数退避行为。
- [x] 修改 `backend/src/app-server/integration.ts`：无 App Server、初始化失败和连接成功都写入明确状态；
      不新增自动安装或重启。
- [x] 新建 `backend/src/app-server/runtime-status-source.ts` 并修改
      `backend/src/app-server/client.ts`：以 5 秒最小间隔拉取 App Server owner report，复用 in-flight 请求，
      失败时保留最后报告并让来源按 TTL 过期，不阻塞 Backend `/api/runtime-status` 超过 1 秒。
- [x] 修改 `backend/src/agent-team/service/recheck.ts`：只记录 watchdog 最近开始、完成和失败时间并提供
      只读快照；业务 recheck timeout、重试次数与结果保持不变。
- [x] 修改 `backend/src/evolution/runtime.ts`：区分 maintenance freshness 与 active run lease heartbeat；
      长时间正常执行不能因 maintenance 尚未结束被误判为 stale。
- [x] 修改 `backend/src/terminal/workspace-service/manager.ts`：增加脱敏状态投影；只返回 project/context
      identity、服务名、稳定 URL、目标端口、状态与既有错误码，不返回 command/cwd。

完成标准：一个已认证客户端能从 Backend 得到 Backend 与 App Server 报告；来源失联后保留最后值并
准确过期；所有 Backend 状态均由真实 owner 快照产生，route 不解释日志或复制业务状态机。

### Phase 3：App Server、Feishu Bridge 与 Electron 状态来源

#### App Server

- [x] 新建 `app-server/src/runtime-status.ts`：从 Event Center、Cloud Sync 和 reconciler 只读状态构造
      App Server owner report，报告有效期 15 秒。
- [x] 修改 `app-server/src/state/reconciler.ts`：记录最近一轮开始、完成、错误摘要和是否运行；首轮前
      `recovering`，90 秒无完成后才 `unhealthy`。
- [x] 修改 `app-server/src/server/http.ts`：在现有 bearer token 之后增加 `GET /runtime-status`；保持
      `/healthz`、`/readyz` 与事件 API 不变。
- [x] 修改 `app-server/src/index.ts`：把 reconciler 和 Event Center 注入状态 provider；shutdown 后不再
      产生新报告。

#### Feishu Bridge

- [x] 新建 `packages/runweave-cli/src/feishu/runtime-status.ts`：维护一个脱敏 report builder，并通过现有
      `AuthContext.requestJson` PUT 到当前 Backend；同一时刻最多一个上报请求，失败不阻塞 Bridge 主循环。
- [x] 修改 `packages/runweave-cli/src/commands/feishu.ts`：配置校验和 lease 成功后初始化 reporter；正常
      SIGINT/SIGTERM 最后尝试上报 `disabled`，异常退出依靠 Backend TTL 判定 owner 丢失。
- [x] 修改 `packages/runweave-cli/src/feishu/bridge-runtime.ts`：Lark 回调、15 秒检查和 Backend verify
      更新 owner 状态；保留 120 秒重建策略，但 continuous failure 起点只在真正 connected 后清零。
- [x] 报告不得包含 `FEISHU_APP_SECRET`、App ID、目标 chat ID、open ID、消息内容或 delivery 结果。

#### Electron

- [x] 新建 `electron/src/desktop/connection-address.ts`：从当前 packaged Backend URL 取得端口，枚举非
      internal IPv4；优先默认路由对应的私网接口，排除 loopback、link-local 和 `utun`/虚拟接口，保留
      其余候选供抽屉展示。无法可靠选择时不伪造 primary，只表达“仅本机可用”。
- [x] 新建 `electron/src/monitoring/runtime-status.ts`：从 packaged Backend state、CDP Proxy、Companion
      和 Profile runtime 生成 Electron report，并注册 `getRuntimeStatusReport` 与系统通知 IPC。
- [x] 修改 `electron/src/companion/agent.ts`：暴露 desired/running/ready/restart/failureSince 的只读快照；
      保留现有启动、停止和重启逻辑。
- [x] 修改 `electron/src/main.ts`：注册 status handlers，并通过 getter 注入当前主窗口、Companion 与
      `desktopRuntime`；不让 handler持有第二份生命周期状态。
- [x] 修改 `electron/src/preload.ts` 与 `packages/shared/src/desktop/bridge.ts`：增加窄 IPC 合同；Frontend
      继续只能通过 `window.electronAPI` 访问。
- [x] 修改 `electron/src/backend/packaged/controller.ts`：移除启动时“App Server 没有启动”的阻塞 dialog，
      让同一异常由状态入口、抽屉和一次非阻塞提醒表达。
- [x] 修改 `electron/src/desktop/runtime-state.ts`：删除仅服务旧 dialog 去重的
      `appServerUnavailableDialogShown`；其它 Backend reload/error dialog 行为保持不变。

完成标准：每个外部/本地 owner 都能提供共享报告；报告失败不阻塞原业务；Electron 不暴露 Node API
或敏感配置；App Server 缺失不再强制抢焦点弹框。

### Phase 4：Frontend 合并、入口、抽屉与提醒

- [x] 新建 `frontend/src/services/runtime-status.ts`：实现 Backend health、受认证 status GET 和手动
      refresh；区分 401、404/旧版本、timeout 与一般网络失败。
- [x] 新建 `frontend/src/features/runtime-status/registry.ts`：保存 Frontend owner 状态、Electron 报告、
      本机/当前 Backend 最后快照；按共享纯函数处理 TTL、节点去重、能力聚合和因果抑制。Electron 的
      `local-host` 报告绑定到已识别的本机 Backend；Backend 尚不可达时先展示独立本机卡，身份恢复后合并，
      不产生重复告警。
- [x] 新建 `frontend/src/features/runtime-status/provider.tsx` 和
      `frontend/src/features/runtime-status/use-runtime-status.ts`：在 `App.tsx` 只启动一套 5 秒 polling；隐藏
      页面仍保持低频 15 秒 polling 以支持后台提醒，手动检查立即执行且复用 in-flight 请求。
- [x] 修改 `frontend/src/App.tsx`：把 connections、active connection、token、client mode 和 Electron
      bridge 注入全局 provider；Desktop 只轮询本机与当前节点，Web/PWA 只轮询当前节点。
- [x] 本机不是当前连接时，从本地 system connection 的独立 auth store 读取本机 token；没有本机会话
      时仍使用 `/health` 判断地址与身份，详细 Backend 项显示 `blocked`，不得借用远程 token。
- [x] 修改 `frontend/src/features/terminal/connection/use-connection.ts`：暴露 reconnect attempt、
      failureSince 和退出原因；修改 `frontend/src/components/terminal/surface/surface.tsx`，为每个仍运行的
      Terminal 注册 WS 状态，复用现有 5 次重试策略。
- [x] 修改 `frontend/src/features/terminal/connection/use-events.ts` 与
      `frontend/src/components/terminal/workspace/events.ts`：注册 terminal-events 状态；socket open 不等于
      healthy，只有服务端 `connected` 才清除 failure window。
- [x] 新建 `frontend/src/components/runtime-status-entry.tsx`：渲染地址、整体色彩和异常能力域数字；地址
      子按钮只复制，外层按钮只开抽屉，键盘焦点与 aria-label 分开。
- [x] 新建 `frontend/src/components/runtime-status-panel.tsx`：使用 `components/ui/sheet.tsx` 渲染节点卡、
      能力域和状态项；支持重新检查、复制事实和允许的应用内导航。
- [x] 新建 `frontend/src/components/runtime-status-notice.tsx`：记录 capability 从非异常到异常的转移；
      首次快照不提示，前台显示自动消失的非阻塞 notice，后台调用 Electron notification IPC。
- [x] 删除 `frontend/src/components/runtime-monitor-badge.tsx` 的 Dropdown 实现；将资源摘要作为抽屉次级
      区域继续复用 `useElectronRuntimeStats`，确认无 import 后再删除旧组件文件。
- [x] 修改 `frontend/src/pages/home/components/home-header.tsx`、`frontend/src/pages/home/index.tsx`、
      `frontend/src/components/terminal/workspace/header.tsx`、
      `frontend/src/pages/activity/activity-page-panels.tsx`、
      `frontend/src/pages/evolution/evolution-page-panels.tsx`、`frontend/src/pages/prototypes-page.tsx` 和
      `frontend/src/pages/system-monitor-page.tsx`，在各自主 header 右侧使用同一 `RuntimeStatusEntry`；避免
      fixed overlay 遮挡现有操作。修改 `frontend/src/components/connection-page.tsx` 和
      `frontend/src/components/login-page.tsx`，只显示能够无认证取得的精简节点状态。
- [x] 所有跨页面稳定函数使用 `ahooks/useMemoizedFn`；不为 polling、copy 或 notice handler 引入新的
      `useCallback`。

完成标准：主要页面只有一个一致的运行状态入口；本机/当前节点视图、状态颜色、异常计数、复制、
抽屉、因果抑制和前后台提醒均符合已确认行为。

### Phase 5：活文档与验收

- [x] 实现完成时新建 `docs/architecture/runtime-status.md`，只描述已经落地的状态拥有权、数据流、API、
      状态机、安全边界和扩展方式；更新 `docs/architecture/README.md` 索引。
- [x] 更新 `docs/architecture/network-topology.md`，加入受认证 status GET 和 Feishu report PUT；明确
      没有新增状态 WebSocket。
- [x] 更新 `docs/architecture/system-monitor.md`，说明资源监控与运行状态异常计数的边界。
- [x] 保留 `CONTEXT.md` 与 ADR-0001/0002 作为术语与架构取舍；实现与 ADR 不一致时先修实现，不改写
      已接受决定来迁就代码。
- [x] 使用两份 YAML 计划执行真实 provider 与 UI 验收；执行由 `$toolkit:run-test-cases` 负责，本计划
      只编写合同，不在计划阶段运行用例。

## 文件范围

| 文件                                                                                    | 职责                                        |
| --------------------------------------------------------------------------------------- | ------------------------------------------- |
| `packages/shared/src/monitoring/runtime-status.ts`                                      | 新增跨运行时状态 DTO 与纯聚合规则           |
| `packages/shared/package.json`                                                          | 新增 `@runweave/shared/runtime-status` 导出 |
| `packages/shared/src/desktop/bridge.ts`                                                 | Electron 状态与系统通知 IPC 合同            |
| `backend/src/runtime-status/registry.ts`                                                | Backend provider 注册、外部报告缓存与 TTL   |
| `backend/src/runtime-status/provider.ts`                                                | Backend 自有状态投影                        |
| `backend/src/routes/runtime-status.ts`                                                  | 受认证 snapshot GET 与 Feishu report PUT    |
| `backend/src/bootstrap/runtime-services.ts`                                             | 注册表及 owner provider 装配                |
| `backend/src/index.ts`                                                                  | 路由、监听状态与 shutdown 装配              |
| `backend/src/app-server/client.ts`                                                      | 获取 App Server owner report                |
| `backend/src/app-server/event-consumer.ts`                                              | Backend event consumer 连接快照             |
| `backend/src/app-server/integration.ts`                                                 | App Server 集成状态装配                     |
| `backend/src/app-server/runtime-status-source.ts`                                       | App Server 报告拉取、缓存与超时             |
| `backend/src/agent-team/service/recheck.ts`                                             | watchdog 新鲜度证据                         |
| `backend/src/evolution/runtime.ts`                                                      | maintenance 与 lease heartbeat 证据         |
| `backend/src/terminal/workspace-service/manager.ts`                                     | Workspace Service 脱敏状态投影              |
| `app-server/src/runtime-status.ts`                                                      | App Server owner report                     |
| `app-server/src/state/reconciler.ts`                                                    | reconciler 新鲜度证据                       |
| `app-server/src/server/http.ts`                                                         | App Server status endpoint                  |
| `app-server/src/index.ts`                                                               | App Server provider 装配                    |
| `packages/runweave-cli/src/feishu/runtime-status.ts`                                    | Bridge 脱敏状态构建与上报                   |
| `packages/runweave-cli/src/feishu/bridge-runtime.ts`                                    | Lark/Backend 状态转移证据                   |
| `packages/runweave-cli/src/commands/feishu.ts`                                          | 配置、lease、启动与退出状态装配             |
| `electron/src/desktop/connection-address.ts`                                            | 手机可连接 LAN 地址解析                     |
| `electron/src/monitoring/runtime-status.ts`                                             | Electron owner report 与通知 IPC            |
| `electron/src/companion/agent.ts`                                                       | Companion 生命周期只读快照                  |
| `electron/src/main.ts`、`electron/src/preload.ts`                                       | Electron handler 与 renderer bridge 装配    |
| `electron/src/backend/packaged/controller.ts`                                           | 移除旧 App Server 阻塞提醒                  |
| `electron/src/desktop/runtime-state.ts`                                                 | 删除旧 dialog 去重状态                      |
| `frontend/src/services/runtime-status.ts`                                               | health/status HTTP 客户端                   |
| `frontend/src/features/runtime-status/registry.ts`                                      | 客户端报告合并、节点去重与因果抑制          |
| `frontend/src/features/runtime-status/provider.tsx`                                     | 全局 polling 和报告生命周期                 |
| `frontend/src/features/runtime-status/use-runtime-status.ts`                            | 状态注册与消费 hooks                        |
| `frontend/src/components/runtime-status-entry.tsx`                                      | 常显地址和整体状态入口                      |
| `frontend/src/components/runtime-status-panel.tsx`                                      | 右侧抽屉与节点/能力域详情                   |
| `frontend/src/components/runtime-status-notice.tsx`                                     | 前台 notice 与后台系统通知派发              |
| `frontend/src/components/runtime-monitor-badge.tsx`                                     | 被统一入口替代并在无引用后删除              |
| `frontend/src/App.tsx` 及各主要页面 header                                              | 全局 provider 与统一入口接入                |
| `frontend/src/features/terminal/connection/use-connection.ts`                           | Terminal WS 重试证据                        |
| `frontend/src/components/terminal/surface/surface.tsx`                                  | 仍运行 Terminal 的 WS 状态注册              |
| `frontend/src/features/terminal/connection/use-events.ts`                               | Terminal events WS 新鲜度证据               |
| `frontend/src/components/terminal/workspace/events.ts`                                  | terminal-events 状态注册                    |
| `frontend/src/components/connection-page.tsx`、`frontend/src/components/login-page.tsx` | 未认证页面的精简节点状态入口                |
| `docs/architecture/runtime-status.md` 及相关索引                                        | 实现后的当前架构合同                        |
| 两份 `docs/testing/**/*.testplan.yaml`                                                  | Provider 与 UI 验收合同                     |

不修改 Terminal 输入协议、飞书 delivery state、App Server event envelope、Workspace Service 启停 API、
System Monitor 采样协议或 Ionic App。

## 兼容、迁移与回滚

- 协议从 `protocolVersion: 1` 开始；新增字段只能是可选或新版本。Frontend 遇到 Backend status 404
  显示 `unsupported`，仍用 `/health` 判断节点连接，不影响旧 Backend 的 Terminal 使用。
- Electron preload 新方法在 Frontend 侧按可选能力读取；新 Frontend 运行在旧 Electron 壳时，本机
  Electron 状态显示 `unsupported`，不能抛错或阻塞页面。
- 不修改数据库、事件日志、Bridge delivery state 或连接存储 schema，无数据迁移。
- 外部 Feishu report 只保存在 Backend 内存；Backend 重启后先显示检查中，收到新 heartbeat 后恢复。
- 回滚时可以按逆序关闭 Phase 4 UI、Phase 3 owner report、Phase 2 API；原 `/health`、Terminal WS、
  App Server 和 Feishu Bridge 主链不依赖状态面板，删除状态代码即可恢复。
- 旧 App Server 阻塞 dialog 只有在统一入口与通知完成真实桌面验收后才删除；若 UI 未通过，不单独合入
  dialog 删除。

## 安全与隐私边界

1. Backend status GET 与 report PUT 使用现有 Bearer 鉴权；App Server status 使用既有 loopback token。
2. Backend 强制把外部报告归属到自身真实 `node` target，不信任请求提交的 target、接收时间或来源类型。
3. Electron IPC 只允许当前主窗口 renderer；Frontend 不获得 Node、process、networkInterfaces 或
   Notification 构造权限。
4. 允许展示的事实仅为地址、端口、状态摘要、重试进度和更新时间；禁止 token、secret、chat/open ID、
   消息正文、Terminal 输入输出、完整命令、cwd、环境变量、原始错误堆栈和任意日志。
5. 导航只允许应用内绝对路径；复制只复制合同中的 display-safe value，不执行 URL 或命令。
6. 报告有大小、条目数、字符串长度和 TTL 上限，防止拥有有效 token 的异常客户端造成内存或 UI 放大。

## 风险与控制

1. **状态面板成为第二控制面**：所有 item 只允许 copy、refresh、route；不定义任意 action RPC。
2. **Backend 成为所有状态的猜测者**：Backend 只拥有自身状态并中转 App Server/Bridge 报告；owner
   语义留在各组件内部。
3. **断连告警风暴**：节点 HTTP 或来源 heartbeat 作为根因，最后已知下游统一 blocked，异常数按能力域。
4. **无限重试永不变红**：每个 owner 同时维护 retry 行为和 continuous failure window；重建连接不能
   清除 failureSince，只有真实 connected/success 才清除。
5. **长任务被误判 stale**：Evolution 区分 maintenance idle freshness 和 active lease heartbeat；其它
   周期任务按自身 interval 的 3 倍判断。
6. **本机/当前节点重复**：优先使用 Backend serviceInstanceId，URL 只作身份不可用时的回退。
7. **VPN/虚拟网卡地址误导手机**：默认排除 loopback、link-local、utun 与已知虚拟接口；不能可靠选出
   primary 时展示候选或“仅本机可用”，不声称一定可达。
8. **隐藏页 polling 被节流**：后台 15 秒是提示及时性的目标，不作为硬实时保证；恢复前台立即 refresh。
9. **旧运行时版本组合**：HTTP 404、缺少 IPC 和未知协议均退化为 unsupported，不影响现有业务链路。
10. **旧 App Server 弹框过早移除**：只有新入口、异常高亮和系统通知均通过真实 Desktop 验收后删除。

## 验证命令与通过标准

实现阶段按改动范围执行：

```bash
pnpm testplan:validate docs/testing/platform/runtime-status-providers.testplan.yaml
pnpm testplan:validate docs/testing/runbooks/runtime-status-panel.testplan.yaml
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/backend typecheck
pnpm --filter @runweave/backend lint
pnpm app-server:typecheck
pnpm --filter @runweave/app-server lint
pnpm --filter @runweave/cli typecheck
pnpm --filter @runweave/cli lint
pnpm --filter @runweave/electron typecheck
pnpm --filter @runweave/electron lint
pnpm --filter @runweave/frontend typecheck
pnpm --filter @runweave/frontend lint
pnpm architecture:check
pnpm docs:check
git diff --check
```

静态通过标准是全部命令退出码为 0。真实行为通过标准是：

1. 正常 Desktop 的右上角显示可复制的当前地址且无异常计数，抽屉能看到本机报告。
2. 选择远程 Backend 后显示本机与当前两个同结构节点；连接回本机后按 serviceInstanceId 合并。
3. 每种故障先进入恢复中，只有表中宽限窗口耗尽后变红；恢复后清除异常。
4. Backend 故障只让节点连接计数一次，下游全部无法判断；Electron 独立状态继续可见。
5. Feishu 验收只改变配置、lease、Lark WS 或 Backend connectivity，不发送真实消息。
6. App Server、Workspace Service、Terminal WS、Companion 或 Whistle 的真实故障只影响对应能力域。
7. 前台只出现一次非阻塞 notice；隐藏或失焦时只出现一次 macOS 系统通知；重复采样不重复通知。
8. status API 未认证返回 401，所有 API、IPC、UI 和复制内容均不含列出的敏感信息。
9. System Monitor 仍可独立使用；CPU/内存变化不会增加运行状态异常数。

浏览器和桌面 UI 验收必须实际使用 `$toolkit:playwright-cli` 附着正确页面或 Desktop renderer；静态检查、
文档校验和普通截图都不能代替以上行为结论。

## 交付顺序

建议按以下独立提交/PR 边界执行，前一阶段不依赖后一阶段即可验证：

1. 共享合同 + Backend registry/API + provider YAML 中的基础 API 用例。
2. App Server 与 Backend consumer 状态；单独验证 stop/recover 与 TTL。
3. Feishu Bridge 报告；只验证连接与 claim，不发送消息。
4. Electron 报告、LAN 地址与 IPC；保留旧 dialog 直到 UI 完成。
5. Frontend 入口、抽屉、Terminal 状态、因果抑制与提醒；通过真实 Desktop UI 后删除旧 dialog。
6. 活文档收口与两份 YAML 全量验收。

每个阶段都必须保持已有业务主链可运行；任何阶段出现假健康、敏感数据泄露或告警风暴时停止向后合入。
