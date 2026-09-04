# Terminal Workspace Services

Workspace Services 为当前 Terminal Project Context 中的本地开发服务提供稳定入口。它解决
Worktree 并行开发时目标端口会变化、Browser Tab 却需要稳定身份的问题；它不是生产域名模拟器，
也不是通用脚本编排平台。

## 三层访问模型

```text
Direct
  └─ 真实网站，例如 https://www.coze.cn

Workspace Service
  └─ 本机开发服务，例如 http://web--wt-1--project-<id>.localhost:5001

Exact Origin Proxy
  └─ 需要生产域名、Cookie、OAuth、CORS 或 HSTS 语义时显式使用 Whistle
```

Workspace URL 成功只证明 Local Origin 行为；不能作为生产 Origin 验收证据。

## 仓库合同

在 Project Context 根目录提交 `runweave.json`：

```json
{
  "schemaVersion": 1,
  "services": {
    "web": {
      "command": "pnpm dev -- --host 127.0.0.1 --port \"$RUNWEAVE_SERVICE_PORT\" --strictPort",
      "cwd": ".",
      "healthCheck": {
        "path": "/"
      }
    }
  }
}
```

配置只声明长驻 HTTP 服务。页面加载和配置发现不会执行命令；用户必须在 Terminal Header 的
`Services` 中显式 Start。V1 不支持 setup、teardown、普通 scripts、依赖 DAG、自定义端口、自动启动
或自动重启。

约束如下：

- 文件必须是最大 256 KiB 的 UTF-8 JSON 普通文件，不能是 symlink；只接受
  `schemaVersion: 1`，未知字段 fail closed。
- 最多声明 12 个服务；service key 匹配 `^[a-z][a-z0-9-]{0,31}$`。
- `command` 最大 4096 字符，通过 `/bin/sh -lc` 执行。
- `cwd` 默认 `.`，必须是 Context 根目录内已存在的真实目录；绝对路径和 symlink 越界被拒绝。
- `healthCheck.path` 可选；存在时要求 HTTP 200–399，否则以 TCP connect 成功判定 ready。
- Runweave 注入 `HOST`、`PORT`、`RUNWEAVE_SERVICE_*` 与同配置 peer URL。服务仍需遵守
  `HOST=127.0.0.1`；这不是进程网络沙箱。

## 身份、端口与代理

```text
parentProjectId + NUL + projectId + NUL + serviceName
                         │
                         ├─ SHA-256 前 12 位 → 稳定 identity
                         └─ readable slug      → *.localhost hostname

stable hostname + Backend port
                         │
                         ▼
Backend Host router ─────────────► 127.0.0.1:<本次动态 targetPort>
                      HTTP + WebSocket
```

同一服务每次 Start 从 OS 申请动态目标端口，但公开 URL 在 Backend 端口和 Project 身份不变时保持
稳定。同名服务按 `parentProjectId + projectId + serviceName` 隔离，因此兄弟 Worktree 不共享目标。
已知但非 ready 的 Host 返回 503；未知的 Workspace 形态 Host 返回 404，不进入 SPA fallback。

HTTP 与 WebSocket 都只转发到 manager 中 ready record 的 `127.0.0.1:<targetPort>`。入口仅接受
loopback TCP peer，并拒绝携带 `Forwarded`、`Via`、`X-Forwarded-*` 或 `X-Real-IP` 的请求。
控制 API 还必须通过现有用户认证。

## 生命周期与并发

```text
stopped ──Start──► starting ──ready──► ready
                      │                  │
                      └────failure───────┤
                                         ▼
                                       failed

starting / ready ──Stop──► stopping ──► stopped
```

Start 在 mutation lock 内重新读取配置并匹配 UI 提交的 SHA-256 revision，过期 UI 不能执行旧命令。
运行中配置变化只标记 `staleConfig`；旧实例继续运行，显式 Stop/Start 后才采用新命令。

Backend 通过带 IPC 的 Node supervisor 拥有服务进程组：Stop 先发 SIGTERM，3 秒后仍存活则发
SIGKILL；正常 Backend shutdown 调用 manager `dispose()`，Backend 崩溃时 IPC disconnect 也回收
服务及孙进程。不写 PID 文件，不扫描端口，也不终止未拥有的外部进程。

Project/Worktree 删除与 Start 共享 Context guard。活跃服务会让删除以
`workspace_service_active` 失败；删除先持有 guard 时，新 Start 以 `context_deleting` 失败。

## Browser 网络与 UI

Terminal Browser Profile 仍只有 `whistle | direct` 两种 Proxy Mode。Electron Session 的 bypass 为
`<local>,*.localhost`：Workspace URL 在两种模式下都必须解析为 `DIRECT`；Whistle 模式的普通外部
URL 仍解析到该 Profile 的固定 Whistle 端口。每次 `setProxy()` 后主进程都通过 `resolveProxy()`
自检，失败时不宣告切换成功。

Services popover 只查询当前 active Context：静止状态每 3 秒刷新，starting/stopping 每 1 秒刷新。
Open 仅在 ready 时可用；Electron 使用 Worktree preferred Profile（否则全局默认 Profile）创建新
Browser Group，并保持 runtime route unassigned；普通本机 Web 使用新标签页。

## 代码与验证入口

- 共享协议：`packages/shared/src/terminal/workspace-service.ts`
- Backend 状态机：`backend/src/terminal/workspace-service/manager.ts`
- HTTP/WS Host 代理：`backend/src/terminal/workspace-service/proxy.ts`
- Desktop UI：`frontend/src/components/terminal/workspace/workspace-services-popover.tsx`
- Electron 网络策略：`electron/src/terminal-browser-network.ts`
- 协议 verifier：`pnpm workspace-services:verify`
- 真实验收合同：`docs/testing/terminal/workspace-services.testplan.yaml`

实现验证还应执行 Backend、Frontend、Electron 与 Shared 的 typecheck/lint、
`pnpm architecture:check`、`pnpm docs:check`。涉及 UI 或 Browser 行为时必须使用受管 Dev Session 和
Playwright CLI 取证；静态门禁或 verifier 不能替代真实桌面证据。
