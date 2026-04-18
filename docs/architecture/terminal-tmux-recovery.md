# 终端 tmux 可恢复方案

本文描述一种以 tmux 作为会话保活层的终端改造方案。目标是在客户端更新、客户端重启、后端进程重启、服务端滚动部署等场景下，尽量保留正在运行的交互式终端任务，例如 `codex` TUI。

## 背景

当前 Runweave 的终端链路可以抽象为：

```text
frontend / Electron
  -> backend process
    -> node-pty runtime
      -> shell / codex TUI
```

这条链路的问题是，用户任务直接活在 node-pty runtime 下面。无论触发方是 Electron 客户端更新、手动重启 packaged backend，还是服务端部署时停止旧 backend，当前 backend shutdown 都会 dispose 所有 terminal runtime，最终 kill 掉 node-pty 下的 shell 或 TUI。

关键代码路径：

- Electron packaged 模式下，`electron/src/updater.ts` 更新下载完成后会调用 `autoUpdater.quitAndInstall()`。
- Electron packaged 模式下，`electron/src/main.ts` 的 `before-quit` 会执行 `packagedBackendRuntime?.stop()`。
- Electron packaged 模式下，`electron/src/backend-runtime.ts` 的 `stop()` 会给 packaged backend 子进程发送 `SIGTERM`，超时后 `SIGKILL`。
- `backend/src/index.ts`：后端收到 `SIGTERM` 后调用 `terminalRuntimeRegistry.disposeAll()`。
- `backend/src/terminal/runtime-registry.ts`：`disposeAll()` 对每个 runtime 调用 `disposeRuntime()`。
- `backend/src/terminal/pty-service.ts`：node-pty runtime 的 `dispose()` 最终调用 `ptyProcess.kill()`。

前端已有 WebSocket 自动重连能力，后端也会在 runtime 缺失时尝试重新 spawn 终端，但当前重新 spawn 的是原始 shell 命令，不能恢复已在运行中的 `codex` TUI。

## 目标

- 客户端更新、客户端重启、后端进程重启或服务端滚动部署后，tmux-backed 终端里的 shell、TUI、长任务继续运行。
- 新 backend 启动后能基于持久化的 terminal session 重新 attach 到同一个 tmux session。
- 默认所有新终端走 tmux-backed runtime，只有 tmux 不可用或显式禁用时才降级为普通 node-pty runtime。
- 明确区分“attach client 断开”和“用户终端会话结束”，避免误标记为 exited。
- 同一套 runtime 语义同时覆盖 Electron packaged、本地独立 backend、长期运行的服务端 backend。

## 非目标

- 不承诺更新或部署期间 UI 完全无感。窗口重启、页面重载、WebSocket 断线仍会发生。
- 不在首期实现完整 terminal daemon 化。
- 不用 tmux 直接替代 node-pty。node-pty 仍负责把 WebSocket 输入输出桥接到系统 PTY。
- 不强制打包或内置 tmux。首期可以先检测运行环境中的 tmux，缺失时降级为普通 node-pty 终端并明确标记该 session 不具备 tmux 恢复能力。
- 不解决整个机器、VM、容器、Pod 被销毁后的恢复。tmux server 必须存活，或者至少运行在不会被本次 deploy 销毁的宿主环境中。

## 核心原理

tmux 的进程模型是：

```text
tmux client
  -> tmux server
    -> session / window / pane
      -> shell / codex TUI
```

`tmux attach` 启动的是一个 client。client 退出不等于 session 退出。真正的 shell 或 TUI 运行在 tmux server 管理的 session 里。

改造后的 Runweave 链路是：

```text
xterm.js
  -> WebSocket
    -> backend
      -> node-pty
        -> tmux attach client
          -> tmux server/session
            -> shell / codex TUI
```

当客户端更新、backend 重启或服务端 deploy 导致 backend 退出时，被杀的是：

```text
backend -> node-pty -> tmux attach client
```

但 tmux server/session 仍然存在：

```text
tmux server/session -> shell / codex TUI
```

新 backend 启动后，只要能从持久化记录恢复 `terminalSessionId -> tmux session name` 的映射，并且 tmux server/session 仍在，就可以重新启动一个 node-pty，再执行 `tmux attach` 接回原 session。

## 适用部署形态

tmux 方案适用于“backend 进程被替换，但 tmux server 没有被替换”的场景。

### Electron packaged 本地模式

Electron 主进程可以重启 packaged backend，甚至客户端本身可以更新重启。只要 tmux server 和 terminal session store 放在稳定用户数据目录里，新 packaged backend 就能 attach 回旧 tmux session。

### 本地独立 backend 模式

用户通过 `pnpm start`、systemd、launchd、pm2 或其他方式运行 backend 时，backend 进程重启不会天然杀掉 tmux server。只要 terminal session store 和 tmux socket 路径稳定，恢复模型和 Electron packaged 模式一致。

### 服务端部署模式

服务端模式也适合这个方案，但有部署前提：

- 新旧 backend 在同一台机器或同一个持久化运行环境中接管 terminal。
- tmux server 运行在 deploy 单元之外，不能随着旧 backend 容器或 Pod 一起被销毁。
- terminal session store 和 tmux socket 目录必须是稳定持久化路径。
- rolling deploy 或 restart 只替换 backend 进程，不清理 tmux socket 和 tmux server。

如果服务端以容器或 Kubernetes Pod 方式部署，并且 tmux server 跑在同一个会被替换的容器里，那么 Pod 重建时 tmux server 也会消失，方案无法保住正在运行的 TUI。此时需要把 terminal runtime 放到独立 sidecar、host-level daemon、StatefulSet 固定实例，或回到更完整的 terminal daemon 方案。

## 会话映射

最小映射规则：

```text
terminalSessionId -> tmux session name
```

建议使用确定性命名：

```text
tmuxSessionName = runweave-<terminalSessionId>
```

tmux server 隔离建议使用专用 socket。实验期可用：

```bash
tmux -L runweave ...
```

产品化时更建议使用 `-S <socket-path>`，socket 放在 Runweave 稳定用户数据目录里，避免和用户自己的 tmux server 混用，也避免不同项目或版本之间互相污染。

注意：当前 backend 默认存储路径由 `backend/src/utils/path.ts` 基于 `process.cwd()` 计算。若客户端更新、服务端发布或启动目录变化导致 cwd 变化，terminal store 和 tmux socket 位置都可能不稳定。tmux 方案产品化前，需要给 backend 显式传入稳定的数据目录。Electron packaged 模式可通过 Electron `app.getPath("userData")` 设置 `TERMINAL_SESSION_STORE_FILE` 和 tmux socket 根目录；服务端模式应通过环境变量或部署配置挂载固定目录。

## 数据模型

当前 terminal session 主要字段在 `backend/src/terminal/manager.ts` 和 `packages/shared/src/terminal-protocol.ts` 中定义，状态只有：

```ts
status: "running" | "exited";
```

tmux 改造建议增加内部 runtime 维度，用来记录每个 session 实际使用的是 tmux-backed runtime，还是因 tmux 不可用而降级到普通 pty runtime：

```ts
type TerminalRuntimeKind = "pty" | "tmux";

interface TerminalRuntimeMetadata {
  runtimeKind: TerminalRuntimeKind;
  tmuxSessionName?: string;
  tmuxSocketPath?: string;
}
```

首期可以只在后端持久化这些字段，不一定马上暴露到 shared protocol。需要 UI 展示“tmux 已启用 / 已降级为普通终端”时，再扩展 `TerminalSessionListItem`。

状态语义建议保持用户可见的 `running | exited` 不变，但后端内部需要增加 attach 状态判断：

```text
running + runtime attached       -> 当前 WebSocket 可输入输出
running + tmux session alive     -> 后端 runtime 缺失，但可恢复
running + tmux session missing   -> 原会话丢失，记录日志、重建 tmux session 并提示用户
exited                           -> 用户会话已结束
```

关键规则：tmux-backed 终端中，node-pty attach client 退出不等于 terminal session exited。必须先检查 tmux session 是否仍存在。

## 后端改造

### 1. 增加 tmux runtime adapter

新增一个后端模块，例如：

```text
backend/src/terminal/tmux-service.ts
```

职责：

- 检测 tmux 是否可用。
- 生成 session name 和 socket path。
- 创建或 attach tmux session。
- 检查 session 是否存在。
- 结束 session。
- 构造 node-pty 需要 spawn 的命令和参数。

建议接口：

```ts
interface TmuxService {
  isAvailable(): Promise<boolean>;
  getUnavailableReason?(): Promise<string | null>;
  buildSessionName(terminalSessionId: string): string;
  withSessionLock<T>(
    terminalSessionId: string,
    action: () => Promise<T>,
  ): Promise<T>;
  hasSession(target: TmuxTarget): Promise<boolean>;
  buildAttachCommand(
    target: TmuxTarget,
    cwd: string,
  ): {
    command: string;
    args: string[];
  };
  killSession(target: TmuxTarget): Promise<void>;
}
```

首期 attach 命令可以是：

```bash
tmux -L runweave new-session -A -s runweave-<terminalSessionId> -c <cwd>
```

或使用专用 socket：

```bash
tmux -S <socket-path> new-session -A -s runweave-<terminalSessionId> -c <cwd>
```

`new-session -A` 的好处是同一条命令既能首次创建，也能在 session 已存在时 attach。

但 `new-session -A` 不是并发控制。两个 backend 实例，或同一 backend 内两个请求，几乎同时对同一个 session name 执行该命令时，可能出现一个创建成功、另一个 attach 成功，最终同一个 tmux session 有两个 attach client。tmux 会把输出广播给多个 attach client，这可能导致重复订阅、重复 WebSocket output、重复 metadata/activity 事件，或状态判断混乱。

`TmuxService` 需要提供 session-level lock 或等价的幂等保护：

- 单进程内：用 `Map<terminalSessionId, Promise>` 串行化同一 session 的 create/attach/delete。
- 多 backend 实例或服务端部署：用文件锁、数据库锁、或部署层保证同一 terminal session 同一时间只有一个 backend owner。
- lock 范围至少覆盖 `has-session`、`new-session -A`、runtime registry create、recorder/subscriber 绑定。
- 如果发现 runtime 已存在或已有 owner，后续请求应复用现有 runtime，不能再创建新的 attach client。

### tmux 不可用判定

“tmux 不可用”不只表示 `tmux` 命令不存在。只要当前运行环境无法稳定完成创建、检测、attach、kill session 的闭环，都应视为不可用，并降级为 `runtimeKind: "pty"`。

建议判定条件：

- 平台不是 macOS/Linux 等 Unix-like 环境。
- `tmux` 命令不在 PATH 中，或配置的 `TMUX_BINARY` 路径不可执行。
- `tmux -V` 执行失败，或版本低于后续确定的最低支持版本。
- 专用 socket 目录无法创建、不可写，或权限不满足当前 backend 用户访问。
- `tmux new-session -d -s <probe>`、`tmux has-session -t <probe>`、`tmux kill-session -t <probe>` 任一步 probe 失败。
- 服务端部署模式下，tmux socket 或 session store 不在稳定持久化目录中，无法保证新 backend 接管。
- 环境变量显式禁用，例如 `TERMINAL_TMUX_ENABLED=false`。

不可用判定应在 backend 启动或首次创建 terminal 时完成并缓存短时间结果。创建 session 时必须把实际结果写入 session metadata：

```text
tmux available     -> runtimeKind = "tmux"
tmux unavailable   -> runtimeKind = "pty", recovery = false, unavailableReason = ...
```

降级可以保证终端仍可使用，但不能承诺进程重启恢复。UI 和更新保护逻辑必须基于 session 的实际 `runtimeKind`，而不是基于当前机器上是否安装了 tmux。

fallback 到 `runtimeKind: "pty"` 时，行为必须和现状保持一致：继续直接通过 node-pty 启动 shell，继续使用当前 runtime recorder 和 Runweave persisted scrollback，继续沿用当前 exit、history drawer、delete session 语义。fallback pty 只是没有 tmux 恢复能力，不应该引入 tmux-backed 的关闭即删除历史语义。

### 2. 修改创建终端流程

当前创建终端在 `backend/src/routes/terminal.ts`：

1. `terminalSessionManager.createSession(...)` 创建持久记录。
2. `ptyService.spawnSession(...)` 启动原始 shell。
3. `runtimeRegistry.createRuntime(...)` 注册 runtime。
4. `runtimeRegistry.ensureRecorder(...)` 通过 runtime output 记录 Runweave 自己的 scrollback。

默认创建流程改为 tmux-first：

1. 创建 session 前检测 tmux 是否可用。
2. tmux 可用时，创建 session 并写入 `runtimeKind: "tmux"` 和 tmux metadata。
3. 使用 `tmuxService.buildAttachCommand(...)` 生成 `tmux new-session -A ...`。
4. 在 session-level lock 内确认没有现存 runtime 或 owner。
5. 仍通过 `ptyService.spawnSession(...)` 启动这个 tmux attach command。
6. 仍注册到 `TerminalRuntimeRegistry`，前端 WebSocket 链路不需要大改。

tmux 不可用或被显式禁用时，才创建 `runtimeKind: "pty"` 的 fallback session，并继续走现有普通 node-pty 流程。fallback 不应静默伪装成可恢复终端，后端需要把实际 runtime kind 持久化下来，后续恢复和更新保护都以该字段为准。除“不承诺 tmux 恢复”之外，fallback pty 的功能和数据语义与当前实现保持一致。

tmux-backed session 不再需要 Runweave 自己维护持续追加的 scrollback。`runtimeRegistry.ensureRecorder(...)` 可以只保留给 fallback pty session，或后续删除与 tmux-backed runtime 的绑定。tmux-backed session 的运行中历史统一从 tmux pane history 读取。

### 3. 修改 runtime 缺失时的恢复逻辑

当前 `backend/src/ws/terminal-server.ts` 在 WebSocket 连接时，如果 session 是 `running` 且 runtime 不存在，会调用 `ptyService.spawnSession(...)` 重新启动原始命令。

tmux 改造后逻辑应变为：

```text
if runtime exists:
  use runtime
else if session.runtimeKind == "tmux":
  if tmux session exists:
    spawn node-pty -> tmux attach
  else:
    log loss, create a fresh tmux session, notify user
else if session.runtimeKind == "pty":
  treat as fallback pty session and do not promise recovery
```

这一步是 backend 重启或部署切换后接回原终端的核心。

`TmuxService.hasSession()` 需要区分正常 missing 和 tmux 命令失败：

- `has-session` 正常返回不存在：说明原 tmux session 已消失。
- `tmux` 命令执行失败、socket 损坏、tmux server 被 kill 或 crash：同样按原 session 不可 attach 处理。

这两类情况都不再把 Runweave session 直接标记为 exited。处理策略是：

1. 记录后端错误日志，包含 `terminalSessionId`、tmux session name、socket path、命令退出码和 stderr。
2. 在同一个 `terminalSessionId` 下重新执行 `tmux new-session -A -s <name>`，创建一个新的 tmux session。
3. 通过 WebSocket `error` 或新增状态事件提醒前端：原 tmux 会话已丢失，已创建新的终端会话，之前运行中的任务和 tmux history 无法恢复。
4. 新 session 继续保持 `runtimeKind: "tmux"`，后续仍具备 tmux-backed 恢复能力。

也就是说，tmux server 异常退出时优先恢复可用性，而不是保留一个不可操作的 terminal tab。用户需要被明确告知这是“重新开了一个会话”，不能假装接回了原来的 `codex` TUI。

同时需要防止 tmux 持续 crash 时进入“重建 -> crash -> 重建”的循环。建议为每个 `terminalSessionId` 维护重建退避状态：

- 记录最近 60 秒内的 tmux session 重建次数。
- 如果同一 session 在 60 秒内重建超过 3 次，停止自动重建。
- 停止重建后，通过 WebSocket `error` 或新增状态事件向用户报错，说明 tmux 持续异常，终端已停止自动恢复。
- 该 session 标记为 `exited` 或 `recoverable=false`，避免后续 WebSocket 连接再次触发重建循环。
- 后端日志需要包含重建次数、窗口期、最后一次 tmux 错误、socket path 和 session name。

### 4. 修改 exit 语义

当前 `TerminalRuntimeRegistry` 会把 runtime exit 透传给 subscriber，`createTerminalRuntimeRecorder` 中会调用 `terminalSessionManager.markExited(...)`。

tmux-backed 模式下需要拦截：

```text
node-pty exit
  -> check tmux has-session
    -> exists: detach only, keep status running
    -> missing/error: log loss, create fresh session, notify user
```

优先建议在后端 terminal runtime 层集中处理，并让 tmux-backed runtime 不再绑定 `createTerminalRuntimeRecorder` 的持续 scrollback 记录职责，避免 WebSocket 层和 recorder 层各自理解 tmux 语义。fallback pty session 可以继续使用现有 recorder。

### 5. 删除终端时明确 kill tmux session

当前删除终端会调用 `runtimeRegistry.disposeRuntime(...)`，再 `terminalSessionManager.destroySession(...)`。

tmux-backed 终端删除时应额外执行：

```bash
tmux kill-session -t runweave-<terminalSessionId>
```

否则用户点击删除只是断开 attach client，tmux session 和里面的任务仍会留在后台。

同理，删除 project 时要 kill project 下所有 tmux-backed session。

## Scrollback 策略

采用方案 A：运行中完全复用 tmux pane history；关闭终端即删除历史，不做 final snapshot。

具体语义：

```text
tmux-backed session running:
  snapshot/history 来自 tmux capture-pane

backend offline / deploy switching:
  tmux session 继续维护 pane history

user closes terminal:
  tmux kill-session
  delete Runweave session metadata
  do not persist final scrollback
```

后端需要把以下读取路径改为 tmux-first：

- WebSocket 初始 snapshot：从 `tmux capture-pane` 读取 pane history，而不是读取 Runweave scrollback 文件。
- `/api/terminal/session/:id/history`：tmux-backed session 运行中读取 `tmux capture-pane`。
- `/api/terminal/session/:id` live scrollback：tmux-backed session 运行中读取 `tmux capture-pane`。

建议 capture 命令形态：

```bash
tmux capture-pane -p -J -S -5000 -t runweave-<terminalSessionId>
```

如果需要尽量保留样式，可评估 `-e`：

```bash
tmux capture-pane -e -p -J -S -5000 -t runweave-<terminalSessionId>
```

但 `capture-pane` 仍然不是原始 PTY 字节流，不承诺作为审计日志或完整 ANSI 重放来源。它的定位是给用户恢复最近上下文和当前 TUI 画面。

需要使用 Runweave persisted scrollback 的场景只保留给 `runtimeKind: "pty"` fallback session。tmux-backed session 关闭后历史即删除；如果用户需要长期历史，应另行导出日志，而不是依赖 terminal scrollback。

fallback pty session 不适用本节的 tmux scrollback 策略：它继续使用现有 Runweave scrollback 文件、history drawer 和关闭/删除行为。

## 更新与部署行为

tmux-backed 终端允许客户端更新、backend 重启和服务端部署后恢复，但不等于可以无提示中断当前连接。建议分层处理。

### Electron 更新保护

在 `electron/src/updater.ts` 的“更新已就绪”阶段，前端或主进程需要知道当前是否存在因 tmux 不可用而降级的 pty fallback 终端：

```text
no active terminal:
  allow immediate restart
only tmux-backed active terminal:
  allow restart, copy should say terminals will reconnect
has fallback pty active terminal:
  warn or block immediate restart
```

如果短期拿不到准确 runtime kind，先保守处理：存在 running terminal 时提示“稍后安装”，避免误杀。

### 服务端部署保护

服务端部署应避免把旧 backend 和 tmux server 作为同一个销毁单元。推荐策略：

```text
stop accepting new WebSocket
close or drain old WebSocket connections
keep tmux server/session alive
start new backend with the same terminal store and tmux socket path
frontend reconnects to new backend
new backend attaches tmux session on demand
```

如果部署系统必须销毁整个容器或 Pod，应把 tmux server 移出该销毁单元，否则 tmux-backed 终端仍会断。

服务端还需要 tmux session GC，避免 deploy、异常退出或删除流程中断后留下孤儿 session。推荐策略：

- 周期性枚举 Runweave 专用 socket 下的 `runweave-*` tmux session。
- 读取 terminal session store，构建仍有效的 `tmuxSessionName` 集合。
- 如果 tmux server 上存在 `runweave-*` session，但 session store 中没有对应记录，则视为 orphan。
- orphan session 先记录日志和指标，再执行 `tmux kill-session -t <name>` 清理。
- GC 需要和 create/attach/delete 共用 session-level lock，避免刚创建但 metadata 尚未落盘的 session 被误删。
- 首期可以只在 backend 启动时执行一次 dry-run 日志；产品化后再启用定期清理。

### 恢复链路

新 backend 启动后读取同一份 terminal session store。前端进入 `/terminal/:id` 后通过现有 `useTerminalConnection` 建立 WebSocket。后端发现 runtime 缺失，但 tmux session 仍在，就 attach 回去。

前端自动重连逻辑可以继续复用：

- `frontend/src/features/terminal/use-terminal-connection.ts`
- `frontend/src/components/terminal/terminal-surface.tsx`
- `frontend/src/components/terminal/terminal-headless-connection.tsx`

## 性能与前端交互边界

tmux 不替代现有终端性能优化。tmux 解决的是 backend 或客户端重启时用户任务不死；现有性能优化解决的是浏览器渲染、WebSocket 输出处理、快照竞态和高频日志开销。这些层级不同，首期应全部保留。

首期明确不改变 inactive terminal 的前端交互：

- `TerminalSurface` 仍只承担 active 或缓存 surface 的完整 xterm 渲染。
- `TerminalHeadlessConnection` 仍用于 inactive terminal 的 activity、bell、metadata 监听。
- terminal tab 的活动点、响铃提示、metadata 更新语义保持现状。
- `useTerminalConnection` 的自动重连、pending input、resize 发送逻辑保持现状。
- stale snapshot 防护继续保留；snapshot 来源从 Runweave scrollback 变为 `tmux capture-pane` 后，仍可能与 live WS output 并发。
- 后端 output batching 和高频 perf log gating 继续保留。
- `tmux capture-pane -p -J -S -5000` 必须纳入性能基线。它是 tmux-backed WebSocket 初始 snapshot 的关键路径，不能只验证功能正确性。

因此，首期只调整后端 runtime、恢复、删除和 scrollback 读取逻辑，不把 inactive terminal 改成 detached-on-inactive，也不移除现有前端性能优化。等 tmux-backed 恢复链路稳定后，再用现有 terminal performance benchmark 评估是否有必要进一步减少 inactive terminal 的 WebSocket/node-pty attach。

## 体验风险

### TERM 与终端能力

tmux 内部 `$TERM` 通常是 `screen`、`tmux` 或 `tmux-256color`，可能影响颜色、鼠标、光标模式和部分快捷键。需要实测 `codex` TUI、vim、less、top、ssh。

### 快捷键冲突

tmux 默认 prefix 是 `Ctrl-b`。如果用户 TUI 依赖相关按键，可能被 tmux 捕获。产品化时可以使用 Runweave 专用 tmux 配置，降低冲突。

首期应在 Runweave 专用 tmux 配置中显式处理 prefix，例如 unbind 默认 `C-b` 或改成不会影响常见 TUI 的组合键。否则 `Ctrl-b` 可能无法透传给 `codex`、vim 或 shell readline。

### 滚动历史

tmux-backed session 的滚动历史来自 tmux pane history，不再由 Runweave 持续持久化。关闭终端会删除 tmux session，也会删除历史。这会改变现有“关闭后还能查看历史”的语义。

Runweave 专用 tmux 配置首期统一设置 `history-limit 5000`，和现有 Runweave client scrollback 行数保持一致。长输出任务超过 5000 行后，tmux 会截断早期历史；该历史是运行中上下文，不是长期日志。

### 嵌套 tmux

用户可能在 Runweave 终端中手动再启动 tmux，形成 tmux inside tmux。因为方案默认所有可用环境都走 tmux，这个风险需要通过专用 tmux 配置、文案提示和必要时的环境级禁用开关处理，而不是作为常规用户选项暴露。

## 分阶段计划

### 阶段 1：受控实验

- 增加 `TmuxService`，只支持 macOS/Linux 等 Unix-like 环境。
- 后端检测 tmux 可用性。
- Runweave 专用 tmux 配置设置 `history-limit 5000`。
- 默认创建终端时使用 `tmux new-session -A`。
- 为同一 terminal session 的 create/attach/delete 加 session-level lock，避免并发创建多个 attach client。
- tmux 不可用时降级到 `runtimeKind: "pty"`，并记录该 session 不具备恢复能力。
- fallback pty session 与现状保持一致，继续使用当前 recorder、persisted scrollback 和删除语义。
- WebSocket runtime 缺失时 attach 同名 tmux session。
- 删除终端时 kill 对应 tmux session。
- tmux-backed session 的 snapshot/history 改为读取 `tmux capture-pane`。
- 删除终端时不保存 final scrollback。
- 保留现有 inactive terminal 交互和前端性能优化，只改后端 runtime、恢复、删除和 scrollback 读取逻辑。
- 暂不改 UI，只通过环境变量验证本地 backend、Electron packaged、同机服务端 backend restart 三种入口。

成功标准：

- 启动 `codex` TUI 后，手动杀 backend。
- 确认 `codex` TUI 仍在 tmux session 中运行。
- 重启 backend 后打开同一 terminal session，可以重新 attach。
- 并发触发同名 tmux session 的创建或 attach 时，只产生一个有效 runtime owner；如果允许多个 attach client，必须证明输出、metadata 和 cleanup 语义符合预期。
- 确认 tmux 内部 `$TERM` 值，例如 `tmux-256color` 或 `screen-256color`，不会导致 xterm.js 颜色、光标、alternate screen、鼠标模式出现明显异常。
- 确认 `Ctrl-b` 不会被 tmux 默认 prefix 截获；Runweave 专用 tmux 配置需要 unbind 默认 prefix 或改成安全 prefix，并验证 TUI 内 `Ctrl-b` 可正常透传。
- 在 pane history 满 5000 行时，`tmux capture-pane -p -J -S -5000` 执行耗时应低于 200 ms。该命令位于 WebSocket 初始 snapshot 关键路径，超过阈值会让用户感知到终端打开变慢。

### 阶段 2：状态语义与 UI

- session store 持久化 `runtimeKind` 和 tmux metadata。
- UI 展示实际 runtime 状态：tmux 已启用，或已降级为普通 pty。
- Electron 更新前区分 tmux-backed 终端和 fallback pty 终端。
- 服务端部署文档明确 tmux socket 和 terminal store 的持久化要求。
- 处理 tmux attach client exit 不误标记 exited。
- history drawer 对 tmux-backed session 读取 tmux pane history；session 删除后不再可读。
- 不改变 `TerminalHeadlessConnection` 的 inactive activity/bell/metadata 行为。

### 阶段 3：产品化

- 使用稳定用户数据目录存 terminal store 与 tmux socket。
- 完善 tmux 缺失提示、降级逻辑和环境级禁用开关。
- 增加专用 tmux 配置，降低快捷键和终端能力冲突。
- 评估是否打包 tmux binary。
- 评估服务端 host-level tmux daemon、sidecar 或 StatefulSet 部署形态。
- 调整或移除 tmux-backed session 的 Runweave scrollback 文件写入路径。

## 验证方案

后端单测：

- `TmuxService` session name 生成稳定。
- `TmuxService` 对同一 terminal session 的 create/attach/delete 串行化。
- tmux session GC 能识别 session store 中不存在的 `runweave-*` orphan session，并在锁保护下清理。
- tmux 不可用时返回明确错误。
- `tmux capture-pane -p -J -S -5000` 在满 5000 行 pane history 下有性能基线测试，记录耗时并校验低于 200 ms。
- tmux-backed runtime exit 且 `has-session=true` 时不 mark exited。
- tmux-backed runtime exit 且 `has-session=false` 时重新创建同名 tmux session 并生成用户提示。
- tmux-backed runtime exit 且 `has-session` 命令失败时记录日志、重新创建同名 tmux session，并生成用户提示。
- 同一 session 在 60 秒内 tmux 重建超过 3 次时，停止自动重建，标记不可恢复/退出，并向用户返回明确错误。
- 删除 terminal session 时调用 kill-session。
- tmux-backed session 不调用持续 append scrollback recorder。
- tmux-backed session 的 history API 返回 `capture-pane` 内容。
- 删除 tmux-backed session 后 history API 不再返回历史。
- fallback pty session 的 recorder、history API、delete session 行为与现状一致。
- inactive terminal 的 activity/bell/metadata 回调保持现状。

集成测试：

- 创建 tmux-backed session 后，runtimeRegistry 中注册的是 node-pty attach runtime。
- WebSocket 连接时 runtime 缺失且 tmux session 存在，可以 attach。
- WebSocket 连接时 runtime 缺失且 tmux session 不存在，会创建新的 tmux session 并提示原会话已丢失。
- WebSocket 连接时 runtime 缺失且 tmux server/socket 异常，会记录日志、创建新的 tmux session，并提示原会话已丢失。
- tmux server 持续 crash 时不会无限重建；超过退避阈值后，新 WebSocket 连接收到明确错误，不再触发自动恢复。
- 并发创建同名 tmux session 时不会注册多个 backend runtime owner，也不会产生重复 output/subscriber。
- backend 启动或定时 GC 时，session store 中无记录的 `runweave-*` tmux session 会被记录并清理，不影响有记录的 session。
- tmux-backed WebSocket 初始 snapshot 使用满 5000 行 pane history 时，capture-pane 和发送首个 snapshot 的耗时可观测，且不超过 200 ms 的阶段 1 阈值。

E2E/手工回归：

- 在 tmux 不可用的机器或显式禁用 tmux 的环境中新建终端，行为与当前 node-pty 版本完全一致，无功能回退。
- `codex` TUI 运行中，重启 Electron 客户端后重新接回。
- `codex` TUI 运行中，杀本地 backend 后重新启动 backend 并接回。
- `codex` TUI 运行中，模拟服务端滚动部署后由新 backend 接回。
- vim、less、top、ssh 基本交互正常。
- `$TERM` 兼容性正常：颜色、光标、alternate screen、鼠标模式在 xterm.js 中无明显异常。
- `Ctrl-b` 在 `codex`、vim 或 shell readline 中可透传，不被 tmux prefix 截获。
- Ctrl-C、Esc、方向键、鼠标选择、粘贴、窗口 resize 正常。
- 多个 tmux-backed terminal session 互不串线。
- inactive terminal 的活动点、响铃和 metadata 更新行为不回退。
- 删除 terminal 后 tmux session 不残留。
- 删除 terminal 后历史不残留。

建议复用现有终端回归入口：

- `docs/testing/runbooks/terminal-vim.md`
- `frontend/tests/terminal.spec.ts`
- `frontend/tests/terminal-vim.spec.ts`

## 风险与决策点

| 问题                                         | 建议                                                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 是否默认所有终端使用 tmux                    | 默认使用 tmux。只有 tmux 不可用或显式禁用时才降级为普通 node-pty。                                                 |
| 是否打包 tmux                                | 首期不打包，先检测本机 tmux。产品化后再评估。                                                                      |
| 是否把 tmux history 补回 Runweave scrollback | 不补。tmux-backed session 运行中读 tmux pane history，关闭后彻底删除历史。                                         |
| `capture-pane -5000` 是否会拖慢打开终端      | 阶段 1 必须测满 5000 行 pane history 的耗时，目标低于 200 ms；超过阈值时需要降低行数、缓存 snapshot 或异步补历史。 |
| 服务端 redeploy 是否一起解决                 | 可以纳入同一方案，但前提是 tmux server、terminal store、tmux socket 不随旧 backend deploy 单元销毁。               |
| node-pty 是否还需要                          | 需要。tmux 负责保活，node-pty 负责 WebSocket 到系统 PTY 的实时桥接。                                               |

## 结论

tmux 方案的本质是把用户任务从 node-pty 生命周期中移出来。它不能让更新或部署期间 UI 完全不断，但可以让 `codex` TUI 这类长任务在客户端更新、backend 重启或服务端滚动部署后继续存活，并允许新 node-pty attach 回同一个会话。

相比完整 daemon 化，tmux 方案更适合作为第一阶段验证：改造范围集中，能快速证明“进程重启不杀用户任务”的核心价值。长期仍可以在这个基础上继续演进到独立 terminal daemon、host-level worker 或服务端 terminal runtime 池。
