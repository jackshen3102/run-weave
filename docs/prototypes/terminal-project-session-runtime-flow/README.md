# terminal-project-session-runtime-flow（项目 / 终端 / xterm 统一事件架构图）

Runweave 当前项目、终端 session、xterm.js、PTY/tmux、App 与事件系统关系的可运行说明原型。

- **性质**：本次统一事件实现完成后的代码现状图，不作进一步架构建议或性能结论。
- **代码基线**：`main@41e2923` + 本目录对应的统一 terminal event 改动，梳理日期 `2026-07-11`。
- **范围假设**：用户原话中的“上面也有项目”按“App 上也有项目”理解，因此同时覆盖 Web/Electron Terminal Workspace 与 `app/`。如果原意不是 App，图中的 Web/Electron 主链仍然独立成立。
- **参考风格**：`docs/prototypes/agent-team-loop-flow/` 的深色流程图与代码源说明风格。

## 启动

```bash
python3 -m http.server 6188 --directory docs/prototypes/terminal-project-session-runtime-flow
```

打开：

```text
http://127.0.0.1:6188/
```

## 图里讲了什么

1. **总览**：两套客户端如何共享同一组 backend Project / Terminal Session，对应到 xterm.js、WebSocket、Runtime Registry、node-pty 与 tmux。
2. **输入链路**：对比 macOS 拼音 composition、桌面 xterm、桌面浮动 composer、App composer 与 App 快捷输入分别在哪一层提交文本。
3. **事件链路**：区分浏览器本地 composition、`/ws/terminal` xterm 字节流、全局 `/ws/terminal-events` 工作区事件流、App Server `/events/stream` Agent 事件流；bell 与 session metadata 统一进入全局事件流。
4. **对象与数量**：Connection、Project、Terminal Session、Panel、xterm、Runtime、tmux session/pane 与 ThreadRef 的主键、归属和生命周期。
5. **接口清单**：列出本图涉及的 REST、WebSocket、内部事件接口及其消费者。

## 一句话结论（只描述现状）

`Connection/apiBase` 选择一个 backend；该 backend 的 `TerminalSessionManager` 持有并持久化 `Project 1 → N Terminal Session`，tmux session 还可以是 `Terminal Session 1 → N Panel/pane`。Web/Electron 与 App 都使用这些相同 ID。xterm.js 只通过 session 专属 `/ws/terminal` 收发终端字节；项目、终端、状态、panel、completion、bell 与 metadata 的前端响应都由每个客户端的一条全局 `/ws/terminal-events` 分发。

## 关键口径

### 1. Project 与 Terminal Session

- Project 的主键是 `projectId`，字段主要是 `name`、`path`、`isDefault`、顺序。
- Terminal Session 的主键是 `terminalSessionId`，通过 `projectId` 归属一个 Project。
- Project `path` 是项目根路径；创建 session 时若没有显式 `cwd`，解析顺序是：继承 session 的有效 `cwd` → Project `path` → 用户 home。
- Session 自己保存当前 `cwd`；shell metadata 更新可以改变它，但不会改变 `projectId`。

### 2. xterm.js 与 Terminal Session

- Web/Electron 的一个 `TerminalSurface` 内部创建一个 xterm `Terminal` 与一个 `/ws/terminal?terminalSessionId=...` 连接。
- App 终端详情使用共享包 `@runweave/terminal-renderer` 创建 xterm `Terminal`，并由 `useAppTerminalConnection` 连接同一个 `/ws/terminal`。
- xterm 只处理输入、尺寸、snapshot/output 渲染和本地滚动状态；bell marker 与 session metadata 不再由 xterm output 回调驱动。

### 3. 输入法 composition 与两条 WebSocket 的边界

- Web xterm helper textarea 的 `compositionupdate` / `insertCompositionText(isComposing=true)` 是浏览器本地预编辑，不进入任何 WebSocket。
- `compositionend` 记录当前 `TerminalImeCommit`；xterm `onData` 与浏览器 commit 事件即使都到达，同一轮候选也只形成一个 `/ws/terminal` input frame。
- 新的 `compositionstart` 会清除上一轮消费标记，因此 250ms 内连续提交两个相同候选仍会形成两个合法 input frame。
- `/ws/terminal-events` 只分发 Project、Session、Panel、TerminalState、completion、bell 与 metadata 等工作区事件，不承载 composition、terminal input 或 output。

### 4. 当前 Web/Electron 挂载数量

- `MAX_CACHED_TERMINAL_SURFACES = 10`：最近使用的 surface 会保持挂载，非 active surface 被移到屏幕外；每个 surface 仍有 xterm 与 terminal WebSocket。
- 每个 Web/Electron Terminal Workspace 对当前 backend 建立 1 条 `/ws/terminal-events`；未挂载 xterm 的 running session 不再建立 terminal WebSocket。
- `TerminalRuntimeRegistry` 按 `terminalSessionId` 保存一个 runtime entry，并记录多个 attached client。
- tmux-backed session 的最后一个 terminal WebSocket client 断开后，backend dispose 当前 node-pty attach runtime；tmux session 本身保留。下次连接重新 attach 并重新取 snapshot。

以上是数量和生命周期事实，本原型不据此判断是否存在性能问题。

## 文件

- `index.html`：页面壳层、流程图布局与样式。
- `app.js`：视图切换、场景切换、节点详情和接口筛选。
- `mock-state.json`：代码现状模型、流程步骤、事件通道、接口与代码源。
- `prototype-preview.png`：Playwright 验收保存的首屏截图。

## 原型简报

- **目标**：把统一事件实现完成后 Project / Terminal Session / xterm / Runtime / App / Event 的真实关系讲清楚。
- **用户动作**：切换五个视图；在“输入链路”视图切换输入入口；点击节点查看职责、数据与代码依据；按协议类型筛接口。
- **主要用户**：正在定位 Terminal Workspace、App terminal 或 backend runtime 链路的开发者。
- **影响的真实产品界面或模块**：无。此目录是说明原型，不修改产品界面。
- **关键流程**：加载项目与 session、选择 session、建立 xterm terminal WS、发送输入、返回 output、由 manager 识别 bell/metadata 并通过全局 terminal event 分发、消费 App Server agent event。
- **重要状态**：active Project、active Terminal Session、surface cache、connection/runtime status、TerminalState、tmux panel workspace、ThreadRef。
- **非目标**：不评价本次实现，不提出下一步拆分/合并建议，不作性能诊断。

## 功能分类

### 说明原型核心功能

| 元素 / 行为 | 用途                                   | 是否代表产品 UI      |
| ----------- | -------------------------------------- | -------------------- |
| 五个主视图  | 按关系、输入、事件、对象、接口拆开阅读 | 否，属于架构文档导航 |
| 场景切换    | 对比 IME 与四条普通输入链路            | 否，属于架构文档交互 |
| 节点详情    | 显示对象职责、字段、接口与代码源       | 否，属于架构文档交互 |
| 协议筛选    | 过滤 REST / WS / internal 接口         | 否，属于架构文档交互 |

### 原型辅助功能

无额外 mock 状态开关或隐藏 helper 面板。页面中的所有控件都是这份架构说明本身的导航能力，不进入 Runweave 产品 UI。

## 代码源

### Web / Electron Terminal Workspace

- `frontend/src/components/terminal/terminal-workspace.tsx`
- `frontend/src/components/terminal/terminal-workspace-{effects,events,shell,stage}.tsx`
- `frontend/src/features/terminal/{workspace-store,surface-cache,use-terminal-connection,use-terminal-events-connection}.ts`
- `frontend/src/components/terminal/{terminal-surface,use-terminal-emulator,use-terminal-output-stream,use-terminal-snapshot-restore}.tsx`

### App

- `app/src/routes/AppRoutes.tsx`
- `app/src/hooks/{use-app-session,use-app-terminal-connection,use-app-terminal-actions}.ts`
- `app/src/pages/{HomePage,AppTerminalPage}.tsx`
- `app/src/components/{AppTerminalPanels,TerminalCommandComposer}.tsx`
- `packages/terminal-renderer/src/TerminalRenderer.tsx`

### Backend / Runtime

- `backend/src/terminal/{manager,manager-records,store,runtime-recorder,runtime-registry,runtime-launcher,tmux-output-watcher,tmux-service}.ts`
- `backend/src/routes/{terminal,terminal-project-routes,terminal-input-dispatcher,terminal-panel-routes,app-home-overview}.ts`
- `backend/src/ws/{terminal-server,terminal-events-server}.ts`
- `packages/shared/src/terminal-protocol.ts`

### App Server / 状态事件

- `packages/shared/src/app-server-events.ts`
- `app-server/src/{event-center,state-projector,state-store}.ts`
- `backend/src/app-server/{event-consumer,handlers/agent-hook,handlers/agent-completion}.ts`
- `backend/src/terminal/{terminal-state-service,terminal-event-service}.ts`

## 验证点

- 默认视图能看到 Web/Electron、App、backend、runtime、App Server 五段关系。
- macOS 拼音场景明确显示：预编辑阶段 terminal input frame 为 `[]`，候选提交后只产生一个 `{ type: input, data: 建议 }`。
- 四个普通输入场景的 transport 不混写：桌面 xterm / App shortcut 走 terminal WS；两个 composer 走 input REST。
- 事件视图明确区分三条 WebSocket 流，并显示 bell 与 metadata 由全局 terminal event bus 分发；composition 与 terminal input/output 不进入全局事件流。
- 对象视图能看到 `Project 1:N Session`、`Session 1:N Panel` 与 xterm/ThreadRef 的引用关系。
- 接口视图可以按 `REST`、`WebSocket`、`Internal` 过滤。
- 页面不出现下一步架构建议或性能好坏判断。

## 调整与冻结记录

| 轮次 | 调整内容                                                    | 原因                                                  | 结果                                                         |
| ---- | ----------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------ |
| 1    | 以三条平面组织：对象/运行时、终端数据、状态事件             | 当前同名“项目/终端/事件”分布在多个模块                | 每条连线可以回指代码源                                       |
| 2    | 加入 App overview 与 App composer                           | “上面”按“App 上”解释                                  | 同图对比两套客户端                                           |
| 3    | 单列 surface cache / headless / runtime client 数量         | 用户提到可能存在性能问题，但要求不做判断              | 只陈述当前数量与生命周期                                     |
| 4    | 删除 headless 数量，增加全局 bell / metadata 生产与消费链路 | 产品代码已切换到统一事件实现                          | 原型同步为实现后的当前架构                                   |
| 5    | 增加真实 IME composition 本地边界与单轮提交状态             | 原输入图把预编辑和已提交 input 混成一条 raw data 链路 | 图中明确预编辑为 0 帧、候选提交为 1 帧，并与全局事件 WS 分离 |

- **最终采用的交互**：五视图导航 + 五种输入场景切换 + 节点详情 + 接口筛选。
- **放弃的方向**：不在图中继续推导其它 WebSocket 合并、runtime 生命周期或缓存策略。
- **实施状态**：`TerminalHeadlessConnection` 已删除；bell 与 session metadata 已接入全局 terminal event bus。
- **冻结时间**：2026-07-11。

## 边界

- 原型不连接真实后端，不导入生产源码。
- 数据来自本次对当前工作区代码的静态追踪，不代表运行中实例的实时数量。
- App Server 在图中只展示与 Project / Terminal / Agent 状态相关的部分，不展开 Agent Team、Browser、Preview、Voice 等其它子系统。
- 本原型只陈述“本次实现后的代码如何工作”；任何结构优劣、性能瓶颈或后续决策都不在范围内。
