# Runweave

[English](README.md)

Runweave 是一个本地优先的 AI CLI 终端工作台。它帮助你在桌面、浏览器、CLI
和手机之间运行、观察、接力和继续处理长时间运行的命令行任务，例如 `codex`、
`claude`、shell 命令和项目脚本。

![Runweave terminal management demo](docs/assets/readme/runweave-terminal-management.gif)

当真实工作发生在终端里时，Runweave 会很有用：AI CLI 正在改代码，开发服务正在
运行，命令正在等待输入，或者其他同事/Agent 需要一种稳定方式从当前终端上下文继续
工作。

> 注意：部分包名、存储 key 和内部标识仍然使用 `browser-viewer`。在单独完成代码
> 级重命名前，请把它们视为技术标识。

## Runweave 能做什么

### 终端工作台

- 创建项目和终端会话。
- 运行任意 CLI 命令，包括 `codex`、`claude`、`opencode`、shell 命令和项目脚本。
- 查看实时终端输出、切换终端，并向已有会话继续发送输入。
- 将终端任务和浏览器 Viewer 会话分开管理，让 Agent 工作流成为独立入口。

### 长任务连续性

Runweave 面向长时间运行的终端任务设计。当本地环境支持可恢复终端会话时，你可以继
续观察或重新接回仍在运行的任务。如果当前环境不支持恢复路径，Runweave 仍然可以作
为普通的托管终端工作台使用。

Runweave 不承诺任务可以跨机器销毁或容器销毁继续存在，也不语义化证明某个 AI 任务
已经完成。

### 桌面端和 Web

- 本地开发或自托管部署时使用 Web 应用。
- 本地桌面工作流使用 Electron 客户端。
- Electron 客户端支持连接管理，可以从一个客户端连接不同 Runweave 后端。

### Runweave CLI

`rw` 是给人和外部 Agent 使用的命令行入口。它可以登录、确认项目存在、创建终端、
列出会话、读取快照、生成接力上下文，并向已有终端发送输入。

源码仓库内使用：

```bash
pnpm cli:build
node packages/runweave-cli/dist/index.js auth login \
  --base-url http://127.0.0.1:5001 \
  --username admin
```

当 CLI 已经 link 或安装为 `rw` 后：

```bash
rw auth status --json
rw project ensure --name my-project --path "$PWD" --json
rw terminal create --project-id "$PROJECT_ID" --cwd "$PWD" --json
rw terminal send "$TERMINAL_ID" --text "codex" --enter --confirm short --json
rw terminal snapshot "$TERMINAL_ID" --tail 120 --plain
rw terminal handoff "$TERMINAL_ID" --tail 120 --json
```

`send --confirm short` 确认的是输入已经投递或被短暂观察到，不代表 AI 任务已经完成。

### 移动 App

Runweave 的移动端工作流由专门的 App 客户端承载：

- 查看项目、终端会话、状态和最近活动。
- 必要时直接从 App 打开某个终端，进行手机端输入。
- 移动端 UI 与 API 契约和 Web 桌面前端保持分离。

旧的 Web 移动端页面已删除。App 首页数据由仅服务 App 的 `/api/app/home/overview`
接口提供。

### iOS App 命令

本地模拟器调试和真机构建使用不同命令：

```bash
# 本地模拟器调试，支持 live reload。
# 会启动本地 backend 和 App Vite dev server。
pnpm app:dev:ios

# 本地后端 + 静态 iOS build/sync/open。
# 不支持 live reload。
pnpm app:ios:local

# 真机/固定后端构建，后端地址来自 app/.env.local。
# 不启动 backend，也不支持 live reload。
pnpm app:ios:device
```

真机构建前，复制 `app/.env.example` 为 `app/.env.local`，并把
`VITE_RUNWEAVE_API_BASE` 设置为后端地址。`app/.env.local` 已被 git 忽略，本机域名
或局域网地址不会提交到仓库。

## 快速开始

```bash
pnpm install
cp backend/.env.example backend/.env
pnpm dev
```

常用开发变体：

```bash
# 使用可见浏览器调试
BROWSER_HEADLESS=false pnpm dev

# 启动后端、前端和 Electron
pnpm dev:electron
```

## 本地部署

生产风格本地运行：

```bash
cp backend/.env.example backend/.env
pnpm build
pnpm start
```

`pnpm start` 会启动后端服务，默认绑定到 `127.0.0.1:5001`。生产风格部署建议放在
反向代理后面。部署细节见
[docs/deployment/overview.md](docs/deployment/overview.md)。

关键环境变量：

- `AUTH_USERNAME`：登录用户名。示例文件使用 `admin`。
- `AUTH_PASSWORD`：登录密码。共享服务前请替换示例值。
- `AUTH_JWT_SECRET`：认证 token 签名密钥。
- `FRONTEND_ORIGIN`：CORS 允许的前端来源。
- `BROWSER_PROFILE_DIR`：持久化浏览器/session 数据目录。
- `TERMINAL_SESSION_STORE_FILE`：持久化终端会话存储路径。
- `BROWSER_HEADLESS`：浏览器 headless 模式开关。

Electron mac 打包：

```bash
pnpm dist:electron:mac
```

## 文档

| 主题           | 链接                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------ |
| CLI            | [docs/cli/terminal-cli.md](docs/cli/terminal-cli.md)                                       |
| 部署           | [docs/deployment/overview.md](docs/deployment/overview.md)                                 |
| 终端恢复       | [docs/architecture/terminal-tmux-recovery.md](docs/architecture/terminal-tmux-recovery.md) |
| 架构与网络拓扑 | [docs/architecture/network-topology.md](docs/architecture/network-topology.md)             |
| 测试命令       | [docs/testing/command-matrix.md](docs/testing/command-matrix.md)                           |

## 验证

```bash
pnpm typecheck
pnpm lint
pnpm test:e2e
pnpm test
```

前端正式自动化验证以 E2E 为主。README-only 工作不要在 `frontend/src` 下新增前端
单测。

## License

MIT
