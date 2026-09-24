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
