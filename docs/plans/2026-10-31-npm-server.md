# Runweave NPM 服务端第一阶段实施计划

日期：2026-10-31。状态：已按本计划实现，验证边界见文末执行记录；尚未发布 NPM registry。

## 1. 目标与边界

用户安装一个 NPM 包即可启动完整 Runweave 后台，通过已有桌面端连接或直接打开随包网页使用。
复用现有 `rw`，增加服务生命周期管理，不另造一套业务 CLI。

已确认：

- macOS、Linux，一台机器一个服务实例；暂不处理与桌面版后台共存、接管与迁移。
- 包含 Backend、App Server、现有网页及运行资源；不包含 Electron 内嵌浏览器与原生远控 Host。
- 默认前台运行；显式安装后台服务后支持常驻与开机启动。
- 后台异常退出自动重启并限制连续失败重试频率；前台异常报错退出。
- 自带自身组件；Node/npm 是安装前提，Git、tmux、Agent 工具等外部依赖由初始化检查并引导安装。
- 用户配置 Agent/模型凭据及连接地址；复用认证，不增加穿透、中继、账号云服务。
- 普通 tmux Agent 不阻挡更新；只有重启会中断的服务托管执行阻挡更新，提供强制继续。
- 不自动回退；更新失败保留数据和日志，支持指定版本更新/恢复，但拒绝不兼容的数据降级。
- 不新增业务功能或要求所有后台 API 都有 CLI 命令；现有依赖云服务或第三方配置的功能仍需原有配置。

## 2. 当前代码事实与可复用基础

| 能力                  | 当前入口                                                                                     | 判断                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Node Backend 独立发布 | `scripts/release/build-backend.mjs`、`scripts/release/backend-start.mjs`                     | 已包含网页、SQLite workers、PTY、资源采样与开发资源；应以此为基础           |
| 安装校验与版本切换    | `scripts/install/backend.mjs`                                                                | 已校验文件清单/hash、平台、架构、Node ABI，使用版本目录与原子 current 链接  |
| 网页托管              | `backend/src/index.ts`、`backend/src/server/frontend-dist.ts`                                | 已有静态服务与 SPA 回退；安装态需传绝对资源路径，不依赖 cwd                 |
| App Server            | `app-server/src/index.ts`、`packages/config-node/src/app-server/`                            | 独立事件服务，保留进程、singleton、token 和 cursor 语义                     |
| App Server 构建安装   | `scripts/install/app-server.mjs`                                                             | 当前构建后直接执行安装；需提取无安装副作用的构建入口                        |
| CLI                   | `packages/runweave-cli/src/index.ts`、`scripts/bundle.mjs`                                   | 已有业务命令；包为 private，尚不是完整服务端分发包                          |
| 配置与初始化          | `packages/config-node/src/initialization.ts`、`packages/runweave-cli/src/commands/config.ts` | 已有配置、认证初始化和显式实例合同；应复用，不再创建第二份配置              |
| tmux 保留             | `backend/src/bootstrap/tmux-shutdown-policy.ts`                                              | Stable 默认 preserve；服务管理器还必须避免清理 tmux 子进程                  |
| 后台执行关闭          | `backend/src/scheduled-tasks/runtime.ts`                                                     | dispose 会 abort active 并等待 executions；需要更新前原子暂停领取和检查执行 |
| 桌面更新保护          | `scripts/update/scheduled-task-guard.mjs`                                                    | 按 queued/running/stopping/waiting 等状态拦截，范围大于本需求，不可照搬     |

已有 [独立 Backend 部署说明](../deployment/backend-standalone.md) 仍需要仓库构建及分别部署组件。
本项目新增的是可分发的软件包与统一服务管理，不重写业务后台。
桌面专用 `scripts/release/build-runtime.mjs` 仍依赖 Electron 构建，不作为 NPM 服务端主链。

## 3. 推荐交付结构

### 3.1 包与版本

新增源码目录 `packages/runweave-server/`，发布名建议 `@runweave/server`；这是建议名，未确认 registry 命名权限。
保留 `@runweave/cli` 的源码职责，由服务端发行包携带同一版本构建出的现有 rw 和新增 server 命令。
一个产品版本锁定 Backend、App Server、CLI、网页、配置合同和平台原生资源的版本及来源 revision。

推荐一个公开主包加平台资源包：主包带 JS、网页、资源清单及 rw 入口；平台包带相应原生依赖和辅助二进制，
按精确版本的 optionalDependencies 选择。初始发布矩阵建议 darwin arm64/x64、Linux glibc arm64/x64、Node 22。
这些是实施建议，不代表当前所有目标已经验证；任一目标缺构建或安装证据，不得宣称该目标已支持。
musl 和其他 Node ABI 第一阶段明确报不支持，不在用户安装时偷偷编译或下载另一套工具链。

用户机器不需要 Git 仓库、pnpm、TypeScript 编译器、Electron 或 Xcode 来安装本产品自身组件。
安装阶段不写用户配置、不注册服务、不自动启动、不修改其他工具；缺平台包时 doctor/start 必须明确失败，
不能因为 optional dependency 可省略而报告安装态完整。
打包产物不得残留 workspace 引用、开发机绝对路径、密钥及缓存。

### 3.2 安装路径和配置

沿用现有 stable 配置上下文和存储字段，内部调用显式传递配置上下文，不修改其他 rw 命令的实例规则。
新增服务运行记录建议放 `~/.runweave/server/`：版本 releases、current、管理锁、运行/更新回执；
配置、项目、会话、SQLite、App Server 状态与日志继续使用已有配置路径，均不放 npm 包目录或 release 目录。

npm 安装目录只承载分发包和入口；运行前将所选发行版本完整物化到不可变 release 目录，
服务管理器固定使用稳定入口和绝对 Node 路径。npm 替换包文件不能破坏仍在运行的旧版本 worker。
不为此开发多实例注册表；重复启动通过管理锁、Backend profile lock 和 App Server singleton 拒绝或返回已运行。

### 3.3 用户命令（拟新增，不是当前已可用命令）

```bash
npm install -g @runweave/server
rw server init
rw server doctor --json
rw server start
rw server service install
rw server status --json
rw server logs --follow
rw server stop
rw server restart
rw server update
rw server update --version <明确版本>
rw server update --force
rw server service uninstall
```

- `init`：交互收集已有认证要求和监听配置，复用 config 初始化；非交互使用受限权限 auth 文件。
  重复调用保留现有配置，冲突报错，不重置密码、数据或 Agent 登录态。默认 127.0.0.1:5001，远程连接显式配置监听地址。
- `doctor`：区分服务启动硬依赖、终端能力依赖、各 Agent 可用/未安装/未认证；不输出凭据。
  未配置 Agent 不阻止基础服务启动，不伪报 Agent 已可用；缺 tmux 时明确标记终端不可用并给安装指引。
- `start`：未托管时前台运行；已安装系统服务时启动相应托管服务，并报告模式。运行中重复调用不再拉一份。
- `stop/restart`：控制本产品确认归属的进程，保留 tmux；restart 同样使用受影响执行保护，force 显示影响的 run ID。
- `service install`：安装并启动系统托管，读回开机启用状态；需要管理员权限时仅提升注册操作，业务进程仍用指定用户运行。
- `service uninstall`：注销托管并停服务，保留配置、数据和 release；不隐含执行 npm uninstall。
- `update`：默认解析 registry 最新稳定版，也可指定版本；没有后台运行时只更新安装和运行版本，不凭空启动服务。
  前台运行时由独立更新进程协调受控重启并保持原前台会话；无法维持该模式必须明确失败，不能静默变后台。

`status --json` 至少返回 schemaVersion、mode、installedVersion、activeVersion、runningVersion、sourceRevision、
backend/appServer 的 PID 与 health、监听地址、配置/数据目录、托管 enabled 状态、lastError。
多个版本字段不得互相替代；组件降级不输出整体 healthy。标准输出只放结果，诊断写 stderr，凭据脱敏。

## 4. 进程与服务管理

一个服务产品不等于一个 Node 进程。保留 Backend 与 App Server 的独立职责：

```text
rw server 管理入口
  ├─ Backend（HTTP/WS + 静态网页，默认 5001）
  └─ App Server（独立本机事件/状态服务）
桌面端 / 浏览器 ──现有认证及 HTTP/WS── Backend
```

前台启动器只负责拉起、等待健康、转发退出信号和清理自己创建的两个进程，不做自动重启守护。
组件启动失败须停止本轮已启动组件并报错；正常运行中的必需组件退出也结束本轮前台会话。
Backend 内部可降级能力继续使用现有降级语义，不能用健康检查强行把全部可选能力变为硬依赖。

后台使用两个系统任务，各自直接运行 Node，不套 PM2、nohup 或额外守护进程。
Linux 使用 systemd；macOS 使用 launchd。实现真正开机启动时，选择系统服务并明确运行用户，
不能把用户登录后启动称为开机启动；用户注销及重启机器后的验证分别记录。
先启动 App Server 并等待健康，再启动 Backend；停止顺序反向。Backend 自身不负责停止独立 App Server。

异常重启由系统管理器完成，设置重启间隔和频率限制，达到限制时保留失败状态；管理器不支持指数退避时使用其限速机制，
不为了相同算法增加一套 supervisor。显式 stop 必须保持停止，不能被自动重启拉回。
systemd Backend 复用既有 KillMode=process 约束；macOS 核对目标系统 launchd 的进程组处理并配置 tmux 保留。
该例外只保留 tmux，不能放任 Backend worker、App Server 或临时子进程泄漏。
杀死 Backend 主进程后的孤儿回收与下次启动必须按可验证的 owner 身份处理，禁止按进程名批量 kill。

## 5. 更新与受影响任务保护

### 5.1 更新过程

1. 获取管理互斥锁；解析固定目标版本并下载到 staging，保持旧服务运行。
2. 校验平台、ABI、资源完整性、原生加载及配置/数据兼容元数据；失败不改当前指针或停止旧服务。
3. 向当前 Backend 获取短期维护租约：暂停新后台执行领取，等待当前领取临界区结束，再返回真正存活的执行集合。
4. 非 force 且存在受影响执行：释放租约恢复调度，返回 run ID 和拒绝原因；普通 tmux 不参与该判断。
5. 无受影响执行或 force：记录更新回执，停止 Backend，再停止 App Server；确认退出且锁释放。
6. 独立于待替换 npm 目录的更新 helper 完成 npm 全局包替换、release 物化及 current 切换。
   helper 的全部运行依赖固定在旧 release/独立 staging，不能在自更新中途再从已删除的 npm 目录加载模块。
7. 按原运行模式启动新组件，核对两者版本、健康、配置上下文和前端资源；完成后才报告更新成功。
8. 启动失败：记录 failed 和诊断路径，保留旧 release 与用户数据，不自动切回；允许指定兼容旧版本再次更新。

回执阶段最少区分 staged、blocked、stopping、installing、activating、healthy、failed，记录版本与来源，
不记录密钥。命令中途退出后，下一次管理命令根据真实进程、指针、npm 包及回执进行对账，不把残缺更新视为完成。
直接 `npm install -g` 只更换分发包，不能绕过保护自动重启旧服务；status 显示版本差异，显式 update 完成激活。

### 5.2 必须消除检查与停止之间的竞争

只查询 SQLite 状态再停止存在竞争窗口：检查后调度器可能领取新任务。因此保护由 Backend runtime 实施，
不能由 CLI 复制调度状态机或用桌面更新 SQL 代替。

拟在 `packages/shared/src/server-management.ts` 定义 DTO，在 `backend/src/routes/server-management.ts` 加本机管理路由：

- `POST /api/server/maintenance`：申请暂停派发租约，返回 leaseId、expiresAt、affectedRuns（runId、reason）。
- `POST /api/server/maintenance/:leaseId/renew`：同一管理 owner 续租，返回新的 expiresAt；过期租约不可复活。
- `DELETE /api/server/maintenance/:leaseId`：释放本次租约并恢复派发。
- 租约建议 120 秒；管理客户端 30 秒续租，超时或 CLI 崩溃自动恢复派发。续租必须校验相同 owner。
- 身份使用本机私有管理令牌及 loopback 来源检查；不向网页登录 token 开放更新/系统服务权限。
  普通 HTTP/WS 登录仍复用现有认证。管理路由不提供任意命令执行、安装 URL 或文件路径参数。

暂停 runPass 的新领取，等待已经开始的领取临界区完成，允许已运行任务继续完成；
affectedRuns 按当前 runtime ownership 与 executions 的实际存活判断。
queued、已持久化等待、已转交 tmux 的执行不因状态字符串本身阻挡更新；仍有服务内执行则阻挡。
force 只绕过受影响执行保护，不绕过身份、平台、哈希、版本或数据兼容校验。
服务已停止时无需租约；服务活着但无法取得租约时默认拒绝，显式 force 可按已验证 PID 走现有关闭流程并记录未知影响。

## 6. 实施任务与文件范围

| 阶段                    | 文件/模块                                                                                                                                                                                  | 交付与退出条件                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| P1 统一分发             | 新增 `packages/runweave-server/package.json`、`scripts/release/build-server.mjs`；拆分 `scripts/release/build-backend.mjs` 和 `scripts/install/app-server.mjs` 的构建函数；复用 CLI bundle | 主包及平台包可 pack，在无仓库目录安装并启动两个组件；不改旧发布入口行为                     |
| P2 初始化及前台生命周期 | 新增 `packages/runweave-cli/src/commands/server.ts`、`src/server/` 中配置/路径/进程/状态模块；修改 CLI index；复用 config-node                                                             | init 幂等、缺依赖可诊断、cwd 无关、两组件就绪、重复启动拒绝、退出清理                       |
| P3 后台托管             | CLI `src/server/service-managers/` 下 systemd/launchd 适配；新增包内稳定启动入口                                                                                                           | install/start/stop/restart/uninstall 完整；异常恢复、开机启动、tmux 保留有真实系统证据      |
| P4 更新保护             | 新 shared DTO、Backend 管理路由、scheduled-tasks runtime 维护租约；CLI `src/server/update.ts` 及包内独立 update helper                                                                     | 任务竞争消除、普通 tmux 不阻挡、force 可审计、分阶段失败可诊断、指定版本恢复                |
| P5 发布与文档           | 新 `.github/workflows/server-release.yml`；更新 `docs/cli/README.md`、新增 `docs/cli/server-cli.md`、更新部署入口与独立后台说明                                                            | 目标平台产物均经干净安装；包名权限/发布凭据由发布环境提供；首轮先产 tarball，不自动公开发布 |

各阶段保留现有工作区改动，不写单元测试、不顺手重构业务层。
每阶段先通过对应安装态用例，再推进下一阶段；源码 build 不能代替最终 tarball 验收。
平台依赖构建采用对应目标环境；明确把目前 build-backend 中从 Electron workspace 解析 esbuild 的构建依赖移到独立构建位置，
不要把“运行时不需要 Electron”误写成“当前构建完全不涉及 Electron 目录”。

## 7. 验收与验证

新增 [NPM 服务端安装及生命周期验收](../testing/platform/npm-server.testplan.yaml)，用例为拟实现合同，未实现前不可宣称通过。
复用 [Backend 生命周期](../testing/platform/backend-runtime-lifecycle.testplan.yaml)、
[tmux 持久化](../testing/terminal/runtime/tmux-persistence.testplan.yaml)、
[定时任务运行](../testing/scheduled-tasks/runtime.testplan.yaml) 及现有 App Server verify 脚本做回归。

实现阶段执行：CLI/Backend/App Server 的 typecheck 和 lint；`pnpm architecture:check`、`pnpm backend:verify-lifecycle`、
`pnpm scheduled-tasks:verify-runtime`、`pnpm app-server:verify`，以及本次修改触及的配置检查。
新包 build 后对实际产物运行 npm pack，在匹配的干净 macOS/Linux 环境安装；禁止依赖仓库 cwd 或预装桌面 Runtime。
网页真实交互使用 toolkit:playwright-cli，桌面通过已有连接功能连接安装态服务；不启动 Dev Session 冒充安装态。

最终证据分别报告：打包/格式检查、每个平台安装、前台、系统托管、重启保活、更新、网页与桌面真实交互。
缺目标机器或 npm registry 权限时准确记录未验证项，不以本机静态检查代替。
计划阶段只运行 `pnpm testplan:validate docs/testing/platform/npm-server.testplan.yaml`、`pnpm docs:check` 和 diff 检查。

## 8. 主要风险与实现约束

- 原生依赖的平台/架构/ABI 不匹配：构建矩阵与安装时加载检查必须同时存在。
- npm 自更新和执行文件删除：运行组件与 helper 固定在不可变 release，不从正在替换的路径继续加载。
- tmux 存活不代表重启期间所有 rw API 可用：HTTP/WS 暂断属预期；不可承诺正在调用后台 API 的 Agent 请求零失败。
- 系统进程组清理：验证 pane PID 和持续输出，不只验证 tmux session 名称仍存在。
- 后台任务保护的竞争：租约覆盖领取到停止全过程；错误恢复不能让调度永久暂停。
- 数据降级：发行清单提供 configurationSchemaVersion 和各持久存储的可读 schema 范围，预检比较磁盘实际版本；
  缺兼容声明的旧发行版不能用于自动激活。第一阶段只接受兼容版本，不做逆向 schema 迁移；
  不因“指定版本安装成功”宣称历史数据兼容。
- 凭据及启动用户：保持 HOME、Agent 登录态、配置上下文与 PATH；不得让系统服务意外使用 root 的模型账号。
- 不新增公网基础设施；非本机网页需要的 HTTPS/WSS 部署条件在文档明确，连接可达不等于浏览器安全上下文可用。

## 9. 外部机制参考

- [npm package.json](https://docs.npmjs.com/cli/configuring-npm/package-json/)：发布文件、平台约束与可选依赖机制；可选包缺失须由产品检查。
- [systemd.kill](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html)：进程组清理机制；本项目已有 tmux 保活例外需用真实重启验证。
- [Apple launchd 手册源码](https://github.com/apple-oss-distributions/launchd/blob/main/man/launchd.plist.5)：系统托管、限速与进程组选项；实现时以目标 macOS 自带 man 手册复核，不把旧手册当跨版本保证。

## 10. 实施记录

- 已新增 `packages/runweave-server`、统一构建入口、现有 rw 的 server 命令组、前台控制、systemd/launchd 适配及更新回执。
- 实际分发采用轻量主包加完整平台包，JS、网页及原生资源一起进入精确版本的平台包；原生依赖使用归档，避免 npm 自动排除嵌套 node_modules。主包在各平台保持相同。
- 更新命令自身从不可变 release 执行，直接承担独立于全局 npm 目录的更新 helper 职责，未再增加长期守护进程。
- App Server 沿用已有 runtime 安装登记和发现合同，启动时清除父 Runweave 终端的 App Server 连接凭据。
- 独立服务初始化新增显式 `storage.activityKeyStorage=file`，复用现有 0600 文件密钥加密逻辑，解决 macOS 无登录 Keychain 场景；其他运行形态保留默认 system 策略。
- 新增 `pnpm server:verify-installed`：真实 tarball + loopback npm registry + 隔离用户目录 fixture，验证安装、初始化、组件健康、网页资源、本机维护租约、前台重启、版本 fixture 自更新和停止回收。
- 已补真实 SQLite 与可取消子进程的维护租约集成验证；不调用模型，不写单元测试。
- 系统服务定义可生成并经过 macOS plutil 校验；真实系统注册、开机验证、Linux 与 x64 目标、桌面连接和公网 NPM 发布仍需相应环境与发布阶段证据。CI 矩阵只表示构建入口，不能作为这些行为已通过的证据。

- 本机 macOS arm64 已通过最终 tarball 安装、自更新版本 fixture、Activity 文件密钥、App Server 业务集成、本机维护鉴权、前台异常退出回收及网页登录/新建终端/命令输出验证；tmux 保留按同一专属 socket 的真实 server/pane PID 另行取证。
- 静态与回归：Shared/CLI/Backend/App Server 类型及 lint、架构、配置治理、文档检查、19 条 YAML 格式检查，以及 Backend 生命周期、Activity、定时任务（含维护租约真实 SQLite/子进程）、App Server 集成脚本通过。Activity 验证需清除安装态继承的 worker entry 后运行，避免混用旧 worker。
- 验证回执位于 `artifacts/npm-server/verification.json`；真实系统服务注册/开机、Linux/x64、桌面连接及安装态强制更新取消执行的端到端用例仍未执行，不能据此声明整份 YAML 已通过。所有本轮创建的浏览器、服务和 tmux fixture 已清理。

## 11. CLI 与 Server 分包修正

按后续确认重构为两个独立 NPM 产品：`@runweave/cli` 是唯一的全局 rw 提供者；Server 不注册 rw、不捆绑 CLI。
Server 实际组件启动入口迁至 `packages/runweave-server/src/runtime.ts`；CLI 只通过包定位、安装记录和管理合同管理其生命周期。
新增 `scripts/release/build-cli.mjs`，源码构建输出独立 CLI 分发包；Server 构建输出独立 Server 与平台资源包。
安装态验证增加 CLI 单独安装、两个包同前缀安装、更新 Server 前后 rw 路径/版本/字节不变，以及源码产物/NPM 交替激活。
当前合同以 `docs/cli/server-cli.md` 为准；前文 Server 携带 rw 及 CLI 自更新的实现描述已被本修正替代。

- 分包重构最终验证通过：macOS arm64 真实 CLI/Server tarball 独立安装、CLI 单独安装、Server 不携带 CLI、不注册 rw、Server 更新前后 rw 路径/版本/哈希不变；源码 0.1.2 fixture 与 NPM 0.1.1 fixture 可在同一实例交替激活。
- 最终 Server 系统服务定义直接指向 `current/server/index.cjs` 并通过 plutil；类型、lint、架构、配置治理、文档检查和 20 条 YAML 格式校验通过。回执：`artifacts/npm-server/refactor-verification.json`。本轮未发布 NPM，未执行真实系统服务注册或其他平台验收。
