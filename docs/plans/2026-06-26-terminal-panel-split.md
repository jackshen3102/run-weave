# Terminal Panel 拆分与程序化路由计划

状态：已收敛为 **tmux 原生 split 方案**，尚未进入产品代码实现。

## 最终方向

首期不做多个独立 React `TerminalSurface`，也不做 panel-level WebSocket transport。Runweave 继续用一个 `TerminalSurface` 连接一个 tmux-backed terminal session，xterm 中显示的是 `tmux attach` 渲染出的原生 split layout。

Runweave 新增的是业务层 `TerminalPanel` 抽象：每个 Panel 绑定一个稳定 tmux `%pane_id`，CLI、Orchestrator 和 UI 辅助控件通过 `panelId`、`alias` 或 `role` 定位 pane，再由 backend 执行 `tmux send-keys -t %pane`、`capture-pane -t %pane`、`split-window -t %pane`、`kill-pane -t %pane` 等操作。Agent/Hook 通知首期仍按 terminal session 聚合，panel 只作为可选来源信息。

核心原则：

- **渲染不拆分**：Web 仍然只有一个 terminal surface / 一个 session-level WebSocket / 一个 `tmux attach` runtime。
- **控制可寻址**：业务层维护 `TerminalPanel -> tmuxPaneId` 映射，程序化输入、snapshot、interrupt、focus 都可以指定 Panel。
- **事件可同步**：CLI/API 事件更新 panel chips 和 active target；Hook/Agent 通知首期仍维持 terminal session 级语义，panel target 只作为可选归属信息。
- **为未来保留扩展口**：如果后续需要多个独立 surface，再新增 pane transport；首期不把这个复杂度放进计划。

## 设计与原型资产

### HTML 原型

HTML 原型是本计划的主要交互基准，已按 tmux 原生 split 方向调整：

- 原型目录：[docs/prototypes/terminal-panel-split](/Users/bytedance/Code/browser-hub/browser-viewer/docs/prototypes/terminal-panel-split)
- 原型说明：[README.md](/Users/bytedance/Code/browser-hub/browser-viewer/docs/prototypes/terminal-panel-split/README.md)
- 原型截图：[prototype-preview.png](/Users/bytedance/Code/browser-hub/browser-viewer/docs/prototypes/terminal-panel-split/prototype-preview.png)

启动方式：

```bash
python3 -m http.server 6188 --directory docs/prototypes/terminal-panel-split
```

打开：

```text
http://127.0.0.1:6188/
```

原型边界：

- 原型不引用 `frontend/src`、`backend/src` 或主项目组件。
- 原型不连接真实 backend、tmux、WebSocket。
- 原型只模拟 “一个 tmux attach surface 内部出现 split panes”，不代表多个独立 `TerminalSurface`。
- 原型中的 event feed、toast、CLI simulate 按钮均为验证脚手架，不是最终产品 UI。

### 交互原型

正文以 tmux 原生 split HTML 原型为准，不再嵌入静态截图或旧 Image 2 探索图，避免误导为多个独立 Panel Surface 方案。需要看效果时直接启动原型页面。

## 当前代码现状

当前架构更适合 tmux 原生 split 路线：

- `backend/src/terminal/runtime-launcher.ts` 在 tmux session 创建/恢复后，通过 `tmuxService.buildAttachCommand(...)` spawn 一个 `tmux attach` PTY，再以 `currentSession.id` 注册 runtime。
- `backend/src/ws/terminal-server.ts` 的 input、resize、signal 都写入同一个 `activeRuntime`。
- `backend/src/terminal/runtime-registry.ts` 以 `terminalSessionId` 管理 `PtyRuntime`、buffer、subscriber 和 attached client。
- `backend/src/terminal/tmux-service.ts` 已有 `sendInput`、`capturePane`、`readPaneMetadata`、`pipePaneOutput`，但 target 仍主要是 session name，需要扩展为 pane target。
- `backend/src/terminal/tmux-output-watcher.ts` 当前按 session watch output；首期 Web 渲染仍可继续依赖 attach runtime，panel-level snapshot 则通过 `capture-pane -t %pane`。
- `packages/shared/src/app-server-events.ts` 的 event scope 当前只有 `terminalSessionId`；首期 Hook/Codex 通知继续按 terminal session 聚合，`terminalPanelId` 只作为可选 metadata。
- `frontend/src/components/terminal/terminal-surface.tsx` 和 `useTerminalConnection(...)` 当前就是 session-level terminal surface；首期应保留这个模型。

因此首期目标不是“让每个 Panel 一个 WebSocket”，而是“让一个 tmux session 里的多个 pane 在业务层可寻址、可路由、可同步”。

## 目标

把 Runweave 的终端从“一个 terminal session 只有一个业务目标”扩展为“一个 terminal session 内有多个可寻址 Panel，但 Web 仍渲染一个 tmux attach surface”。

首期目标：

- Web terminal 在当前 terminal tab 内触发 tmux 原生 Split Right / Split Down。
- CLI 可以创建、列出、聚焦、关闭 Panel，并向指定 Panel 发送输入。
- UI 能同步 CLI/API 触发的 Panel 创建、删除、焦点变化，并更新 panel chips / active target。
- tmux runtime 下使用 tmux pane 承载 Panel；pty runtime 下拒绝 split，并返回明确错误。
- Codex/Hook/Agent completion 事件继续以 terminal session 为主；如果能识别 panel，则附带 `terminalPanelId`，但不依赖它驱动核心状态。
- 现有只使用 `terminalSessionId` 的输入/中断路径保持兼容，未指定 Panel 时先同步 tmux selected pane，再路由到该 session 的 active/default panel；旧 history/snapshot 固定读取 default panel。

## 非目标

- 不做多个独立 React `TerminalSurface`。
- 不做 `/ws/terminal?panelId=...` 的 panel-level WebSocket transport。
- 不做 per-panel xterm resize、per-panel xterm buffer 或多个 xterm surface cache。
- 不把 Image 2 高保真图里的多个独立 panel frame 原样产品化。
- 不在首期支持 tmux window 管理；Runweave 业务层只暴露 Panel，不暴露 window。
- 不把 App/Ionic 移动端 Panel split 纳入首期。
- 不新增前端 Vitest、React unit test 或非 E2E 测试文件；浏览器验收走 Playwright E2E 或 `$playwright-cli`。
- 不允许 CLI 直接执行 `tmux split-window` 绕过 backend；CLI 必须调用 Runweave API，让后端持久化状态并发事件。
- 首期不支持重命名 Panel 或编辑 role；alias/role 在创建 Panel 时确定，后续变更另行设计。

## 业务抽象

业务层新增：

```text
Project
  -> Terminal Session
      -> Terminal Panel
          -> tmux pane (%pane_id)
```

`TerminalPanel` 是 Runweave 稳定实体；tmux `%pane_id` 是 runtime target。CLI、UI、Orchestrator 不依赖 pane index，也不把“tmux 当前 active pane”直接当作自动化路由依据。

业务规则：

- 每个 terminal session 必须至少有一个 Panel，称为 default panel。
- default panel 是旧 history/snapshot 的兼容读取目标；如果 default panel metadata 缺失但 tmux session 仍存在，则用 `tmux list-panes` 的第一个 pane 重建 default panel。
- 每个 Panel 在 session 内有唯一 `panelId`；`alias` 在同一 session 内非空时必须唯一。
- `role` 可选，用于程序化路由，例如 `main`、`server`、`tests`、`planner`、`reviewer`。
- alias/role 首期在创建 Panel 时确定，不提供 Rename/Edit role 操作。
- `tmuxPaneId` 必须使用 `%pane_id`，不要使用可变 pane index。
- `activePanelId` 是 Runweave 的默认路由目标，不要求实时等同于 UI 高亮状态。
- 程序化控制推荐显式指定 `panelId`、`alias` 或 `role`；未指定 Panel 的旧路径只作为兼容路径。
- 旧 input/interrupt 路径未指定 Panel 时，后端在解析默认目标前先轻量读取 tmux selected pane，并把 `activePanelId` 同步到匹配的 Panel；如果读取失败或 pane 未匹配，再回退到已记录的 `activePanelId` / default panel。
- 旧 history/snapshot 路径不跟随 selected pane，也不走 `activePanelId`；始终读取 default panel，default 缺失时按上述规则重建。
- Split Right / Split Down 从 source panel 执行 tmux `split-window`，新 panel 默认继承 source pane cwd；命令默认启动交互 shell，除非 API/CLI 指定 `command/args`。
- Close panel 执行 `kill-pane -t %pane`；关闭最后一个 Panel 时拒绝，并提示先关闭 terminal session。
- 删除 terminal session 时必须删除该 session 的所有 panel metadata。
- pty runtime 首期不支持 split，`POST /panels` 返回 409，错误信息说明 `Panel split requires tmux runtime`。

## 共享协议设计

修改 `packages/shared/src/terminal-protocol.ts`，新增类型：

```ts
export type TerminalPanelRole = string;

export const TERMINAL_PANEL_ROLE_SUGGESTIONS = [
  "main",
  "server",
  "tests",
  "planner",
  "reviewer",
  "worker",
] as const;

export interface TerminalPanelListItem {
  panelId: string;
  terminalSessionId: string;
  alias: string | null;
  role?: TerminalPanelRole | null;
  cwd: string;
  activeCommand: string | null;
  status: "running" | "exited";
  createdAt: string;
  lastActivityAt: string;
  exitCode?: number;
  focused: boolean;
  tmuxPaneId?: string;
}

export interface TerminalPanelWorkspace {
  terminalSessionId: string;
  activePanelId: string;
  panels: TerminalPanelListItem[];
  renderMode: "tmux-native";
}
```

新增请求/响应类型：

```ts
export interface CreateTerminalPanelRequest {
  sourcePanelId?: string;
  direction: "right" | "down";
  alias?: string | null;
  role?: TerminalPanelRole | null;
  command?: string;
  args?: string[];
  cwd?: string;
  focus?: boolean;
}

export interface UpdateTerminalPanelRequest {
  focus?: boolean;
}

export interface SendTerminalInputRequest {
  data: string;
  mode?: TerminalInputMode;
  operationId?: string;
  quickInputSource?: TerminalQuickInputSource;
  panelId?: string;
  panelAlias?: string;
  role?: TerminalPanelRole;
}
```

兼容原则：

- 旧 input/interrupt 客户端不传 `panelId` 时，后端先执行 selected pane sync，再解析为该 session 的 `activePanelId`；如果 sync 失败且没有 panel metadata，则解析为 default panel。
- 旧 history/snapshot 客户端不传 `panelId` 时，后端不执行 selected pane sync，直接解析为 default panel；如果 default panel metadata 缺失但 tmux session 仍存在，则从 `tmux list-panes` 的第一个 pane 重建 default panel。
- `TerminalSessionListItem` 不强制包含完整 panels；可增加轻量字段 `activePanelId?: string`、`panelCount?: number`、`panelAliases?: string[]`。
- `TerminalServerMessage` 不需要新增 panel-level output 字段；WebSocket 仍是 session-level attach 输出。

## 后端 API 设计

在 `backend/src/routes/terminal.ts` 增加 session 下的 panel routes：

```text
GET    /api/terminal/session/:id/panels
POST   /api/terminal/session/:id/panels
PATCH  /api/terminal/session/:id/panels/:panelId
DELETE /api/terminal/session/:id/panels/:panelId
POST   /api/terminal/session/:id/panels/:panelId/input
POST   /api/terminal/session/:id/panels/:panelId/interrupt
GET    /api/terminal/session/:id/panels/:panelId/history
```

保留现有 session-level routes：

```text
POST /api/terminal/session/:id/input
POST /api/terminal/session/:id/interrupt
GET  /api/terminal/session/:id/history
GET  /api/terminal/session/:id/ws-ticket
```

旧 `input` / `interrupt` 接口走 `resolvePanelTarget(sessionId, requestBody)`：

1. `panelId`
2. `panelAlias`
3. `role`
4. sync tmux selected pane 后的 session `activePanelId`
5. default panel

旧 `GET /api/terminal/session/:id/history` 不走 selected pane sync，也不跟随 `activePanelId`；它始终读取 default panel 的 history。default panel 找不到但 tmux session 仍存在时，后端用 `tmux list-panes` 的第一个 pane 重建 default panel 后再读取。

错误处理：

- session 不存在：404。
- panel 不存在：404。
- alias/role 匹配多个：409，返回候选 panel。
- runtime 不是 tmux 且请求 split：409。
- tmux split/kill/send/capture 失败：500，且 split 失败不得写入 panel metadata。
- 关闭最后一个 panel：409。

## 后端存储与迁移

首期扩展现有 `backend/src/terminal/store.ts` 和 `backend/src/terminal/lowdb-store.ts`，不新增第二套 panel store 生命周期。

新增持久化记录：

```ts
export interface PersistedTerminalPanelRecord {
  id: string;
  terminalSessionId: string;
  alias?: string | null;
  role?: string | null;
  cwd: string;
  activeCommand: string | null;
  status: "running" | "exited";
  createdAt: string;
  lastActivityAt: string;
  exitCode?: number;
  runtimeKind: "tmux";
  tmuxPaneId: string;
}

export interface PersistedTerminalPanelWorkspaceRecord {
  terminalSessionId: string;
  activePanelId: string;
  renderMode: "tmux-native";
}
```

迁移策略：

- 启动时对每个 running tmux session，如果没有 panel workspace，读取 tmux 当前 pane id，创建 default panel。
- 启动时校验持久化 panel 的 `tmuxPaneId` 是否仍存在；不存在的 panel 标记为 `exited` 或从 workspace 中移除，并记录 terminal event。
- backend 重启后，panel workspace 必须以 `tmux list-panes` 的真实结果为准收敛；持久化记录不能让已经不存在的 `%pane_id` 继续作为可发送目标。
- 如果 tmux session 已丢失或被重建，旧 panel metadata 不继续绑定到新 session；恢复流程创建新的 default panel，旧 panel 标记为 exited 或从 workspace 移除，并记录 terminal event。
- 对 pty session，只创建一个内存兼容 default panel，不允许 split。
- 老 session 的 session-level `cwd`、`activeCommand` 继续保留；首期把它们作为 active/default panel 的聚合展示来源。
- 删除 session 时同步删除 panels 和 panel workspace。

## tmux 实现设计

扩展 `backend/src/terminal/tmux-service.ts`：

```ts
export interface TmuxPaneTarget extends TmuxTarget {
  paneId: string;
}

async listPanes(target: TmuxTarget): Promise<Array<{
  paneId: string;
  paneIndex: number;
  cwd: string;
  activeCommand: string | null;
  active: boolean;
}>>

async splitPane(target: TmuxPaneTarget, params: {
  direction: "right" | "down";
  cwd: string;
  command?: string;
  args?: string[];
}): Promise<TmuxPaneTarget>
```

需要支持 pane target 的方法：

- `sendInput(target: TmuxTarget | TmuxPaneTarget, data: string)`
- `sendKeySequence(target: TmuxTarget | TmuxPaneTarget, sequence: ...)`
- `capturePane(target: TmuxTarget | TmuxPaneTarget, historyLines?: number)`
- `readPaneMetadata(target: TmuxTarget | TmuxPaneTarget, shellCommand?: string)`
- `readPaneWidth(target: TmuxTarget | TmuxPaneTarget)`
- `readSelectedPane(target: TmuxTarget): Promise<string | null>`
- `selectPane(target: TmuxPaneTarget)`
- `killPane(target: TmuxPaneTarget)`
- `interruptPane(target: TmuxPaneTarget)`

实现规则：

- 所有 pane 操作使用 `-t <paneId>`，例如 `-t %12`。
- split 使用 `split-window -P -F '#{pane_id}' -t <sourcePaneId>` 获取新 pane id。
- `direction: "right"` 对应 horizontal split；`direction: "down"` 对应 vertical split。
- split 成功并确认 pane 可读后再写 panel metadata。
- `readSelectedPane` 使用 `display-message -p '#{pane_id}'` 或 `list-panes -F '#{pane_id} #{pane_active}'` 读取 tmux 当前 selected pane。
- `syncSelectedPaneToActivePanel(sessionId)` 只在 input/interrupt 兼容路径和明确同步时机调用，不做持续轮询；它读取 selected pane，找到匹配 panel 后更新 `activePanelId` 并记录 `terminal_panel_focused(source: "tmux")`。
- UI resize 仍按现有 `tmux attach` client resize 处理，不做 per-pane xterm resize。
- `GET /history` 的 session-level 版本继续作为旧兼容入口，但读取目标固定为 default panel；panel-level history 使用 `capture-pane -t %pane`。

## WebSocket 与输出设计

首期不改成 panel-level WebSocket。

保留：

```text
/ws/terminal?terminalSessionId=<sessionId>&token=<ticket>
```

调整点：

- `createTerminalWsTicket` 和 `validateTerminalWebSocketHandshake` 仍只校验 `terminalSessionId`。
- `attachTerminalWebSocketServer` 仍 resolve session-level runtime，并继续写入 `activeRuntime`。
- `TerminalRuntimeRegistry` 继续以 `terminalSessionId` 为 key。
- tmux-backed session 仍通过 `tmux attach` runtime 给 Web xterm 提供完整 tmux split 画面。
- CLI/API 发送到指定 panel 时不经过 WebSocket，而是 backend 直接调用 `tmux send-keys -t %pane`；attach runtime 会自然收到 tmux client 重绘输出。

panel-level 输出能力只用于程序化读取：

- `GET /api/terminal/session/:id/panels/:panelId/history` 使用 `capture-pane -t %pane`。
- `rw terminal snapshot <session> --panel tests` 使用 panel history route。
- `GET /api/terminal/session/:id/history`、`rw terminal snapshot <session>`、`rw terminal history <session>` 不带 panel 参数时固定读取 default panel。
- 首期不维护 per-panel live output buffer；如果后续需要 panel 级 replay，再单独设计 pane output watcher。

## 默认路由与 selected pane 同步

首期不要求 UI 焦点实时跟随 tmux selected pane，也不把 Panel 高亮作为核心体验。需要保证的是：未指定 Panel 的 input/interrupt 兼容路径不会明显偏离用户在 tmux attach surface 中看到的当前 pane。

路由策略：

- 可靠自动化必须显式指定 `--panel`、`--role`、`panelId` 或 `panelAlias`。
- 未指定 Panel 的旧 input/interrupt CLI/API 路径保留兼容，但不作为推荐用法。
- 执行旧 input/interrupt 路径前，backend 调用 `syncSelectedPaneToActivePanel(sessionId)`，读取 tmux selected pane 并更新 `activePanelId`。
- sync 成功后，旧 input/interrupt 路径发送到新的 `activePanelId`。
- sync 失败时，旧 input/interrupt 路径发送到已记录的 `activePanelId`；如果没有记录，则发送到 default panel。
- 旧 history/snapshot 路径不参与 selected pane sync；不带 `--panel` / `--role` 时始终读取 default panel。

同步触发时机：

- `resolvePanelTarget(...)` 处理未指定 Panel 的 `send/input/interrupt` 前。
- WebSocket 收到用户 keyboard input 后，按节流策略同步 selected pane，用于更新 panel chips 和后续默认路由。
- UI 点击 panel chip 或 focus API 后，先调用 `select-pane -t %pane`，再更新 `activePanelId`。
- terminal events catchup 或打开 session 时同步一次 selected pane。

不做的内容：

- 不做高频轮询。
- 不要求 tmux 内部每一次 pane focus 变化都立即反映到 UI。
- 不把无 `--panel` 的 CLI send 作为自动化场景的推荐路径。

## Terminal Events 与 Hook 设计

扩展 `TerminalEventKind`：

```ts
| "terminal_panel_created"
| "terminal_panel_updated"
| "terminal_panel_deleted"
| "terminal_panel_focused"
| "terminal_panel_input_sent"
| "terminal_panel_hook_event"
```

事件 payload：

```ts
export interface TerminalPanelCreatedEventPayload {
  panel: TerminalPanelListItem;
  workspace: TerminalPanelWorkspace;
}

export interface TerminalPanelFocusedEventPayload {
  terminalSessionId: string;
  panelId: string;
  alias: string | null;
  role?: string | null;
  source: "ui" | "cli" | "api" | "tmux";
}
```

UI 同步规则：

- `terminal_panel_created`：更新 panel chips/list 和 active target；tmux split 画面由现有 `tmux attach` surface 自然刷新。
- `terminal_panel_updated`：更新 cwd、activeCommand、status 等运行时展示；首期不更新 alias/role。
- `terminal_panel_deleted`：移除 panel chips；如果删除的是 active panel，切到 workspace 的新 `activePanelId`。
- `terminal_panel_focused`：更新 active target；如果事件来自 UI 操作，可同时调用 tmux `select-pane` 让 attach 画面焦点移动。
- CLI 触发的 focus 只更新目标 session 内 panel focus，不切换用户当前 project/session tab。

Hook/Codex 事件：

- `packages/shared/src/app-server-events.ts` 的 `AppServerEventScope` 可以增加 `terminalPanelId?: string | null`，但它是 best-effort metadata，不是首期状态模型的主键。
- 创建 default panel 和 split panel 时，pane 内环境需要包含：

```text
RUNWEAVE_TERMINAL_SESSION_ID
RUNWEAVE_TERMINAL_PANEL_ID
```

- Hook receiver 优先校验 terminal session 归属；如果 payload/env 能识别 panel，则把 `terminalPanelId` 写入 app-server event scope。
- alias/role 不写入 pane env，也不作为 Hook 权威事实源；需要展示 alias/role 时，backend 根据 `terminalPanelId` 查询当前 panel metadata 后补充。
- `completion`、`stop`、`notify`、agent timeline 首期仍按 terminal session 聚合展示；panel target 可以用于日志、hover、详情或后续增强，不驱动核心 readiness/composer 状态。
- 如果某个历史 pane 没有 panel env，事件直接按 session-level 处理。

## TerminalState 边界

首期不把 `TerminalState` 改成 panel 级状态。

保持现状：

- `TerminalStateStore` 仍按 `terminalSessionId` 单键存储。
- `/api/terminal/session/:id/state` 仍返回 terminal session 级状态。
- Composer readiness、提交键、agent running/completion 等仍以整个 terminal session 为准。
- UI 可以在 terminal tab 或 target bar 上展示 session-level notification，不要求在具体 panel chip 上做精确完成标记。

明确不承诺：

- 不支持同一个 terminal session 内多个 agent-active panel 的独立 readiness/composer 状态。
- 不保证两个 panel 同时运行 agent 时，`Stop`、`UserPromptSubmit`、completion marker 能按 panel 隔离。
- 不新增 `terminalSessionId + terminalPanelId` 作为 `TerminalState` key。

产品约束：

- 首期推荐同一个 terminal session 内只有一个 agent-active panel。
- 如果后续要支持多 agent panel 并发，需要单独设计 panel-keyed `TerminalState`、state route、hook processor、terminal events 和 UI 状态隔离；这不属于本计划首期范围。

## 前端状态与 UI 设计

扩展 `frontend/src/features/terminal/workspace-store.ts`：

```ts
panelWorkspaceBySessionId: Record<string, TerminalPanelWorkspace>;
activePanelIdBySessionId: Record<string, string>;
```

不新增：

- `cachedSurfacePanelIds`
- `panelStateByPanelId`
- 多个 panel `TerminalSurface`
- panel-level WS connection state

前端模块建议：

```text
frontend/src/components/terminal/terminal-panel-target-bar.tsx
frontend/src/components/terminal/terminal-panel-chip-list.tsx
frontend/src/features/terminal/panel-target.ts
frontend/src/services/terminal-panels.ts
```

`TerminalWorkspaceShell` 渲染策略：

- 当前 active session 仍渲染一个 `TerminalSurface`。
- 在 `TerminalSurface` 上方或 terminal tab 下方增加轻量 `TerminalPanelTargetBar`。
- `TerminalPanelTargetBar` 展示 active target breadcrumb、panel chips、Split Right、Split Down、More actions。
- Split/Close/Focus 调用 panel API；真实视觉变化由 tmux attach surface 内部呈现。
- Preview sidecar 逻辑不变；preview 打开/关闭仍只触发现有 session-level terminal resize。

产品 UI 行为：

- 常驻：active target breadcrumb、panel chips/list、Split Right、Split Down。
- 菜单：Close、Copy target。
- 调试/开发态：完整 `rw terminal ...` 命令预览、event feed。
- 不在每个 tmux pane 外层画 React header；tmux pane 内部也不插入自定义 header。

## CLI 设计

扩展 `packages/runweave-cli/src/commands/terminal.ts`：

```text
rw terminal panel list <terminalSessionId> --json
rw terminal panel split <terminalSessionId> --from <panelId|alias> --direction right --alias tests --role tests --json
rw terminal panel focus <terminalSessionId> <panelId|alias> --json
rw terminal panel close <terminalSessionId> <panelId|alias> --json
rw terminal send <terminalSessionId> --panel tests --text "pnpm test" --enter --json
rw terminal snapshot <terminalSessionId> --panel tests --tail 120 --plain
rw terminal interrupt <terminalSessionId> --panel tests --json
```

兼容原则：

- 现有 `rw terminal send <terminalSessionId> --text ...` 不变。
- 自动化脚本推荐使用 `--panel` 或 `--role`；无 `--panel` 的 send 是兼容入口，会在发送前同步 tmux selected pane 后再路由。
- 新增 `--panel` 支持 panel id 或 alias；如果 alias 冲突，CLI 退出 code 4 并展示候选。
- 新增 `--role` 可用于 role 路由，但 `--panel` 优先级高于 `--role`。
- `handoff` 输出增加 `panels`、`activePanelId`、`suggestedPanelCommands`，方便 agent 接管。

## Orchestrator 路由设计

修改 `packages/shared/src/orchestrator.ts`：

```ts
export interface OrchestratorTerminalBinding {
  mode: "new" | "reuse";
  sessionId?: string | null;
  panelId?: string | null;
  panelAlias?: string | null;
  role?: string | null;
}
```

后端 Orchestrator 创建 worker 时：

- `binding.mode === "new"`：创建或复用 session 后，为 role split 一个 panel，alias 默认用 role id。
- `binding.mode === "reuse"`：解析 session + panel target，失败时返回明确 human-readable error。
- direct send timeline 增加 `terminalPanelId` 和 `panelAlias`，便于 UI 展示目标。

## 实施阶段

### 阶段 0：更新计划和原型

修改范围：

- `docs/plans/2026-06-26-terminal-panel-split.md`
- `docs/prototypes/terminal-panel-split/**`

任务：

- 将方案收敛为 tmux 原生 split。
- 原型改成一个 tmux attach surface 内部展示 split panes，外部只做 panel target/chips/API simulate。
- 明确不做多个 `TerminalSurface`、不做 panel-level WebSocket。

验收：

- 原型可通过 `python3 -m http.server 6188 --directory docs/prototypes/terminal-panel-split` 打开。
- 原型中不存在多个独立 React terminal frame/header 的产品暗示。

### 阶段 1：协议、存储和 default panel 兼容层

修改范围：

- `packages/shared/src/terminal-protocol.ts`
- `packages/shared/src/app-server-events.ts`
- `backend/src/terminal/store.ts`
- `backend/src/terminal/lowdb-store.ts`
- `backend/src/terminal/manager.ts`
- `backend/src/terminal/manager-records.ts`
- `backend/src/routes/terminal-route-payloads.ts`

任务：

- 新增 panel 类型、workspace 类型、API payload 类型。
- `AppServerEventScope` 可增加可选 `terminalPanelId`，仅作为 best-effort metadata。
- 在 store 中持久化 panel records 和 panel workspace。
- 启动/读取旧 session 时生成 default panel 兼容层。
- session list 返回 `panelCount`、`activePanelId`。

验收：

- 老数据启动后仍能打开已有 terminal session。
- `GET /api/terminal/session/:id/panels` 对老 tmux session 返回一个 default panel。
- backend 重启后，已持久化 panel 列表与当前 `tmux list-panes` 结果一致；不存在的 pane 不再作为 running panel 返回。
- tmux session 丢失或被重建后，旧 panel metadata 不绑定到新 pane；系统创建新的 default panel，并把旧 panel 标记为 exited 或从 workspace 移除。
- `pnpm --filter ./packages/shared typecheck` 和 `pnpm --filter ./backend typecheck` 通过。

### 阶段 2：tmux pane 能力和 panel API

修改范围：

- `backend/src/terminal/tmux-service.ts`
- `backend/src/terminal/runtime-launcher.ts`
- `backend/src/routes/terminal.ts`
- `backend/src/routes/terminal-session-route-helpers.ts`

任务：

- `TmuxService` 支持 list/split/send/capture/select/kill 指定 pane。
- `TmuxService` 支持读取当前 selected pane。
- 实现 panel create/list/focus/close routes；不实现 rename/edit role。
- 实现 session-level input/interrupt 的 panel target 解析；未指定 Panel 时先执行 selected pane sync。
- 实现 session-level history/snapshot 的 default panel 读取；不带 panel 参数时不跟随 selected pane。
- split 成功后写 panel metadata；失败不写状态。
- focus panel 时调用 `select-pane -t %pane`。

验收：

- tmux session 可以 split right/down，并能获得稳定 `%pane_id`。
- `rw terminal send <session> --panel tests ...` 只向 tests pane 执行 `send-keys -t %pane`。
- 用户在 xterm/tmux 内切换 selected pane 后，`rw terminal send <session> --text "echo default" --enter` 发送到 tmux 当前 selected pane。
- `rw terminal snapshot <session>` 和 `rw terminal history <session>` 不带 panel 参数时始终读取 default panel；default panel 缺失时从 `tmux list-panes` 第一个 pane 重建后读取。
- Web 上的单个 tmux attach surface 能看到 tmux 原生 split 更新。
- 外部执行 `tmux kill-pane -t %pane` 后，再调用 panel list 或 selected pane sync，后端能收敛 panel 状态并发出删除/退出事件。
- 非 tmux session split 返回 409。
- 关闭最后一个 panel 返回 409。

### 阶段 3：Hook 和事件同步

修改范围：

- `packages/shared/src/terminal-protocol.ts`
- `packages/shared/src/app-server-events.ts`
- `backend/src/terminal/terminal-event-service.ts`
- `backend/src/app-server/**`
- `backend/src/routes/terminal.ts`
- `frontend/src/components/terminal/terminal-workspace-events.ts`
- `frontend/src/features/terminal/workspace-store.ts`

任务：

- 新增 panel event kinds 和 payload。
- API split/delete/focus/input 后记录事件；runtime metadata 变化可记录 `terminal_panel_updated`。
- selected pane sync 改变 `activePanelId` 时记录 `terminal_panel_focused(source: "tmux")`。
- 创建 pane 时注入 panel env；Hook 事件能识别 panel 时附带 `terminalPanelId`，不能识别时保持 session-level。
- UI catchup/live 都能应用 panel workspace，更新 chips 和 active target；terminal notification 仍按 session-level 展示。
- CLI 操作只同步对应 session 的 panel 状态，不抢当前 project/session 焦点。

验收：

- CLI split 后浏览器无刷新更新 panel chips，tmux attach surface 显示新 pane。
- CLI close/focus 后 UI target 同步。
- 未指定 Panel 的旧 input 路径触发 selected pane sync 后，UI 可通过 terminal events 同步 active target。
- Codex/Hook completion 继续以 terminal session 级通知展示；如果事件带 `terminalPanelId`，可在详情中展示来源 panel。
- 断线重连后 catchup 能补齐 panel 状态。

### 阶段 4：Web tmux-native Panel UI

修改范围：

- `frontend/src/components/terminal/terminal-workspace-shell.tsx`
- `frontend/src/components/terminal/terminal-surface.tsx`
- `frontend/src/components/terminal/terminal-panel-target-bar.tsx`
- `frontend/src/components/terminal/terminal-panel-chip-list.tsx`
- `frontend/src/features/terminal/panel-target.ts`
- `frontend/src/services/terminal-panels.ts`

任务：

- 保留一个 `TerminalSurface`，不传 `panelId`，不新增 panel-level WS。
- 在 terminal tab 与 terminal surface 之间增加 `TerminalPanelTargetBar`。
- `PanelChipList` 展示 alias/role/status，点击 chip 调用 focus API。
- Terminal notification、agent running、completion 仍沿用现有 session-level 展示；panel chip 首期只展示 alias/role/status，不承担 agent readiness 判断。
- Split Right / Split Down 作用于 active panel。
- More menu 承载 Close、Copy target。
- 用户直接在 tmux 内切换 pane 时，UI 不要求即时高亮；收到 selected pane sync 事件后更新 active target。
- preview sidecar resize 仍走现有 session-level resize。

验收：

- 当前 terminal tab 内可通过 UI split 出 tmux 原生 panes。
- active target breadcrumb 与 tmux selected pane 保持一致。
- 输入仍进入当前 tmux selected pane；CLI/API 发送可进入指定 panel。
- UI 主路径没有多个 React terminal frame，也没有常驻 demo command bar。

### 阶段 5：CLI 和 Orchestrator 路由

修改范围：

- `packages/runweave-cli/src/commands/terminal.ts`
- `packages/runweave-cli/src/client/terminal-http-client.ts`
- `packages/shared/src/orchestrator.ts`
- `backend/src/orchestrator/**`
- `frontend/src/components/terminal/orchestrator/**`

任务：

- 增加 `rw terminal panel ...` 子命令。
- `send/snapshot/interrupt/handoff` 支持 `--panel` 和 `--role`。
- Orchestrator binding 增加 panel target。
- timeline 和 handoff 输出包含 panel target。

验收：

- `rw terminal panel split <session> --from main --direction right --alias tests --json` 返回新 panel。
- `rw terminal send <session> --panel tests --text "echo ok" --enter --json` 只写入 tests pane。
- `rw terminal snapshot <session> --panel tests --plain` 只返回 tests pane 内容。
- Orchestrator worker 可以绑定到指定 role panel。

## 验证计划

### 原型验证

原型用于设计验证，不验证真实 backend/tmux/ws：

```bash
python3 -m http.server 6188 --directory docs/prototypes/terminal-panel-split
```

用浏览器打开 `http://127.0.0.1:6188/` 后验证：

- 页面主体只有一个 `tmux attach surface`。
- 点击 Panel chips 可切换 active target，并让 tmux surface 内对应 pane 高亮。
- 点击 Split Right / Split Down 可在同一个 tmux surface 内增加模拟 pane。
- 点击 Simulate CLI split 可模拟外部 CLI/API 事件同步。
- Send mock input 只验证 `rw terminal send --panel <alias>` 的目标路由，不代表真实 WebSocket 已变成 panel-level。

### 静态验证

```bash
pnpm --filter ./packages/shared typecheck
pnpm --filter ./backend typecheck
pnpm --filter ./frontend typecheck
pnpm --filter ./packages/runweave-cli typecheck
pnpm typecheck
```

### 后端和 CLI 验证

- 覆盖 panel create/list/focus/close、alias 冲突、关闭最后一个 panel、非 tmux split 409。
- 覆盖 backend 重启恢复：panel list 与 `tmux list-panes` 一致，丢失的 pane 不再作为 running panel。
- 覆盖外部 `tmux kill-pane -t %pane`：下一次 panel list / sync 后 panel 状态收敛，并产生删除或退出事件。
- 覆盖 tmux session 丢失重建：新 session 只绑定新的 default panel，旧 panel metadata 不误绑到新 `%pane_id`。
- 覆盖 session-level input 未传 panel 时先同步 tmux selected pane，再路由 active/default panel。
- 覆盖用户在 tmux 内切换 selected pane 后，`rw terminal send <session> --text "echo default" --enter` 发送到当前 selected pane。
- 覆盖无 `--panel` / `--role` 的 `rw terminal snapshot/history <session>` 固定读取 default panel，不受 selected pane 影响；default 缺失时 fallback 到第一个 tmux pane 并重建 metadata。
- 覆盖 panel-level snapshot 只返回指定 tmux pane 内容。
- 覆盖 Hook event scope 至少包含 `terminalSessionId`；能识别 panel 时可附带 `terminalPanelId`，不能识别时仍按 session-level 通知处理。

### 浏览器验收

浏览器验收必须使用 `$playwright-cli`：

1. 启动 `pnpm dev`。
2. 登录本地 `http://localhost:5173/terminal`。
3. 创建 tmux terminal session。
4. 点击 Split Right，预期同一个 xterm 内出现 tmux 原生 split，panel chips 增加一个目标。
5. 点击 panel chip `tests`，预期 active target 变为 `tmp / tests`，tmux selected pane 同步。
6. 在 xterm 内用 tmux 快捷键或鼠标切到另一个 pane，再执行无 `--panel` 的 `rw terminal send <session> --text "echo default" --enter`，预期输出进入当前 tmux selected pane。
7. 通过 CLI 执行 split down，预期 UI 无刷新更新 panel chips，xterm 内出现第三个 pane。
8. 通过 CLI 向 `--panel tests` 发送 `echo tests-panel`，预期输出出现在 tests pane。
9. 打开/关闭 Preview sidecar，预期单个 terminal surface 尺寸刷新且 tmux layout 不重叠。

建议新增 Playwright E2E：

- `frontend/tests/terminal-panels.spec.ts`
- 只覆盖用户可见 split、focus、CLI/API event sync；不新增前端 unit test。

## 风险与处理

- **tmux pane id 漂移风险**：必须使用 `%pane_id`，不要用 pane index；启动恢复时用 `list-panes` 校验持久化 panel。
- **默认路由与 tmux selected pane 不一致风险**：首期不做高频反向同步，但未指定 Panel 的旧 input/interrupt 路径必须先同步一次 tmux selected pane；可靠自动化应显式指定 `--panel` 或 `--role`。
- **Hook 归属风险**：新 pane 尽量注入 panel env；历史 pane 或手动清空 env 时降级为 session-level 通知，不影响 terminal 级 notification。
- **旧客户端兼容风险**：所有新增字段可选；旧 input/history/ws ticket 路径继续可用；旧 history/snapshot 固定读取 default panel。
- **输出读取误解风险**：Web 显示的是 session-level tmux attach 输出；旧 snapshot/history 读取 default panel；只有 CLI/API `--panel` snapshot 是指定 panel capture。
- **原型误用风险**：原型为验证脚手架，不能作为产品组件依赖，也不能把模拟 event feed、toast、CLI simulate 按钮直接移植到 Web 主界面。
- **未来扩展风险**：如果后续需要多个独立 surface，必须新增 pane transport；不要在 tmux-native 首期里偷偷引入半成品 panel-level WebSocket。
