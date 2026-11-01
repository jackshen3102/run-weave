---
name: update-runweave-backend
description: 通过 npm 更新 Linux 机器上的 Runweave CLI、Backend、Web 与 App Server，检查服务、登录、任务保活和开机自启；旧源码部署先迁移到 npm。用于“升级远程机器到最新版”“更新服务器 CLI 和服务”及无桌面后台；发布 npm 新版本使用 publish-runweave-server，不用于 macOS、桌面端、手机端或 Dev Session。
---

# 更新 Runweave Linux 后台

纯服务端统一使用 npm 发行包，不在服务器 git pull、编译或运行源码安装器升级。
旧源码部署先执行一次迁移，随后进入相同的 npm 升级流程；本地 Mac 桌面端仍保留源码更新，
由其专属流程处理。CI 从源码构建发行包，不属于目标机器的源码升级。

## 范围与入口

读取目标仓库的 `AGENTS.md`、`docs/deployment/npm-server-operations.md`、
`docs/cli/server-cli.md`、`docs/cli/configuration.md` 和 `docs/cli/service-management.md`。
服务器本身不需要源码仓库；按本技能及已安装 CLI 的帮助操作。
旧源码部署另读 `docs/deployment/backend-standalone.md` 的一次性迁移流程。

每次整套更新都建立下表。状态只能是待更新、已更新、已一致、不适用或受阻，并记录依据；缺少安装不能直接记为“不适用”。

程序更新状态与运行/自启状态分列。用户主动停用只说明应保留 disabled/inactive，不证明程序版本已一致；若其程序属于本次更新范围，离线更新并保留停用状态，未核对版本前不能标“已一致”。

| 组件                     | 默认处理                                                                   |
| ------------------------ | -------------------------------------------------------------------------- |
| Backend 与 Web 静态资源  | 必查、一起更新；包含 Activity、Evolution、定时任务 workers 和原生依赖      |
| App Server               | 必查、更新安装与运行进程；缺少时补齐所需配置和托管，无法补齐则报告受阻     |
| 全局 `rw`                | 必查，更新服务用户实际使用的入口及被服务/Hook 固定引用的入口               |
| Research MCP、隧道       | 已部署或目标明确需要时纳入，分别检查程序、配置、运行与自启                 |
| 飞书 Bridge              | `hub`/`standalone` 纳入独立服务；`node` 随 Backend 更新，不另起 Bridge     |
| 快照分享、其他配套服务   | 对照实际 unit、容器、配置与进程补入，不限于固定名称                        |
| 随记、推送网关等独立产品 | 属于用户指定目标时纳入；同机存在也先说明归属，不因“整套后台”跨机器批量更新 |

定时任务调度、Activity、Evolution 是 Backend 能力，不为它们另造 daemon。代理与隧道通常验证原配置和运行即可；不顺便升级操作系统、第三方 Agent CLI 或重新申请凭据。保留用户明确停用的服务，不借更新重新启用。

## 1. 识别目标与恢复条件

- 确认 Linux 主机、服务运行用户、实例、配置根、Backend profile、安装来源及目标 npm 版本。SSH 用户不等于服务用户；profile 不会把本地文件操作变成远程操作。
- 记录已安装、active、running 版本及 sourceRevision，核对 registry 的目标精确版本和平台包。旧源码部署只记录当前基线及恢复材料，保留仓库和本地修改，不执行源码升级。
- 查 systemd 的已安装 unit 和运行 unit，也查用户级 unit、容器及手动进程；不能只看当前活跃服务或按名字含 `runweave` 筛选。记录真实 unit、owner、ExecStart、数据路径、运行版本、启用状态和依赖。检查输出前过滤 unit/进程参数中的凭据，不打印完整环境文件或进程环境。
- 保留原 HOME、CODEX_HOME、配置、Agent 登录态、Backend 身份、tmux socket、数据库和 Activity 正文密钥。备份配置、unit/drop-in、旧发布指针与可回退产物；运行中数据库使用其一致性备份方法，不把普通文件复制当成完整备份。
- 检查目标 Node、架构、libc、ABI、磁盘、依赖工具和权限；Server 使用匹配目标环境的 Node 22 平台包。容器或没有 systemd 的环境沿用已有 supervisor；报告不能执行 systemd 分支，不用 `nohup` 冒充开机自启。
- 维护通道必须能在 Backend/Bridge/MCP 停止后继续使用，例如独立 SSH。若当前 Agent 只能通过待更新服务控制主机，先建立可恢复的独立通道，再切换；不让更新切断唯一控制路径。

先向用户简述目标、组件清单、目标版本、预计中断与恢复方式。已有整套更新授权时继续执行，不重复索要许可；目标机器或实例确实无法确定时才询问。

## 2. 升级或迁移

已由 `rw server` 管理的实例按 [NPM 机器升级](references/npm-update.md) 固定 CLI/Server 两个目标版本，
在原 prefix 升级 CLI，再用 `rw server update --version` 升级服务。
版本已一致且运行正常时不重新安装或重启。不重复 init、service install 或手动切换 current。

旧源码或独立 Backend 包部署按仓库的 `docs/deployment/backend-standalone.md` 完成一次性迁移。
先准备公开 npm 产物、备份和恢复条件，再停止原 owner；不对运行中的实例直接强行接管。
缺少兼容的平台发行包时报告具体缺口，交给发布流程解决，不退回服务器源码构建。

配置调整使用 `runweave-management`，保留 CAS 与敏感值私有输入。核对旧进程实际采用的
`terminal.tmux.shutdownPolicy=preserve` 与 Backend unit 的 `KillMode=process`；
只修改配置不能保护仍采用 cleanup 的旧进程，需先排空任务或采用已验证的迁移方式。

## 3. 服务托管与配套能力

按 [systemd 检查](references/systemd.md) 核对唯一 owner、身份、持久自启与恢复条件。
新装/迁移使用 `rw server service install --dry-run` 审查生成配置，再注册；正常更新复用现有托管。
已有容器或 supervisor 时保留其持久启动机制，进程使用已发布 npm 产物，不叠加第二套 owner。

独立 Hub/MCP/隧道按实际归属核对兼容性、配置、运行与自启。未包含在 Server npm 包的独立程序，
不假定随包更新，也不调用旧源码安装器补齐；若本次明确要求更新，使用它自己的受支持发行入口，
缺少发行产物则报告受阻，不把单独产品的失败掩盖为整套完成。保留用户主动停用的服务。

每次切换后检查实际进程与健康。异常时停止后续切换，依据实际状态修复；
回退前检查数据/schema 与配置兼容性，不自动回滚数据库、覆盖新增数据或启动遗留 unit 抢占实例。

## 4. 验证更新与开机恢复

逐项取得证据，不能只看安装返回值或 `systemctl is-active`：

- **版本**：实际进程的 entry、release/build ID、sourceRevision 或产物摘要对应目标基线；`command -v rw`、`rw version --json` 对应服务用户和 unit 使用的 CLI。
- **服务**：检查目标 unit 的 MainPID、退出结果、重启次数和本轮日志；App Server owner 与 systemd MainPID 一致，Backend 能连接它。保留原身份、配置路径与数据路径。
- **业务**：通过真实 profile 检查 `rw health`、`rw status`、项目/终端只读查询及已启用能力。状态快照不能覆盖独立服务时另行检查。浏览器交互验收使用 `playwright-cli`；没有执行就明确未验收，不能用 HTTP 200 代替 Web 可用。消息投递或向已有 Agent 输入不是默认验收动作。
- **会话**：对比升级前后 tmux server、pane、任务 PID 和输出，确认所声明的 Backend 重启保活；定时任务同时检查排空/恢复状态，不重放业务任务来制造成功。
- **自启配置**：逐项核对持久 enable 状态及启动依赖；用户级服务还须检查 linger。保留显式停用意图。静态 unit 须证明有持久启动依赖，`enabled-runtime` 不算跨重启生效。
- **整机重启**：只有用户已授权重启该机器时才执行。先保存检查清单、boot ID、基线和重连方式；重连后核对 boot ID 已改变，在手动启动任何服务之前检查全部服务和业务。补启动成功只能算修复，不能算该次自动恢复通过。

没有实际整机重启时报告“自启配置已检查，整机重启未验证”，不因此阻止交付已完成的更新。整机重启会终止 tmux/Agent 进程；服务自启不承诺原业务任务自动续跑，也不要配置开机自动拉取代码或再次更新来代替启动已安装版本。

## 交付

报告目标机器/实例、目标 npm 版本与 sourceRevision、每个组件的旧新版本、安装与运行结果、自启配置和业务验证。将“运行验证通过”“自启配置通过”“整机重启验证通过”分开，说明未覆盖项及失败后的实际状态。任一必需组件受阻时不能宣布整套完成；无需为本技能运行安装或更新其他 skill。
