# terminal-project-session-runtime-flow（项目 / 终端 / xterm 架构诊断图）

Runweave 当前项目、终端 session、xterm.js、PTY/tmux、App 与事件系统关系的可运行说明原型。

- **性质**：基于真实复现更新后的代码诊断图；P1/P2/P4 展示已验证修复，P3/P5 展示未达到修改门槛的证据。
- **代码基线**：包含 terminal event recovery、结构刷新合并与离线输入修复的当前工作区，梳理日期 `2026-07-11`。
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

1. **诊断主图**：只保留 Session 数据面、Workspace 事件增量和 REST 权威快照三条主链，并把 P1—P5 问题编号钉在真正发生的边界上。
2. **输入链路**：对比 macOS 拼音 composition、桌面 xterm、桌面浮动 composer、App composer 与 App 快捷输入分别在哪一层提交文本。
3. **事件链路**：区分浏览器本地 composition、`/ws/terminal` xterm 字节流、全局 `/ws/terminal-events` 工作区事件流、App Server `/events/stream` Agent 事件流；bell 与 session metadata 统一进入全局事件流。
4. **对象与数量**：Connection、Project、Terminal Session、Panel、xterm、Runtime、tmux session/pane 与 ThreadRef 的主键、归属和生命周期。
5. **接口清单**：列出本图涉及的 REST、WebSocket、内部事件接口及其消费者。

## 一句话结论

系统由 `REST 权威快照 + 1 条全局事件增量 + 最多 10 条已挂载 session 数据连接` 组成。事件增量通过 `streamId + cursor gap` 回到权威快照，突发结构事件在客户端合并刷新；cached surface 资源乘数与 metadata 双出口保持现状，因为本轮没有复现用户可见故障。

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

主图区分“复现并修复”和“未复现故障、不修改”：事件 cursor/gap、结构刷新放大和离线输入已通过真实环境回归；surface 资源乘数与 metadata 双出口没有复现用户可见错误。

## 文件

- `index.html`：页面壳层、流程图布局与样式。
- `app.js`：视图切换、问题定位、场景切换和接口筛选。
- `mock-state.json`：代码现状模型、流程步骤、事件通道、接口与代码源。
- `prototype-preview.png`：Playwright 验收保存的首屏截图。

## 原型简报

- **目标**：让读者先看到三条主链，再沿问题编号追到触发条件、代码机制、可见症状与代码证据。
- **用户动作**：在诊断主图点击 P1—P5；切换输入场景；查看事件、对象与接口证据；按协议类型筛接口。
- **主要用户**：正在定位 Terminal Workspace、App terminal 或 backend runtime 链路的开发者。
- **影响的真实产品界面或模块**：无。此目录是说明原型，不修改产品界面。
- **关键流程**：加载项目与 session、选择 session、建立 xterm terminal WS、发送输入、返回 output、由 manager 识别 bell/metadata 并通过全局 terminal event 分发、消费 App Server agent event。
- **重要状态**：event streamId / cursor / gap / seen ids / 500 条 backlog、surface cache、connection/runtime status、TerminalState、session metadata。
- **非目标**：不在原型中选择修复方案，不把未测量的资源成本写成既成性能故障，不展开无关子系统。

## 功能分类

### 说明原型核心功能

| 元素 / 行为 | 用途                                   | 是否代表产品 UI      |
| ----------- | -------------------------------------- | -------------------- |
| 五个主视图  | 按诊断、输入、事件、对象、接口拆开阅读 | 否，属于架构文档导航 |
| 场景切换    | 对比 IME 与四条普通输入链路            | 否，属于架构文档交互 |
| 问题定位    | 点击 P1—P5 查看触发、机制、症状和证据  | 否，属于架构文档交互 |
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

- 默认视图只展示三条主链，并能明确读出 `1 global + ≤10 session WS`，不再平铺全部模块。
- P1—P5 均可点击，详情必须区分“已复现并修复”和“没有达到修改门槛”。
- P1 明确展示 `streamId + cursor gap + authoritative resync`，并保留 backend restart / 500 条窗口的失败边界。
- P2 展示 50 ms 合并刷新前后的请求数量；P3 展示实测资源乘数，但不把它写成已确认性能瓶颈。
- P4 明确展示离线输入不再进入应用层或浏览器 WebSocket 缓冲；P5 明确展示双出口存在但未复现双写 UI。
- macOS 拼音场景明确显示：预编辑阶段 terminal input frame 为 `[]`，候选提交后只产生一个 `{ type: input, data: 建议 }`。
- 四个普通输入场景的 transport 不混写：桌面 xterm / App shortcut 走 terminal WS；两个 composer 走 input REST。
- 事件视图明确区分三条 WebSocket 流，并显示 bell 与 metadata 由全局 terminal event bus 分发；composition 与 terminal input/output 不进入全局事件流。
- 对象视图能看到 `Project 1:N Session`、`Session 1:N Panel` 与 xterm/ThreadRef 的引用关系。
- 接口视图可以按 `REST`、`WebSocket`、`Internal` 过滤。
- 页面不出现下一步架构建议或性能好坏判断。

## 调整与冻结记录

| 轮次 | 调整内容                                                    | 原因                                                       | 结果                                                         |
| ---- | ----------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------ |
| 1    | 以三条平面组织：对象/运行时、终端数据、状态事件             | 当前同名“项目/终端/事件”分布在多个模块                     | 每条连线可以回指代码源                                       |
| 2    | 加入 App overview 与 App composer                           | “上面”按“App 上”解释                                       | 同图对比两套客户端                                           |
| 3    | 单列 surface cache / headless / runtime client 数量         | 用户提到可能存在性能问题，但要求不做判断                   | 只陈述当前数量与生命周期                                     |
| 4    | 删除 headless 数量，增加全局 bell / metadata 生产与消费链路 | 产品代码已切换到统一事件实现                               | 原型同步为实现后的当前架构                                   |
| 5    | 增加真实 IME composition 本地边界与单轮提交状态             | 原输入图把预编辑和已提交 input 混成一条 raw data 链路      | 图中明确预编辑为 0 帧、候选提交为 1 帧，并与全局事件 WS 分离 |
| 6    | 用三条主链 + P1—P5 问题索引替换模块卡片总览                 | 原总览把对象、接口、事件和数量放在同一层，无法形成因果判断 | 主图从触发条件追到代码机制与可见症状，目录型信息退到其它视图 |
| 7    | 同步 P1/P2/P4 修复与 P3/P5 保持现状结论                     | 产品实现与真实复现已经完成，旧诊断文案不再代表当前行为     | 主图、事件反应表、接口与 README 统一展示当前工作区语义       |

- **最终采用的交互**：诊断主图问题定位 + 五视图导航 + 五种输入场景切换 + 接口筛选。
- **放弃的方向**：不再用模块卡片平铺作为主图；不在图中替用户选择 WebSocket 合并、持久事件存储或缓存策略。
- **实施状态**：`TerminalHeadlessConnection` 已删除；bell 与 session metadata 已接入全局 terminal event bus；P1/P2/P4 已修复并通过真实验证。
- **冻结时间**：2026-07-11。

## 边界

- 原型不连接真实后端，不导入生产源码。
- 关系与接口来自当前工作区代码追踪；P1—P5 结论同时引用 `docs/testing/terminal-event-recovery-test-cases.md` 的真实 WS / Playwright 执行结果。
- App Server 在图中只展示与 Project / Terminal / Agent 状态相关的部分，不展开 Agent Team、Browser、Preview、Voice 等其它子系统。
- 主图中的 P1—P5 已按 `docs/testing/terminal-event-recovery-test-cases.md` 执行；P3/P5 因未复现用户可见故障而保持现状。
- 原型只定位问题和失效条件，不给出修复优先级、目标架构或实施决策。
