# 飞书集中 Bridge V1 实施计划

状态：代码已实现，待真实三机部署验收。2026-10-10，源码基线 `9472440d`。

实现已接通三角色配置、中心 WS、Backend 内置连接、CLI 本机通知转发、共用终端提交、v3 路由存储及离线迁移/回滚。
受控集成使用三个独立节点进程，并实际经过 CLI→本机 Hook 鉴权入口；飞书出站与终端执行端使用受控适配器。
构建、类型、lint、架构与配置治理、Backend 生命周期、Hook 回归均按下文命令验证；真实飞书/TLS/三台实体机器尚未执行。
当前配置与操作合同以 [飞书部署](../deployment/feishu-app-integration.md) 为准，下面保留设计和剩余验收边界。

## 1. 目标与范围

一个现有飞书应用、一个集中 Bridge、三台运行 Runweave Backend 的机器。用户只在**机器人通知建立的已有话题内回复**，回复回到该话题所属的机器与终端。不要求用户选机器、建话题或输入路由命令。

保留现有行为：首次符合条件的终端通知由机器人创建话题；后续通知和回答进入原话题；终端内仍投递到当前活动 Panel；DONE 表情只表示输入已接收并入队。

不做：群内顶层消息发起任务、手动创建/认领话题、机器选择卡片、新建终端、跨机器调度、固定 Agent 会话绑定、附件输入、多租户、集群高可用、消息中间件、无限离线队列或管理页面。任意用户自建话题也不会被自动接管。

## 2. 已确认的现状与可行性

| 现有能力       | 代码事实                                                                                                                                         | 本次处理                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| 飞书长连接     | `packages/runweave-cli/src/commands/feishu.ts`、`src/feishu/bridge-runtime.ts` 使用 Lark WSClient，启动时绑定一个 AuthContext/TerminalHttpClient | 保留 SDK 与重连逻辑，增加集中运行分支，解除中心对单个 Backend 登录的依赖 |
| 已有话题回复   | `src/feishu/bridge-message-handler.ts` 校验群、用户、text、root_id、thread_id，再查已保存话题                                                    | 保留过滤与投递状态机；仅把单个客户端替换成按话题选择的窄接口             |
| 话题创建和复用 | `src/feishu/topic-notifier.ts`、`state-store.ts` 按 chat + Terminal 保存话题，含创建租约、UUID 与 CAS                                            | 增加 Backend 维度，复用原存储与原创建逻辑                                |
| 本地通知政策   | Hook → `feishu_stop_notify.sh` → `rw feishu notify` → `awaitFeishuNotification` → Backend policy                                                 | 时长、已查看、宽限期与飞书回复例外全部留在本机；只改变最后发送通道       |
| 终端执行       | `backend/src/routes/terminal/input/index.ts` 选当前 Panel，再调用 `sendInputToSession`                                                           | 小范围抽取现有提交应用函数，让 HTTP 与连接模块调用同一实现               |
| 持久机器身份   | `backend/src/auth/connection-identity.ts` 已保存 Ed25519 身份，提供稳定 identityId                                                               | 直接以 identityId 作为 backendId，不另造机器 UUID/注册中心               |
| 网络前提       | rw 支持显式远端 base URL，但存在环境身份与额外 tunnel 鉴权边界                                                                                   | 不依赖中心按 IP 调用 rw；机器主动出站连接中心                            |

上述 `src/feishu/` 均位于 `packages/runweave-cli/`。现有 snapshot publisher 是单向 HTTP 发布，不是执行指令通道，不改造为通用总线。

飞书官方 SDK 明确：同一应用有多个长连接客户端时，事件随机交给其中一个，而非广播；因此同一应用切换时必须停掉旧接收进程。SDK 也要求及时确认事件，保留现有“持久入队后返回、异步执行”，不等待终端执行后才确认。[官方说明](https://github.com/larksuite/node-sdk#subscribing-to-events-using-long-connection-mode)

本轮在 loopback 临时实验中完成：

- 使用仓库安装的 `ws`，三个客户端主动连接一个服务；给三台机器使用相同 Terminal ID，按不同话题绑定分别投递，三个客户端各收到一次，回执按 requestId 对应。
- 直接调用当前 `FeishuBridgeMessageHandler`，无 root、无 thread、未知 root、错误 thread、未授权用户这五种输入均未入队；合法回复调用一次 `prompt_replace + submit`，operationId 保持 `feishu:<message_id>`，并产生 DONE 回执。
- 执行命令：`pnpm --dir backend exec tsx /tmp/runweave-feishu-plan-check.ts`，退出码 0。脚本为本机临时实验，不纳入产品或单元测试。

实验中的存储、终端和飞书接口为模拟对象，WS 未接生产鉴权/TLS。它证明传输方向与处理器复用可行；不证明集中模式已实现、真实公网可达或三台真实机器已验收。

## 3. 最小架构

```text
飞书平台 ←── Bridge 主动建立的 Lark WebSocket ── 集中 rw feishu bridge
飞书平台 ←── Bridge 调用飞书 HTTPS API ────────┘
                                                   ↑  ↑  ↑
                                  三个 Backend 各主动建立一条 WSS
                                      双向：通知上报 / 输入投递 / 回执
                                                   │  │  │
                                           MacBook Linux Mac mini
```

中心部署一份现有 CLI 的 Bridge 进程及持久状态目录，新增一个 HTTP upgrade listener。生产使用现有反向代理终止 TLS，Bridge 默认仅监听 loopback。三台 Backend 内置连接模块，随 Backend 启停；无需单独本地 daemon、飞书密钥或飞书应用。

只有中心需要被三台机器访问。远端 Backend 不开放新入站端口。中心不可用时飞书链路暂停，本机终端继续运行；V1 接受单点，不引入 HA。

### 两条业务链

1. **通知/回答**：原 Hook 与 CLI 判定允许发送 → 本机 Backend 转发接口 → 已有 WSS → 中心 `notifyFeishuTopic` → 首次建立或复用话题 → 返回飞书发送结果。
2. **用户回复**：现有话题回复 → 中心权限过滤 → `(chatId, rootMessageId)` 查出 `(backendId, terminalSessionId)` → 找该机器在线连接 → 复用终端提交函数 → 输入接收回执 → 后续回答沿第 1 条链返回原话题。

路由依据是持久话题绑定，不是发言者、消息文本、IP、在线机器顺序或当前连接 ID。演示图的机器切换只代表观察不同话题，不是飞书新增交互。

## 4. 必须固定的合同

### 连接、身份和配置

- 新增 `services.feishu.role = standalone | hub | node`，默认 `standalone`，保留当前单机行为；一次运行只启用一种角色。
- `hub` 使用现有 appId/appSecret/targetChatId/allowedOpenIds/notifyOpenIds，增加 `services.feishu.hub.host`、`port`、`backends.<backendId>.token`。地址默认 loopback，端口显式配置；token 至少 32 字节随机值，逐机独立、配置与日志脱敏。
- `node` 只配置 `services.feishu.node.url`（HTTPS origin，连接时转换为 WSS）与 `token`；backendId 从现有 ConnectionIdentityService 取得，身份损坏则关闭该连接能力并报告错误，不生成替代身份。无需 appId/appSecret；配置校验按角色生效，node 禁止同时使用 legacyWebhook。
- Backend 主动连接 `/feishu/backends/<backendId>`，在 upgrade 阶段验证 Bearer token 与配置的 backendId 配对；不把凭据放入 URL，不接受业务包改写 backendId。token 只授权该身份上报自身终端通知并建立连接。
- 同一 backendId 只允许一个在线连接；新连接遇到仍存活的旧连接时拒绝，不抢占。采用 WS ping/pong 每 15 秒检测、连续 45 秒无回应移除；重连退避 1、2、4、8、16、30 秒并加抖动，上限 30 秒。关闭旧连接的回调只能移除自己的 Map 项。
- node 随 Backend 资源生命周期启动/关闭；停止重连、拒绝新请求、结束在途等待，再释放终端依赖。可选飞书配置错误不阻止主 Backend 启动。

### 窄协议

新增 `packages/shared/src/feishu/bridge.ts`（及 package exports），只包含以下类型及严格校验所需常量：

| 消息              | 方向              | 最小字段/结果                                                                                                             |
| ----------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `hello` / `ready` | node → hub → node | protocolVersion=1；未知版本断开；ready 前不接业务                                                                         |
| `terminal.get`    | hub → node        | requestId、terminalSessionId；仅返回存在/运行状态及错误码，不传完整终端记录                                               |
| `terminal.input`  | hub → node        | requestId、terminalSessionId、messageId、text、expiresAt；node 固定构造 `feishu:<messageId>`、prompt_replace、submit=true |
| `notify`          | node → hub        | requestId、terminalSessionId、notificationText；backendId 从认证连接取得；返回现有 TopicNotificationResult                |
| `result`          | 双向              | requestId、ok、对应窄结果或稳定错误码；只能完成该连接自己发起的请求                                                       |
| `status`          | hub → node        | 复用已有 RuntimeStatusReport 的飞书来源；不得带凭据或消息正文                                                             |

这是固定消息联合类型，不提供通用 HTTP 转发、shell 执行或任意 RPC 方法。text 上限保留 256 KiB，单帧上限 512 KiB；校验 unknown 字段、空 ID、无效时间与响应方向。每个连接最多 64 个在途请求，超限返回 busy，避免无界内存。连接关闭清除等待器；旧连接迟到结果不能完成新连接的请求。

错误固定为 `invalid_request`、`not_found`、`not_running`、`unavailable`、`busy`、`expired`、`input_unknown`；其中 not_found 只表示本机终端缺失。适配器对照原处理器的 400/404/409/503/429 分类映射，发送后的传输错误归 unknown，不能用统一 404 或成功空响应掩盖。

中心每 5 秒复用现有状态报告，node 将中心状态与自身连接状态接入原 runtime-status registry；保留现有来源过期语义，不继续向唯一 Backend 做 auth verify，不新增面板。

### 本机通知接入口

`rw feishu notify` 在 node 角色先走现有 `awaitFeishuNotification`，允许后才转发；不能先读取 app 凭据而退出。复用现有 Hook token 新增 `POST /internal/terminal-completion/feishu/notify`，Hook token 不上传中心。显式手动 notify 复用 CLI AuthContext，走登录鉴权的 `POST /api/feishu/notify`；两入口调用同一个转发函数，检查本机 Terminal 存在、非空正文和大小限制。

内部路径只承接当前 Hook/CLI 的发送链，原 policy claim 不重复领取。中心不重新做本机时长/已读判断；转发返回值保持现有 notify JSON 字段。notify 等待最多 40 秒，覆盖原话题创建最多 35 秒；断连或超时返回明确失败/未知，不报告 sent=true、不自动重发、不新增通知持久队列。原有“claim 后发送失败可能丢一次通知”的限制保留并写入部署说明。

### 话题与投递存储

- 在现有 JSON 状态上升级集中模式版本：话题键为 `(chatId, backendId, terminalSessionId)`，记录增加 backendId；root 反向查询仍按 chat + root，可按当前规模直接查找，不增加第二个持久索引。
- 已领取的用户消息也保存 backendId 与 Terminal ID，恢复时不得重新解释为另一个目标；messageId 去重仍沿用 24 小时记录。
- 所有创建租约、释放、激活、删除、查询都带 backendId，避免只改查找而遗漏清理造成串机。保留原 30 秒创建租约、UUID 和 CAS。
- 在线 Map 为内存状态，不写入 JSON。无需 Redis、数据库迁移框架、路由发现或定时同步终端列表。
- `FeishuBridgeMessageHandler` 依赖窄 `getSession/sendInput` 接口，通过 `clientForTopic(topic)` 获得适配器。standalone 返回原 HTTP 客户端；hub 返回该 backendId 的连接适配器。状态机只保留一份。

### 失败语义

- 尚未发送输入：保留现有从飞书 create_time 起 120 秒期限、2 秒重试间隔、单次最长 15 秒。离线仅等待原机器，过期在原话题说明失败，不转投其他机器。
- 中心持久标记 inputAttempted 后才发帧。发送后断连、超时或结果无法确认：记录 unknown，提示先检查终端，不自动重投。node 执行前也检查 expiresAt；晚到消息不执行。
- Backend 明确不存在的 Terminal：原话题反馈失败，并按原规则清除对应绑定；已退出终端不自动新建。节点离线或未注册不等于 Terminal 不存在，不清除绑定。
- 成功必须由 Backend 返回 inputAccepted=true 且 inputEnqueued=true；WS send 成功、socket 在线、Feishu 事件确认均不算输入成功。
- 中心重启：沿用 durable queue 的恢复规则，未尝试且未过期才续投，已经尝试而无最终结果转 unknown；不承诺 exactly-once 执行。

## 5. 实施拆分

按下面顺序完成，每步都保持 standalone 能运行；不迁移无关模块。

1. **配置和协议**：修改 `packages/shared/src/configuration/{fields,constraints}.ts`、`packages/config-node/src/validation.ts`，新增 shared Feishu 合同与导出。使用现有动态路径匹配支持每机 token；条件校验、敏感值脱敏、node 未配置不启动。更新生成的配置参考。
2. **终端提交复用和 node**：从 `backend/src/routes/terminal/input/index.ts` 提取提交应用逻辑至 `backend/src/terminal/application/submit-input.ts`，直接复用已有 `application/panel-targets.ts` 的 resolvePanelTarget；原 HTTP 与新连接入口共享运行状态检查、输入提交及 recent-input 行为，领域层不反向导入 routes。新增 `backend/src/feishu/bridge-connector.ts`，在 `bootstrap/runtime-services.ts`、`runtime-services-contract.ts` 和 ResourceScope 装配；通知转发函数置于 `backend/src/feishu/`，内部入口接入 `routes/terminal/completion.ts`，登录入口新增 `routes/feishu.ts` 并接入现有路由装配；接入现有 runtime-status registry。只借用现有 identity 服务，不导出私钥。
3. **中心与路由**：在 `packages/runweave-cli/src/feishu/` 新增 `hub-server.ts`、`remote-terminal-client.ts`，为 CLI 明确声明 `ws` 与类型依赖；修改 `commands/feishu.ts`、`bridge-runtime.ts`、`runtime-status.ts` 做角色与状态传输装配。修改 `state-store.ts`、`topic-notifier.ts`、`bridge-message-handler.ts` 增加 backendId 和客户端选择，保留原租约/去重/重试。
4. **notify 接线与切换**：修改 CLI notify node 分支，Hook 脚本参数与摘要提取不变；验证绑定的运行时 rw 已包含 node 分支。同步 `docs/cli/terminal-cli.md`、`docs/deployment/feishu-app-integration.md`、`docs/architecture/terminal-completion-notifications.md`，按下一节做状态迁移与切换。

中心的执行入口是现有 `rw feishu bridge` 的 hub 角色，node 由 Backend 启动。无需新增独立 npm 包、另一个 Agent 服务或第二套进程管理器。

## 6. 迁移与回滚

1. 选择三台机器共用的一个**现有应用与目标群**；备份各旧状态目录、配置并记录应用归属，禁止凭 Terminal ID 猜归属。
2. 部署支持三角色的新版本，先保留 standalone。中心使用独立持久目录和一份配置；三机登记现有 identityId 与各自 token，确认彼此不同。
3. 切换窗口暂停通知发送并停止旧 Bridge 接收进程，等待创建租约及在途处理退出后备份稳定状态。旧版本 JSON 不原地覆盖：一次性离线转换到中心新版本，给明确属于所选应用/群的每份状态补 backendId，合并 topic 和 processed；冲突、未完成 creating 或无法确认归属则停止迁移，不静默取一份。
4. 同一应用的既有 root/thread 绑定可以保留；原来另两个应用的话题不保证能由选定机器人接收或回复，因此不导入。它们下一次正常通知由统一机器人按现有规则建立自己的话题，用户仍只在通知话题回复。跨应用无缝接管历史话题不在 V1 范围。
5. 启动中心、再启用三台 node 配置；确认旧应用/旧 Bridge 不再收本链事件，按测试计划完成真实三机验证。一次性转换逻辑随实现提供可运行脚本与输入/输出摘要，无需新增用户命令；不启动即执行迁移。
6. 回滚先停中心与 node，再恢复原应用/config/state 和 standalone。不能直接丢弃切换期间的 processed 记录，否则旧事件可能被重投：按 backendId 将可归属的新绑定、终态去重记录反向合并到旧格式；所有 in-flight attempted 项保守转 unknown。备份原文件，冲突即停。新版状态不可直接交给旧二进制读取。

生产中心地址/TLS、飞书应用权限、真实终端输入与状态恢复仍须实测。部署前用实际目标网络与所选应用验证；失败时保留 standalone，不开放远端 Backend 端口作为临时绕过。

## 7. 验收与交付门槛

独立验收见 [飞书集中 Bridge 测试计划](../testing/terminal/feishu-central-bridge.testplan.yaml)。实现及受控集成已完成；真实消息发送、执行与重启用例仍须在授权测试环境执行。

本轮文档检查通过，测试计划的 8 条 required 用例通过格式校验；HTML 的 30 个场景状态及两个断连说明通过浏览器交互检查，console error 为 0。这些结果不等于 8 条业务用例已执行。

实现阶段运行以下现有命令，要求退出码 0；涉及配置变更先运行 `pnpm configuration:docs` 更新生成内容：

```bash
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/config-node typecheck
pnpm --filter @runweave/backend typecheck
pnpm --filter @runweave/backend lint
pnpm --filter @runweave/cli typecheck
pnpm --filter @runweave/cli lint
pnpm cli:build
pnpm architecture:check
pnpm configuration:check
pnpm backend:verify-lifecycle
pnpm toolkit:verify-hooks
pnpm testplan:validate docs/testing/terminal/feishu-central-bridge.testplan.yaml
pnpm docs:check
```

已提供隔离进程级验证入口 `scripts/verify/feishu/central-bridge.ts`：启动真实 hub transport、三个 connector 与临时状态目录，飞书出站使用本地受控接口；覆盖同 Terminal ID 不串机、拒绝伪造身份、未知话题忽略、恢复不重投，并输出每项 pass/fail。调用 `pnpm --dir backend exec tsx ../scripts/verify/feishu/central-bridge.ts`。它是集成验证，不新建单元测试或 TDD 文件，也不能替代真实飞书闭环。

交付必须区分：静态检查通过、受控集成通过、真实三机飞书闭环通过。只有最后一项完成，才宣称部署链路可用；真实验收必须记录每台机器的 identityId、对应话题、目标 Terminal 与输入次数，并脱敏保存证据。

配套 [HTML 架构图](../architecture-flows/feishu-central-bridge-v1/index.html) 只显示通知与已有话题回复两条流程，均为方案演示。

### 2026-10-10 验收条件复核

- 测试计划重新通过 validator，8 条 required；独立用例执行到 FCB-001 前提检查即停止，未发真实飞书消息、未向用户终端写入，也未切换或停止现有 Bridge。FCB-001 未执行，FCB-002～008 未在本轮独立用例执行中运行；先前集成脚本的覆盖不计为整份 YAML 验收通过。
- 当前源码 CLI 只读查询本机 Stable 配置：revision 76，role 使用默认 standalone，node.url 与 hub.port 未配置，hub.backends 数量 0。只有 local profile，指向本机 5001；这些证据不能证明远端不存在其他部署，只说明本次没有可定位的三机测试目标。
- `rw status --instance stable --profile local --json` 的飞书来源于 2026-10-10 02:33:50 UTC 报告 Lark WebSocket、单实例 lease 与 Backend auth healthy。已有单机 Bridge 正在工作，不能把它当作空闲测试实例，不能另起同应用消费者竞争真实事件。
- 补充本机隔离 TLS 实验：临时 CA 只通过子进程 NODE_EXTRA_CA_CERTS 信任，没有关闭证书校验或修改系统信任；证书主机名不匹配时真实 connector 在 HTTP Upgrade 前拒绝连接。三个真实 connector 经 HTTPS 终止代理连接真实 hub，Upgrade/Authorization 正确保留，三个相同 Terminal ID 的输入按身份分别到达，回执成功。命令为 `NODE_EXTRA_CA_CERTS=<临时证书> pnpm --dir backend exec tsx /tmp/rw-feishu-tls.ScnYsj/verify.ts`，退出码 0；进程与 socket 已关闭。终端回调受控，不代表生产 TLS 或真实终端执行通过。
- 尚缺的真实证据：三机 identityId 与专用 Terminal、实际中心域名证书与网络、真实话题输入次数、DONE 时机、回答回到原话题，以及完整 Backend 在中心离线时仍可本地输入。受控脚本没有替代这些项。
- 最小解锁信息：指定中心及三台机器的可访问部署目标、中心 HTTPS 域名，以及允许发送/回复的测试应用与群；明确授权相应版本部署和旧 Bridge 切换窗口。若已有隔离 hub/node 部署，提供目标入口即可先做只读核对，不要求重复部署。实际群内发消息和终端执行只在选定测试范围内进行。
