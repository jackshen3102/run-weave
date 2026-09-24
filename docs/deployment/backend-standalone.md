# 独立 Backend 发布与安装

虚拟机上的 Backend 与桌面内置 Backend 来自同一份源码，但原生模块使用不同的运行时 ABI。
独立发布包由目标 Linux 系统、架构、libc 与 Node 22 环境构建；桌面包由 Electron
版本和 macOS 架构构建。运行中的安装流程不调用 npm，也不读取全局 npm 包。

## 构建与安装

在与目标机器匹配的构建环境中：

```bash
corepack enable
pnpm install --frozen-lockfile --ignore-scripts
pnpm backend:release -- --release-id=2026.09.24-001
```

`--ignore-scripts` 避免依赖安装阶段运行 `better-sqlite3` 的 `node-gyp rebuild`；发布构建
和安装器会在目标环境加载包内的原生文件，缺失或不兼容时直接失败。

产物位于 `.runtime-artifacts/backend-standalone/2026.09.24-001.tar.gz`。每次构建使用新的
release ID。将其传到目标机器并
解压，在目标机器以运行 Backend 的用户执行：

```bash
tar -xzf 2026.09.24-001.tar.gz
node 2026.09.24-001/install.mjs --home=/opt/runweave/backend-runtime
```

安装器核对目标系统、架构、Node 原生模块 ABI、文件清单与 SHA-256，再加载 SQLite 和
node-pty 做安装检查。文件先复制到 `releases/<唯一版本号>`，检查通过后才切换 `current`
符号链接。已安装的旧版本保留，可用旧发布包重新执行安装命令来回滚。

目标机器应安装 `tmux` 供 Terminal 使用。用 Node 22 启动 `current/start.mjs`，例如在 systemd 中设置
`ExecStart=/usr/bin/node /opt/runweave/backend-runtime/current/start.mjs`；先用
`command -v node` 确认实际路径，并确保服务用户可写安装目录。
服务必须配置 `AUTH_USERNAME`、`AUTH_PASSWORD`、`AUTH_JWT_SECRET`；长期运行还应按
[部署概览](./overview.md#后端重启与终端保活)配置 tmux 保活策略。浏览器 Profile、
Activity、Evolution 和定时任务数据放在发布目录之外，更新时沿用原路径和运行用户。

切换链接不会替换已运行的进程。重启服务后检查 `/health`、前端页面和实际业务接口。
构建产物只保证与 manifest 中记录的目标匹配；从 macOS 构建出的包不能安装到 Linux
虚拟机。目标机器上的 Node 原生模块 ABI 与构建时不一致时，安装器会拒绝安装。

构建入口见 [`build-backend.mjs`](../../scripts/release/build-backend.mjs)，安装入口见
[`backend.mjs`](../../scripts/install/backend.mjs)。

## 通过 Agent 维护远端环境

SSH 连接使用服务器上已有的 Backend。安装依赖、配置服务和更新版本由 Agent 根据
实际环境引导或执行，桌面连接管理不承担远端安装和升级，Release CI 不分发 Linux 安装包。

已有仓库的服务器按以下流程维护：

1. 确认仓库位置、Git 状态，以及服务实际使用的用户、启动命令、环境文件和数据目录。
   沿用该服务的 `HOME`、`CODEX_HOME` 和 Agent 登录态；SSH 登录用户不一定是服务运行用户。
2. 确认所需代码已提交到 GitHub，在服务器仓库拉取目标分支最新代码。保留本地改动，
   出现分叉时先处理差异，不强制重置。
3. 按现有启动方式安装锁定依赖并构建。独立发布包方式使用本文的构建与安装命令；
   源码方式沿用仓库的启动入口。远端 Agent 使用的 `rw` CLI 也应从同份源码构建。
4. 重启已有服务，检查健康接口，再实际验证项目、终端和 Agent。复用原有账号、
   数据目录及 tmux socket，避免另建一套环境造成项目或登录态丢失。

新机器由 Agent 根据系统缺少的依赖逐项准备。Pi 的配置见
[Pi 环境初始化](./pi-agent-setup.md)，服务与终端保活见
[部署概览](./overview.md#后端重启与终端保活)。
