# NPM 服务端管理

`@runweave/cli` 唯一提供 rw 命令，`@runweave/server` 提供后台及网页资源；rw 的 `server` 命令组管理独立安装的 Server。
Server 不注册全局命令，也不携带一份 CLI；升级 Server 不替换 rw。
安装组件、配置、运行进程是三个独立状态，`npm install` 不注册或启动服务。
第一阶段一台机器一个 Stable 服务，支持 Node 22，macOS arm64/x64、Linux glibc arm64/x64 为构建目标。
已有源码部署的 App Server 占用实例时，Server 启动会被拒绝，保留原 App Server 发布指针和发布目录；
Server 仅在取得 App Server 实例所有权并通过占用检查后激活其发布，启动期间持续持有该所有权。
具体平台是否已验收以发布证据为准，不以存在 CI 矩阵当作通过。

## 安装、初始化与运行

```bash
npm install -g @runweave/cli @runweave/server
rw server init
rw server doctor --json
rw server start
```

`init` 复用现有 Stable 配置、认证及数据路径；重复执行不会覆盖配置。交互模式询问账号并生成强密码，
只向终端显示一次；非交互需 `--auth-file /absolute/private.json`，JSON 含 username 与至少 16 字符的 password，
文件必须仅当前用户可读。默认监听 127.0.0.1:5001，可通过初始化的 `--host`、`--port` 设置远程入口。
独立服务初始化显式选择 `storage.activityKeyStorage=file`：Activity 加密密钥以 0600 权限保存在 Activity 数据目录，不依赖 macOS 登录 Keychain。已有内容缺失原密钥时拒绝创建替代密钥。
后续配置调整沿用 [配置 CLI](./configuration.md)，不另设服务端配置文件。

CLI 单独安装时，status/doctor 返回 Server 未安装及安装指引，其他已有业务命令不受影响。
doctor 检查 Server 发行组件、SQLite/PTY 原生加载及外部工具，区分基础服务、终端和 Agent 登录可用性。
Pi 认证须按 provider 配置，不把仅安装工具当成认证成功。外部工具不自动安装。
前台运行两个组件，必需组件异常会结束前台会话；Ctrl-C 关闭服务但保留 tmux。

## 生命周期命令

| 命令                                           | 合同                                                                                    |
| ---------------------------------------------- | --------------------------------------------------------------------------------------- |
| `rw server status --json`                      | 返回安装、active、running 版本，组件 PID/健康、路径、托管启用状态与最近更新回执         |
| `rw server stop`                               | 停止本产品持有的组件，保留 tmux 与数据                                                  |
| `rw server restart [--force]`                  | 重启原模式；有受影响后台执行时默认拒绝                                                  |
| `rw server logs [--follow]`                    | 系统托管日志末尾或持续跟随；前台日志在原终端                                            |
| `rw server service install [--dry-run]`        | 生成或注册系统级 systemd/launchd 服务，启用开机运行并启动；dry-run 不提升权限或注册     |
| `rw server service uninstall`                  | 注销并停止系统服务，保留配置和数据                                                      |
| `rw server update [--version X.Y.Z] [--force]` | 从配置的 npm registry 下载并激活发行版，默认 latest；在原运行模式重启，停止态不自动启动 |

注册系统任务需要管理员权限，进程仍以执行命令的服务用户运行。不要用 sudo 把配置账号切换成另一个用户。
全局 npm prefix 必须可写；更新不自动提升 npm 权限。后台连续失败按管理器限速；显式 stop 不自动拉起。
macOS 使用系统 LaunchDaemon，不把登录启动当开机启动。

## 发行与更新

主包带轻量入口，精确版本的平台包带网页、JS、原生模块与辅助二进制。
首次运行物化完整不可变版本到 `<configRoot>/server/releases/`，`current` 指向 active 版。
所有持久业务数据沿用现有配置，放在发行目录之外。控制 socket 放在当前 UID 私有的短路径目录，避免 macOS socket 路径上限。

更新命令由独立 CLI 执行，不修改 CLI 自身安装。流程为下载和预检、维护租约、停止、npm 安装、current 切换、
原模式重启及健康核对。直接 npm 安装不触发重启，status 会显示分发版本与 active/running 的差异。
第一阶段使用保守的数据合同指纹；只有存储/配置合同指纹相同的版本可激活，不进行逆向迁移或自动回退。

普通 tmux 中的 Agent 不阻挡更新，但重启期间 HTTP/WS 暂断，正在调用服务 API 的请求可能失败。
服务托管执行通过本机维护租约保护：先暂停新领取、等待在途领取结束，再列出实际存活执行。
仅 queued/waiting 或已转交 tmux 的持久记录不因此阻挡。force 只绕过任务保护，不能绕过原生加载、校验和或数据兼容检查。
维护接口需要本机来源与私有管理令牌，普通网页登录凭据没有维护权限。租约 120 秒，客户端每 30 秒续租；客户端丢失后自动恢复派发。

失败后查看 `<configRoot>/server/update.json` 与日志；不会自动切回旧版。
可重新安装 NPM 分发包后用 `update --version` 恢复兼容版本。原前台会话在激活时仍由原控制进程持有，失败后保留控制入口供 stop/retry。

## 源码与验证入口

```bash
pnpm server:build
pnpm server:verify-installed
```

build 生成 `.runtime-artifacts/server/cli-package`、`package` 与当前平台包，分别是独立 CLI、Server 入口包和平台资源；不安装到本机，不发布 registry。
`pnpm cli:release` 可单独构建 CLI 分发包。
verify 使用真实 tarball、本机 loopback npm registry 与隔离用户目录 fixture 验证安装和更新；
升级目标 0.1.1、0.1.2 是同一代码的版本 fixture，不代表真实公网版本。该结果不等同于系统服务安装、开机或真实客户端交互验收。
完整验收见 [NPM 服务端测试计划](../testing/platform/npm-server.testplan.yaml)。

## 包定位与源码激活

`<configRoot>/server/installation.json` 记录受管理的 Server 包路径。没有记录时，先查与 CLI 同前缀的全局 Server，
再查询 npm 全局目录。也可用 `--server-package <绝对包目录>` 选择源码构建产物；不依赖当前工作目录。
Server 不存在时不会让 rw 的其他命令依赖 Server，也不会自动联网安装。

```bash
# 使用源码构建同一种 Server 安装产物
pnpm server:build
rw server init --server-package /absolute/repo/.runtime-artifacts/server/package
# 后续源码更新与 NPM 更新共用保护、停止、激活和重启流程
rw server update --server-package /absolute/repo/.runtime-artifacts/server/package
rw server update --version 0.1.0
```

首次注册可在 init/start 指定路径；已有安装切换来源使用 update，避免绕过运行中任务保护。
从源码来源切回 NPM 时，若原安装没有全局 npm prefix，发行包安装到 `<configRoot>/server/npm/`，仍由同一条安装记录管理。
CLI 与 Server 版本独立，通过发行清单的 `managementApiVersion=1` 检查兼容性。
系统任务直接启动 `current/server/index.cjs`；Agent 使用的实例私有 rw wrapper 指向独立 CLI，而非 Server 的 current 目录。
