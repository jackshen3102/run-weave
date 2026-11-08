# Windows 独立 PTY Host 与远程升级实施计划

状态：待实施；本文是目标设计，不表示已有能力。粒度：整体 L2，进程所有权、输入确认、鉴权和升级事务按 L3 约束。

## 1. 交付目标

用户在 Windows Runweave 网页的 Traex 终端中发出升级指令。升级被外层管理进程接管后，
Backend、App Server 和网页资源切换到已发布的目标 Server 版本。网页允许短暂断流，重新连接后
仍是原终端、原 PowerShell、原 Traex 进程及会话；原来正在执行的命令继续运行。

成功判据不是重新启动 Agent 后 resume 对话，而是升级前后的 Host 身份、会话实例、shell PID、
Agent PID、Agent thread，以及受控后台命令的执行连续性均有证据保持一致。

首版范围：

- Windows x64、Node 22、独立 npm Server；系统 PowerShell 和手工启动的 Traex 为必验目标。
- 同一实例一个独立 Host，可托管多个 PTY。Backend 与网页是客户端，不拥有 PTY 的销毁权。
- 支持正常 Backend 重启、Backend 异常退出后的重连，以及 Server 更新时保活。
- 更新通过原有 CLI 控制面发起；不新增 Web 升级按钮，不要求用户在更新过程中操作本机桌面。
- 默认更新 channel 保持现有 latest；测试明确使用 next。每个事务开始后固定精确版本，不在事务中再次解析标签。

首版不包含：tmux 分屏/Fork/Recover、Host 自身无损升级、Windows 重启或注销后恢复原进程、
跨用户共享终端、Windows 系统服务安装、Node 版本更新、任意旧版数据库回滚。
macOS/Linux 的 tmux 和直接 PTY 路径保持现状，不默认切换 Host。

## 2. 已核对的代码现状

| 当前入口                                                                               | 当前事实                                                                            | 本次需要改变                                                           |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `backend/src/terminal/runtime/pty-service.ts`                                          | 已封装 PID、write、resize、signal、onData、onExit、dispose                          | 真实 node-pty 由 Host 创建，Backend 得到远程适配器                     |
| `backend/src/terminal/runtime/registry.ts`                                             | 缓存、终端模式、订阅、屏幕镜像在 Backend；disposeAll 会销毁 PTY                     | Host 保留输出事实和屏幕状态；Backend 退出只释放连接                    |
| `backend/src/terminal/runtime/output-recovery.ts`、`output-screen.ts`                  | 已有有界输出帧、游标、快照和恢复逻辑                                                | 复用实现，不能只复制裸 PTY 进程而丢失画面状态                          |
| `backend/src/terminal/runtime/launcher.ts`                                             | 找不到运行时可重新 spawn shell                                                      | 托管会话必须先与 Host 对账，禁止因重连失败生成替代 shell               |
| `backend/src/terminal/application/input-dispatcher.ts`                                 | 结构化输入可能包含延时后 Enter 等多个动作                                           | 托管会话的完整提交序列必须由 Host 执行，不能依赖 Backend 的定时器活着  |
| `backend/src/bootstrap/runtime-services.ts`                                            | 关闭 Backend 时统一 dispose terminal-runtimes                                       | 区分断开客户端与用户结束终端                                           |
| `packages/runweave-cli/src/server/processes.ts`                                        | 已有外层前台管理进程及私有命名管道；管理 Backend/App Server                         | 管理进程接管升级事务，普通重启不停止 Host                              |
| `packages/runweave-cli/src/server/update.ts`                                           | 已有下载、校验、维护租约、停止、激活、启动及回执                                    | 复用保护，增加 Windows 和托管 PTY 的事务边界                           |
| `packages/runweave-cli/src/commands/server.ts`                                         | Windows 明确拒绝 update/service                                                     | 仅在 Host 能力及升级验收通过后开放 update；service 仍不开放            |
| `packages/runweave-cli/src/server/installation.ts`                                     | 不可变 release 已存在；current 是 junction，现有替换不能直接假定为 Windows 原子替换 | Windows 改用私有 JSON 发行指针，不删除当前发行目录；POSIX 保持 symlink |
| `backend/src/terminal/runtime/environment.ts`、`backend/src/app-server/integration.ts` | Agent 会继承 Backend/Hook/App Server 地址和令牌；现有环境同步主要针对 tmux          | 活着的 Agent 必须使用稳定入口，不能假定修改父进程环境能修改已有子进程  |

## 3. 进程与职责

```text
系统 PowerShell → rw server start（外层管理进程，独立升级执行者）
                    ├─ Backend（可替换） ← Web / iOS
                    ├─ App Server（可替换）
                    └─ 启动/发现 PTY Host（独立生命周期）
                                          ├─ ConPTY → PowerShell → Traex
                                          ├─ 输出帧、屏幕镜像、输入操作记录
                                          └─ 稳定本机 Agent 连接入口
```

- Host 是独立常驻进程，不是 Backend 的 Worker，也不能绑定 Backend 的 IPC disconnect 退出。
- 新 Backend 连接已存在且身份匹配的 Host；不能每次启动新建一个 Host。
- Host 只管理终端及必要的本机连接转发，不拥有项目数据库、Agent 推理或升级业务决策。
- 外层管理进程负责版本选择和升级；Host 不运行 npm，不接受任意升级 shell 字符串。
- `server restart` 保留终端。`server stop` 停止对外组件但保留 Host，会明确报告仍存活的终端。
  结束终端使用现有关闭操作；完全结束 Host 使用新增 `rw server host stop`，有会话时拒绝，
  只有显式 `--terminate-sessions` 才结束这些会话。原生 Node 进程不得被错误显示为已经全部停止。
- 用户注销、机器重启或 Host 本身退出后，不承诺原进程存活；应显示失联/退出，不能伪装成恢复成功。

## 4. 首版协议与不变量

### 4.1 发现、所有权与鉴权

新增 `packages/shared/src/terminal/pty-host.ts`，通过 `@runweave/shared/terminal/pty-host` 导出纯 TS 合同。
新增 `packages/pty-host/` 承载 Node 实现，协议不依赖 Backend 或前端组件。

- Host 私有根目录为 `<configRoot>/runtime/pty-host/`；发现记录包含 protocolVersion、hostInstanceId、
  PID 与启动身份、configRoot/instanceId、端点、Host 发行身份。令牌单独保存，不放进状态 DTO 或日志。
- Windows 控制面使用当前实例专属命名管道；连接后必须验证私有令牌、实例根路径和协议范围。
  目录与文件复用现有 ACL 检查。命名管道名、PID 存活或 TCP 端口可达均不能单独证明身份。
- 使用现有内核锁保证同实例唯一 Host。发现记录过期时核对 PID 启动身份和握手；未经验证不能删除
  活着的 Host 记录、杀其他进程或接管另一个实例。
- 一个 Backend writer lease 携带递增 generation；新 Backend 接管后，旧 generation 的写入、resize、close 均拒绝。
  Host 输出订阅与写权限分开，恢复画面不获得命令执行权。
- 由外层 CLI 启动 Host，标准输入与 Backend/PTY 脱钩，输出写私有日志；不能把 Node 的 detached 标记本身当成保活证据，
  必须执行 P0 的真实 Windows 父进程/Job 生命周期验证。

### 4.2 会话与输入

Host 支持 `hello`、`listSessions`、`createSession`、`attachSession`、`writeInput`、
`getInputOperation`、`resize`、`signal`、`closeSession`、`getSnapshot`。
每个请求有 requestId，所有会话操作固定 hostInstanceId、sessionInstanceId、terminalSessionId 和 writer generation。

- createSession 使用幂等键；同键同内容返回同一会话，不同内容返回冲突。
- `runtimeKind` 保持 `pty`，持久会话记录增加可选 `ptyHost` 身份绑定。不能仅把 recoverable 改为 true
  并复用 tmux 恢复；明确恢复范围仅为 Backend 重启。旧记录无该字段仍走原有路径。
- writeInput 接收有界的文本/按键/延时序列及 operationId。Host 接受整项操作后负责执行，
  Backend 在文本和 Enter 之间退出也不会遗留半次发送。复用 PTY line 文本→200ms→Enter 的语义。
  每操作最多 64 步、单次延时至多 1000ms、累计延时至多 5000ms；每会话最多 128 个未完成操作，满时拒绝为 busy，不先确认后丢弃。
- 同会话的写操作有顺序；同 operationId、同内容仅执行一次，不同内容拒绝。原始键盘流使用连接内序号，
  断线后不由客户端盲目重放。单次结构化操作上限 1 MiB，长文本继续走现有附件流程。
- 响应区分 accepted、written、failed、uncertain；written 仅表示字节已写 PTY，不表示 Agent 完成执行。
  Backend 重连向同一 Host 查询结果；Host 代次已变且结果不可证实时标记 uncertain，不自动重发。
- Host 不驱逐尚在执行的操作记录；完成记录按会话保留最近 24 小时，至多 10000 项。
  操作带会话内单调序号，淘汰记录时仍保留拒绝旧序号的水位；水位之前的重试返回 expired，不得重新执行。
- 会话显式 close 幂等且只结束对应的 shell/子进程；Backend 断开、订阅释放和健康探测失败不调用 close。
- 固定错误码至少包含 HOST_AUTH_FAILED、HOST_IDENTITY_MISMATCH、HOST_PROTOCOL_INCOMPATIBLE、HOST_WRITER_STALE、
  HOST_SESSION_GONE、HOST_UNAVAILABLE、HOST_INPUT_CONFLICT、HOST_INPUT_EXPIRED、HOST_BUSY、HOST_OUTPUT_GAP。
  客户端按错误类别展示或重连，不能把这些错误统一转换成创建新终端。

### 4.3 输出和重连

- Host 持有输出流 ID、递增字节游标、终端尺寸、模式、退出状态和 headless 屏幕镜像。
  复用现有 60 秒/512 KiB 有界重放窗口和快照逻辑，不能在每次 Backend 连接时重置流 ID。
- 新 Backend 先恢复会话身份，再建立快照/游标与后续帧之间的连续边界；快照期间产生的输出也必须补齐。
- 窗口内重放不重复、不丢帧；超出窗口使用当前屏幕快照并明确历史输出存在缺口。
  不承诺无限日志保存，不能把截断历史显示成完整恢复。
- 慢客户端不得阻塞 ConPTY 输出读取。超过订阅队列上限时断开该订阅并要求快照重连，不关闭 PTY。
- Host 屏幕镜像故障应保留原 PTY，标记显示恢复降级，不继承现有镜像错误直接 disposeRuntime 的策略。
- Backend 启动时以 Host 清单对账绑定记录：活着则恢复 running；Host 已记录退出则投影 exited；
  Host 失联或身份不匹配则显示 unavailable，禁止自动 spawn 替代 Agent。Host 上不属于本实例持久记录的孤立会话不自动删除。

### 4.4 存活 Agent 的稳定入口

新增 Host 本机 gateway，端口在 Host 生命周期内固定，仅监听 127.0.0.1；使用会话作用域令牌。
初次创建托管终端时，Backend/Hook/App Server 环境指向此稳定入口，不注入易变化的 App Server 直接端口与令牌。

- gateway 依据管理进程发布的已验证目标代次转发；上游变化不需要修改活着的 Traex 环境。
- 仅开放现有 Agent 客户端需要的 Backend Hook 与 App Server 路由，前缀分别固定为 `/backend/`、`/app-server/`；
  实现阶段从 `packages/agent-bridge/` 和 Toolkit Hook 真实调用建立显式路由白名单，逐条覆盖，不提供任意目标 URL 代理。
- 对普通业务请求，上游中断返回明确 unavailable；不自动重放可能产生副作用的 API 调用，也不承诺所有在途工具调用无感。
- Hook 事件带事件 ID、会话身份和原始时间，在私有有界 outbox 中先落盘再确认；上游恢复后幂等补投。
  outbox 总量上限 16 MiB，满时明确拒绝并标记状态不完整，不能静默丢失或无限存储正文。
- 升级后重新接通事件消费、Agent 身份和 completion 投影。只看到屏幕可输入，不能宣称 Agent 状态同步也正常。
- 活着的 Agent 所用 rw 入口必须指向可兼容的不可变 CLI 或稳定包装器；旧发行目录和原生模块在会话存活期间不得清理。

## 5. 远程更新合同

### 5.1 接管入口

保留 `rw server update --version <精确版本>`，新增 `--channel latest|next`；version 与 channel 不能同时指定。
Windows 上将请求交给外层管理进程；Agent 端进程只提交、观察状态，不拥有升级执行任务。

- `--dry-run` 只预检，不建执行事务、不停服。实际提交必须先持久化 transactionId、requestId、固定目标及回执，
  再返回 accepted；Agent 请求断线不能取消已接管的事务。
- 同 requestId/相同目标复用事务；不同内容冲突；同实例同一时刻只允许一个升级事务。
- 外层管理进程拒绝终端提供的任意命令、路径和 registry 覆盖，只接受版本选择与已验证的本机实例身份。
- `rw server status --json` 和升级观察结果提供 phase、from/target/running 版本、Host 发行/协议、保留会话数、
  是否需要维护窗口、失败阶段与可恢复动作。现有 update.json 路径沿用并演进其 schema，不新增平行回执。

### 5.2 执行顺序

1. 解析并固定目标 Server 版本，下载到私有 staging；物化不可变 release、检查原生依赖和摘要。
2. 核对数据/配置迁移、CLI 管理协议、活跃 Host 协议范围及 gateway/会话恢复能力。
   首版只接受无需改变已有托管会话字段含义、Hook 认证或稳定入口的在线升级；不兼容则停服前拒绝并提示维护窗口。
3. 取得既有维护租约。支持的普通 Host PTY 不作为必须杀掉的 affectedRun；现有受管任务和不可兼容执行保护仍生效，
   不以 `--force` 绕过 Host 身份、协议、数据或配置兼容检查。
4. Host 确认会话清单及已接受输入序列由其持有；冻结新终端创建和新 writer 接管，已有 Agent 和命令继续运行。
5. 停止 Backend/App Server 的客户端业务组件，保留 Host 和外层执行者。Host 持续接收输出，gateway 保留 Hook outbox。
6. 按既有 CAS 和配置升级合同提交配置与发行指针。Windows 使用 `<serverHome>/active-release.json`，包含 schemaVersion、
   相对 releases 的目录、manifest 摘要和 transactionId；临时文件先同步再 rename。所有 Windows 读者统一走
   resolver 校验路径和摘要，不能部分代码仍读取旧 current junction。指针不存在时仅首次迁移允许读取已验证旧 junction；
   指针损坏或未来 schema 必须拒绝，不回退到另一版本。POSIX 继续使用原 symlink。切换回执和实际指针不一致时先对账恢复，不能删 release。
7. 启动新 App Server/Backend，更新 gateway 目标，完成 Host 会话对账和 writer generation 切换。
8. 验证健康、配置采用、Host 会话身份、Hook 补投和连接恢复，记录 healthy。网页重新获取 fresh endpoint/引用后重连原终端。

首版沿用现有合同：普通 Server 更新不替换全局 CLI，不重启 Host。目标要求新版 CLI/Host 时，预检拒绝，
明确给出维护窗口的升级指引。不能覆盖仍被 Windows 进程加载的 DLL，也不能声称 npm 安装目录变化即运行版本变化。

### 5.3 失败与回退

- 下载、校验或兼容失败：原 Backend 和所有终端保持运行，失败回执可读。
- 已停止但配置和 current 均未提交：确认源摘要和指针仍一致后尝试启动原组件；保留 Host 终端，不重复创建会话。
- 配置或 current 已提交：遵循现有配置升级合同，不自动降级数据库或配置。优先重试同一目标启动，失败则显示 manual-recovery-required；
  Host 保留会话和输出，不能为了回退杀掉 Agent。
- 外层管理进程异常退出：Host 独立存活。重新执行 start 时先读取事务回执和实际指针/配置再恢复观察；
  不因缺少请求连接重复执行更新、不默默把阶段记为成功。

## 6. 首次迁移和 Host 自身维护

- 从当前不含 Host 的 Windows 版本升级时，已有 Backend 内的 ConPTY 不能承诺无损转移到另一个进程。
  首次迁移允许一次明确的终端中断，使用系统 PowerShell 或独立升级执行者安装并启动含 Host 的版本，之后新终端才具备保活能力。
- 新 Backend 不把旧直接 PTY 记录伪装为托管会话；保留会话历史并显示该次会话已结束。
- Host 可执行文件、Node ABI 原生模块及 gateway wrapper 物化到私有不可变发行目录；由 Host 身份记录引用。
  普通 npm 更新可安装新的 Host 文件，但兼容时继续使用活跃旧 Host，状态分别展示已安装与运行版本。
- `rw server host update` 仅在没有存活会话时执行；有会话则拒绝，不接受隐含 force。用户须先显式关闭终端。
  Host 升级后 Host 身份变化，旧绑定不能被重新解释为同一个运行时。

## 7. 文件范围与任务顺序

路径为实施目标；可以按职责拆 helper，但不得把 Host 实现放进 shared 或让前端直接连接本机命名管道。

| 阶段                  | 文件/模块范围                                                                                                                                                                                                                                                                         | 交付与退出门禁                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0 Windows 可行性尖峰 | 临时验证产物；复用真实 node-pty/ConPTY                                                                                                                                                                                                                                                | 记录 Host、shell、Traex PID；分别正常停 Backend 和强制终止 Backend，确认进程及输出存活。验证 Windows Job/句柄关系确实没有把 Host 一起杀掉；失败先修启动所有权，不能进入业务接线 |
| P1 Host 与合同        | 新建 `packages/pty-host/{package.json,AGENTS.md,src/{index,server,sessions,input-operations,output,gateway}.ts}`；`packages/shared/src/terminal/pty-host.ts` 及 exports；必要的纯运行时复用模块                                                                                       | 实际命名管道鉴权、唯一 Host、输入幂等、输出快照和显式关闭；有界队列与错误码齐全                                                                                                 |
| P2 Backend 接入       | 新建 `backend/src/terminal/runtime/pty-host-client.ts`；修改 launcher、registry、environment、input-dispatcher、manager/records、store/lowdb-records、bootstrap/runtime-services、app-server/integration                                                                              | Windows standalone 使用托管 PTY；启动先对账；关闭 Backend 不 close；完整提交序列在 Host 执行；旧 tmux 和直接 PTY 不改变                                                         |
| P3 升级接管           | `packages/runweave-cli/src/commands/server.ts`、`src/server/{context,installation,processes,update}.ts`；`packages/runweave-server/src/runtime.ts`；`packages/config-node/` 必要的 Host 发现与私有目录能力；新增 `packages/config-node/src/server/active-release.ts` 统一发行指针解析 | 接管确认、Windows JSON 指针恢复、兼容预检和失败回执；打开 update，不打开 service；首次迁移提示和 host 维护命令                                                                  |
| P4 打包与验证         | `scripts/release/{build-server,build-backend,publish-server}.mjs`、`.github/workflows/server-release.yml`；扩展 `scripts/verify/server/windows-terminal.mjs`；新增 `scripts/verify/server/pty-host.mjs`                                                                               | Windows 平台资源带 Host bundle、原生依赖及协议清单，仍是现有七个公开包，不默认新增 npm 包。真实 tarball 验证升级前后不变的会话身份；只发 next                                   |
| P5 当前合同与交付     | `docs/cli/server-cli.md`、`docs/deployment/npm-server-operations.md`、`docs/architecture/` 必要的终端生命周期入口；本次 YAML                                                                                                                                                          | 在真实 Windows 用户与 CI 上分别取证；更新已验证限制，完成后迁移长期合同并删除过程计划                                                                                           |

复用 `output-recovery`/`output-screen` 时，优先抽取 Host 和 Backend 真正共用的 Node 实现；
不能让独立 Host import Backend 的业务层。新建内部包时同步 pnpm workspace、锁文件、typecheck/lint 和架构依赖约束。
配置和会话持久字段若需转换，读取配置升级合同并集中提供迁移，不在消费者散落旧格式 fallback。

## 8. 验证与验收

配套逐条验收：[Host 运行时](../testing/terminal/windows-pty-host.testplan.yaml)与
[Windows 远程更新](../testing/platform/windows-pty-host-upgrade.testplan.yaml)。
这是待实施验收合同；本轮只校验格式，没有运行下述行为。

- 静态门禁：`pnpm --filter @runweave/shared typecheck`、新 Host 包 typecheck/lint、
  `pnpm --filter @runweave/backend typecheck`/lint、`pnpm --filter @runweave/cli typecheck`/lint、
  `pnpm architecture:check`、`pnpm configuration:check`、`pnpm docs:check`。
- 真实进程验证：实现后用 `node scripts/verify/server/pty-host.mjs` 启动自己拥有的 Host、Backend、
  PTY 和临时 npm registry，验证进程身份及恢复。不得新增单元测试文件，也不得用 mock 探测替代 ConPTY 行为。
- 发行验证：`pnpm server:build`，在 Windows CI 从真实 tarball 执行 Host 集成和升级用例；
  macOS/Linux 继续原安装/自更新回归。public registry 安装验收必须包含 Host bundle 和 Windows 原生资源加载。
- 用户路径：独立 Windows 测试实例中，通过 `$toolkit:playwright-cli` 操作真实 Web，发起升级并在断流后重新定位页面；
  Agent PID 和受控计数器跨升级连续，不能以同名新会话或 resume 对话替代。声明手机体验时另用真实 iOS/模拟器按设备技能取证。
- 本轮计划检查：分别运行 `pnpm testplan:validate docs/testing/terminal/windows-pty-host.testplan.yaml`、
  `pnpm testplan:validate docs/testing/platform/windows-pty-host-upgrade.testplan.yaml` 和 `pnpm docs:check`。

每项证据分别记录源码 SHA、tarball 摘要、系统/Node、Host 与组件身份、旧/新版本、输入 operationId、
输出流游标及失败阶段。Windows CI、真实 Windows 用户、浏览器 UI 和手机验收是不同层，不互相替代。

## 9. 风险、阶段决策和估算

- P0 若不能证明 Host 脱离 Backend 的真实生命周期，停止后续接线，先解决 Windows Job/ConPTY 句柄所有权。
- 最大正确性风险是重复输入和接错原会话，其次是输出缺口、旧 Agent 连接地址失效及升级失败后的错误清理。
  这些均为必验门禁，不能仅以 health 200 放行。
- Host 自身成为会话故障边界；一个 Host 崩溃可能影响该实例全部 PTY。首版承认此边界，不虚构进程恢复。
  是否进一步做每会话独立 worker，依据故障测试和实际负载决定，不提前增加进程体系。
- 工程量粗估沿用讨论范围：P0 约 1–2 人日，可用测试版约 5–10 人日量级，额外预留故障验证和修补时间。
  稳定入口、首次迁移和输入确认是必须成本；P0 完成后按证据重估，不以日期替代验收。
- 先完整交付 Windows 闭环；本计划不授权在执行前自动扩展到 Electron、macOS/Linux Host 或生产机器部署。
