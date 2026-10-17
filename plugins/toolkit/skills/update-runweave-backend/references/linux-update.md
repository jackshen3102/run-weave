# Linux 更新入口与 systemd 细则

以下路径均相对目标 Runweave 仓库根目录。先读当前源码与就近规则，命令里的占位符必须替换为已核对值；不要把本文示例当成目标机器已经存在的 unit、用户或安装目录。

## 已有更新入口

| 组件           | 入口与需要核对的实现                                                                                                                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend + Web  | `pnpm backend:release -- --release-id=<唯一标识>`；`scripts/release/build-backend.mjs`、`scripts/install/backend.mjs`、`scripts/release/backend-start.mjs`                          |
| App Server     | `pnpm app-server:install --instance <实例> --config-dir <绝对配置根> --release-id=<唯一标识>`；`scripts/install/app-server.mjs`、`packages/runweave-cli/src/commands/app-server.ts` |
| 全局 CLI       | `pnpm cli:publish:local`；`scripts/update/cli.mjs`、`scripts/release/cli-artifact.mjs`                                                                                              |
| Linux MCP 构建 | `pnpm --filter @runweave/mcp build`；`packages/runweave-mcp/scripts/build.mjs`、`packages/runweave-mcp/README.md`                                                                   |
| 飞书 Bridge    | CLI 构建产物中的 `rw feishu bridge --instance <实例> --config-dir <绝对配置根> --json`；`docs/deployment/feishu-app-integration.md`                                                 |
| 其他已部署服务 | 读所属包 README/部署文档及实际 unit；随记、网关、快照分享不共用一个安装命令                                                                                                         |

### Backend

按 `docs/deployment/backend-standalone.md` 在匹配目标的环境安装锁定依赖并构建。产物位于 `.runtime-artifacts/backend-standalone/<release-id>.tar.gz`，解压后由服务用户执行包内 `install.mjs --home=<实际 runtime 根>`。安装器校验平台、ABI、文件摘要及原生模块，再切换 `current` 链接；安装成功尚未重启进程。

当前独立 Backend 安装器不检查实例 YAML 的 schema/域兼容性，不能把 App Server 安装器的配置保护推定到它。切换前使用同源码基线构建的 CLI 对目标实例执行 `config validate`，结合候选 Backend 的配置域和实际启动检查确认可用；CLI 校验通过仍不替代 Backend 启动及业务验证。回退也要检查旧包对现有配置和数据的支持，不能只凭安装器返回成功认定兼容。

systemd 应运行包内 `current/start.mjs`，保留真实 `--instance`、`--config-dir` 及所需启动参数。启动器同时设置 Web 目录及 SQLite worker 路径；只指向 `backend/index.cjs` 会漏掉这层装配。运行数据置于 release 之外，旧包保留用于兼容回退。

源码部署先检查当前 package scripts 与 unit 引用的产物位置，避免构建覆盖正在运行版本的依赖。容器部署按现有镜像/Compose 流程准备同基线镜像，再使用既有编排切换，不在容器内永久修改发行目录。

### App Server：前台进程交给 systemd

安装脚本会返回 `release.entry`、`release.releaseId`、`release.runtimeRoot` 与状态根；保存这些值。`rw app-server status --instance <实例> --config-dir <配置根>` 可核对已安装 runtime 与当前 owner。

`app-server:install` 没有只构建或 dry-run 模式：它会构建 CLI、安装 App Server 并切换 `current.json`。独立通道或任务排空等切换条件未满足时，仅做依赖、源码和构建入口检查，不用这个命令“提前准备”真实实例。进入已授权安装阶段后，先保存旧 runtime 指针与 unit，旧 owner 保持运行，完成安装并核对新产物后才停止旧 owner；安装失败先查实际指针与 owner，不能假定完全没写入。需要提前验证完整安装时，使用隔离测试实例和独立 runtime 根；遵循配置身份限制，不把生产实例的配置复制到任意目录冒充测试实例。

`rw app-server start` 使用 detached 子进程，不应直接填进 `Type=simple`/`exec` 的 `ExecStart`。`Type=oneshot` 加 `RemainAfterExit` 也不能监测这个子进程是否仍健康。

需要补齐 systemd 时让它直接运行安装器返回的绝对 `release.entry`，例如 `ExecStart=<Node绝对路径> <release.entry> --instance <实例> --config-dir <配置根>`，并保留 CLI 启动器采用的发布身份变量：

- `RUNWEAVE_APP_SERVER_ENTRY` = 本次 entry
- `RUNWEAVE_APP_SERVER_RELEASE_ID` = 本次 releaseId
- `RUNWEAVE_APP_SERVER_RUNTIME_ROOT` = 本次 runtimeRoot
- `RUNWEAVE_APP_SERVER_SOURCE` = `global`

状态根由实例配置中的 `appServer.stateDirectory` 决定。不要另指定一份状态目录；`--home` 也不能覆盖不匹配的配置根。每次安装后按返回值更新 unit/drop-in 中固定的 entry 与身份变量，不能只切换 `current.json` 后继续运行旧 entry。实现依据为 `app-server/src/config.ts` 和 `packages/config-node/src/app-server/runtime-release.ts`。

用 drop-in 替换 `ExecStart` 时先写空的 `ExecStart=` 清除原命令，再写新命令；校验包含原 unit 与全部 drop-in 的有效配置，不能只验证覆盖文件的片段。

首次接管先识别原 owner：已有 systemd owner 用原 unit 停止；真正的 detached owner 用同用户同实例的 `rw app-server stop` 停止。确认旧 owner 退出后才启动新 unit，保留 singleton 锁机制，不删锁强占。接管后启停统一由 systemd 完成，避免再用 `rw app-server restart` 产生第二个 owner；`status` 仍可用于验证。

当前 `rw app-server stop` 等待超时后仍可能返回 `stopped: true`。保存原 PID/启动身份，结合进程存活检查和重新读取的 status/lock 确认旧 owner 已退出；PID 仍存在或身份无法判定时先排查，不把命令回执当成退出证据。

### CLI 与配套服务

在服务用户的环境执行 `cli:publish:local`。它核对登录 shell 的 `rw`、npm prefix 与包内容；遇到 shim/PATH 冲突先定位，不用 sudo 装进另一套 prefix 来绕过。更新后同时核对登录 shell 与 systemd 的实际路径，检查 Hook 是否仍绑定旧 runtime CLI。版本号相同不能代替构建摘要一致。

Linux 不能使用当前 `research-mcp:install` / `rw research-mcp install/start/stop` 的 macOS 常驻流程：实现使用 `/bin/launchctl`。已有 Linux MCP 应构建并完整部署 `dist`（包括 native lock runtime、release 元数据），保留原 unit、实例、cwd、端口与认证；需要补托管时按包的前台 Node 入口建立 Linux unit。隧道沿用现有 profile/key 与实际可用启动入口，先查该版本 CLI 帮助，避免与已有后台管理器双重托管，不新建 tunnel 身份。MCP 就绪后再验证隧道及真实远端工具调用，缺失远端验证时明确覆盖范围。

飞书 `node` 属于 Backend；只有 `hub`/`standalone` 才托管 Bridge。CLI 更换文件后，长驻 Bridge 进程仍需通过原 owner 重启。中心 Hub 可能服务其他机器，更新前说明影响；不能因本机是 node 就重启远端 Hub。

## systemd：识别、修改和验证

先用只读查询识别具体 unit；下列命令针对已确认的系统级 unit，用户级命令须在实际服务用户的 manager 中加 `--user`：

```bash
systemctl list-unit-files --type=service --no-pager
systemctl list-units --type=service --all --no-pager
systemctl show <unit> -p FragmentPath -p DropInPaths -p User -p Group \
  -p Type -p MainPID -p ActiveState -p SubState -p UnitFileState \
  -p Restart -p NRestarts -p KillMode -p Result
```

随后定向读取 unit/drop-in 的 ExecStart、WorkingDirectory、配置及依赖，过滤敏感值。即使 unit 未运行也要纳入盘点；同一机器可有多个实例，不把其中一个的健康当成全部健康。

需要补齐托管时：

- 系统级 unit 优先沿用原服务用户，设置实际 `User`/`Group`、绝对 Node/入口路径、可访问的 WorkingDirectory、HOME 和必要 PATH。实例参数显式写入，不能依赖交互 shell 的 nvm 初始化或当前目录；不为了安装方便把业务改为 root 运行。
- 持续运行的 Node 入口采用 `Type=simple` 或目标 systemd 支持的 `Type=exec`，配置有退避的 `Restart=on-failure`，启动后另做健康等待。仅 `After=` 表示排序，不能证明上游可用，也不会自动拉起上游；按实际拓扑选择 Wants/Requires 与应用重连，避免给可降级依赖制造硬性级联停服。
- Backend 为保留终端进程需要 `KillMode=process`，且旧进程确实采用 tmux `preserve`。该例外不复制到其他 daemon；不要附加清理全部 tmux 的 ExecStop。尊重定时任务排空所需的停止时间，不能用短超时强杀来获得重启成功。
- 系统级服务通常由 `multi-user.target` 启动；用户级服务通常由 `default.target` 启动。用户级跨登出/开机运行还需要目标用户的 linger，先查 `loginctl show-user <用户> -p Linger`，在本次授权和系统权限内按需 `loginctl enable-linger <用户>`。只执行 `systemctl --user enable` 不能证明未登录时会启动。
- 写入前保留原文件并用 `systemd-analyze verify <候选 unit 路径>` 校验；使用正确 manager 的 `daemon-reload`，对本次应启用服务执行持久 `enable`，再按依赖启动/重启。已有 enable/mask/停用意图逐项核对，不批量 unmask、enable 所有匹配项。
- 若已有 supervisor/Compose 可满足持久运行，先沿用并检查其开机入口与恢复策略。迁移 manager 前准备具体文件、明确唯一 owner 和回退路径；本技能不要求为统一形式重建已经正常工作的部署。

systemd 语义参考：[服务类型与进程跟踪](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml)、[用户 linger](https://github.com/systemd/systemd/blob/main/man/loginctl.xml)。执行时同时核对目标机器安装版本的帮助。

## 停止条件与恢复

发现目标不明、控制通道会随服务消失、必需产物未准备好、配置无法兼容、旧任务无法安全排空时，先完成不依赖该条件的准备，再报告具体缺口；不要通过停用鉴权、删除数据/锁、杀端口占用者或强制 Git reset 来继续。

有安全回退条件时恢复原发布入口和 unit/drop-in，reload 后按依赖启动，再重跑实际健康与业务检查；保留失败候选及诊断证据。配置/schema 不兼容时不能把“切回旧包”称为已恢复。更新中断后重新读取实际指针、unit 和 owner，以现状继续，不凭上次日志重放整套操作。
