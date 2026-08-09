# 代码地图与架构索引

本目录描述 Runweave 的**当前系统事实**。先用本页确定运行时和链路，再按需进入专题文档；
历史方案、计划和原型不能替代这里的当前合同。

## 运行时地图

```text
                    ┌──────────────────────────┐
                    │ packages/shared          │
                    │ 跨运行时 DTO / 事件 / 协议 │
                    └────────────┬─────────────┘
                                 │
       ┌──────────────┬──────────┼───────────┬──────────────┐
       ▼              ▼          ▼           ▼              ▼
 frontend/         app/       backend/    electron/      app-server/
 Web/Electron UI   Ionic App  HTTP/WS +    桌面主进程      全局事件与
                              Terminal     + Browser      Thread 状态
                              控制面        + IPC
       │              │          ▲           │              ▲
       └────── HTTP / WebSocket ─┘           └─ 进程/IPC ────┘

 packages/common/             Web 与 App 当前共同使用的前端实现
 packages/terminal-renderer/  终端 React/xterm 渲染层
 packages/runweave-cli/       `rw` 参数化控制面客户端
 scripts/dev-session/         隔离开发会话、Beta Pool 与 surface 生命周期
```

## 目录职责

| 目录                          | 当前职责                                                       | 首要入口                                    |
| ----------------------------- | -------------------------------------------------------------- | ------------------------------------------- |
| `frontend/`                   | Web UI 与 Electron renderer                                    | `frontend/src/App.tsx`                      |
| `backend/`                    | 本机 HTTP/WebSocket、Terminal、Agent Team、Activity、Evolution | `backend/src/index.ts`                      |
| `electron/`                   | macOS 窗口、IPC、内嵌 Browser、Backend 进程与更新              | `electron/src/main.ts`                      |
| `app/`                        | Ionic React + Capacitor 移动客户端                             | `app/src/App.tsx`                           |
| `app-server/`                 | 独立事件中心、Thread 状态投影和实时消费                        | `app-server/src/index.ts`                   |
| `packages/shared/`            | 跨运行时纯 TypeScript 合同                                     | `packages/shared/package.json#exports`      |
| `packages/common/`            | Web 与 App 真实复用的前端实现                                  | `packages/common/AGENTS.md`                 |
| `packages/terminal-renderer/` | 终端 React/xterm 渲染                                          | `packages/terminal-renderer/src/index.ts`   |
| `packages/runweave-cli/`      | `rw` CLI                                                       | `packages/runweave-cli/src/index.ts`        |
| `scripts/dev-session/`        | Dev Session / Beta Pool 控制面                                 | `scripts/dev-session/cli.mjs`               |
| `plugins/toolkit/`            | Runweave 项目技能与 hooks                                      | `plugins/toolkit/.codex-plugin/plugin.json` |

改动某个目录前继续读其就近 `AGENTS.md`；完整清单以
`git ls-files '**/AGENTS.md' 'AGENTS.md'` 为准。

## 依赖方向

- UI 运行时通过 `@runweave/shared` 使用协议，不导入 Backend 或 Electron 实现。
- `frontend/` 通过 HTTP/WebSocket 连接 `backend/`；在桌面形态下仅通过 preload bridge 请求
  Electron 主进程能力。
- `app/` 通过 Backend API 工作，不依赖 Electron。
- `backend/` 通过 `backend/src/app-server/` 消费 App Server，不把 App Server 并入自身状态。
- `packages/shared` 不依赖具体运行时；`packages/common` 不承载协议、存储或 Node/Electron 能力。
- 机械边界由 `pnpm architecture:check` 校验；本文只维护人和 Agent 需要的语义地图。

## 按任务阅读

### 系统与跨端

| 任务                                    | 文档                                                       |
| --------------------------------------- | ---------------------------------------------------------- |
| 网络拓扑、Backend 与 Electron 连接      | [network-topology.md](./network-topology.md)               |
| App 移动端连接、页面和安全边界          | [app-mobile.md](./app-mobile.md)                           |
| App Server 总体架构                     | [app-server-architecture.md](./app-server-architecture.md) |
| App Server Event Center 与 Work History | [app-server-event-center.md](./app-server-event-center.md) |
| 本机系统资源监控                        | [system-monitor.md](./system-monitor.md)                   |

### Terminal

| 任务                                 | 文档                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------ |
| Terminal 状态来源与消费              | [terminal-state.md](./terminal-state.md)                                       |
| Worktree Project Context             | [terminal-worktree-context.md](./terminal-worktree-context.md)                 |
| 文件、Diff、Markdown 与 Browser 预览 | [terminal-code-preview.md](./terminal-code-preview.md)                         |
| tmux 持久化与恢复                    | [terminal-tmux-recovery.md](./terminal-tmux-recovery.md)                       |
| 完成事件 Hook                        | [terminal-completion-hooks.md](./terminal-completion-hooks.md)                 |
| 桌面与飞书完成通知                   | [terminal-completion-notifications.md](./terminal-completion-notifications.md) |

### Agent 系统

| 任务                     | 文档                                                         |
| ------------------------ | ------------------------------------------------------------ |
| Agent Team / Loop Engine | [multi-agent-orchestrator.md](./multi-agent-orchestrator.md) |
| Agent Self-Evolution     | [agent-self-evolution.md](./agent-self-evolution.md)         |

## 维护规则

- 新增跨运行时当前合同时更新本页；单一目录的入口与限制优先写入该目录 `AGENTS.md`。
- 专题文档链接真实源码与验证命令，不复制可从代码直接读出的长实现清单。
- 新增或移动文档后运行 `pnpm docs:check`。
