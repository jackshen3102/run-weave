# Desktop Slot Companion 最终原型

Runweave 超级终端的桌面注意力入口。唯一目标模式是：**Slot 托盘 + 高优先级单卡 + 休眠宠物**。

这里的 Slot 指当前 Backend 中一个可恢复的 Terminal 工作位置：`Connection + Project/Worktree + Terminal Session + 可选 Panel + 可选 Agent Team Run`。

## 启动

```bash
python3 -m http.server 6188 --directory docs/prototypes/desktop-slot-companion
```

打开：

```text
http://127.0.0.1:6188/
```

页面不提供方案或场景切换控件。默认展示混合关注状态。

## 最终行为

1. 当前 Backend 存在活跃或未确认事实时，宠物旁显示 Slot 托盘。
2. 最高优先级 Slot 是 Agent Team Human Gate 或明确验收阻塞时，托盘升级成单卡。
3. 暂时收起单卡后恢复托盘；同一 Runweave 进程内，当前已经存在的全部高优先级 attentionId 一次性进入暂时抑制集合，新 attentionId 仍会重新升级单卡。应用重启后，未解决的高优先级事实会重新提醒。
4. 点击 Slot 后唤起 Runweave，定位到对应 Terminal Session；有可靠 Panel 身份时继续聚焦 Panel。
5. Agent Team 事实打开 Agent Team 二路窗；普通 Terminal 事实只打开 Terminal。
6. 点击未确认 Completion 后，先成功打开目标 Session，再确认对应 `completionRevision`；Panel 失效时退回 Session 并提示，仍可确认。Connection 或 Session 跳转失败时不确认。
7. 点击失败事实并成功打开目标 Session 后，只在 Companion 内把该 attentionId 标为已查看；真实 Terminal 或 Agent Team 失败状态不改变。已查看记录按 Connection 与 attentionId 持久化，新失败事实使用新 attentionId 再次出现。
8. 用户主动收起托盘后，working、completed、failed 的更新只改变宠物徽标或颜色，不自动展开；新的 Human Gate 或明确验收阻塞仍会自动升级单卡。
9. 没有活跃或未确认事实时，只显示不可展开的休眠宠物。
10. 当前 Connection 无法认证或 Backend 不可达时，不显示托盘或单卡，也不伪装成安静状态；显示带断连标识的灰色宠物，点击打开主窗口的连接或登录入口，恢复连接后自动重新采集。

## 状态计算

页面不接受预先写好的 `state / statusLabel / task / priority`。`app.js` 只从 `mock-state.json` 中生产 DTO 字段的裁剪快照计算 UI 状态，`scenario-states.json` 也只修改源字段。

优先级固定为：`needs_action > blocked > failed > completed > working > idle`。

| HMI 状态   | 生产字段                                 | 计算条件                                                                                              | 单卡 |
| ---------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---- |
| 需要你决定 | `AgentTeamRun`                           | `status=need_human` 且 `pendingFindingDecision!=null`                                                 | 是   |
| 验收受阻   | `AgentTeamRun`                           | `status=need_human`，并且 `frameworkRepair.result=blocked` 或存在 `pending + skipped` acceptance case | 是   |
| 异常退出   | `TerminalSessionListItem`                | `status=exited` 且 `exitCode!=0`                                                                      | 否   |
| 完成待查看 | `TerminalSessionListItem`                | `completionRevision > acknowledgedCompletionRevision`                                                 | 否   |
| 执行中     | `AgentTeamRun / TerminalSessionListItem` | Run `status=running`，或 Terminal 为 `agent_starting / agent_running`                                 | 否   |
| 空闲       | `TerminalSessionListItem`                | 没有上述事实，Terminal 为 `shell_idle / agent_idle`                                                   | 否   |

不从 Terminal 输出、停顿时长、Browser/CDP 状态或日志关键字推断 Slot 是否阻塞。

## 可见数据来源

| 页面内容                    | 数据来源                                                                                    | 生产代码证据                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Connection 名称与 ID        | 当前 Electron `ConnectionConfig`                                                            | `frontend/src/features/connection/types.ts`、`use-connections.ts`                       |
| Project 名称                | `TerminalProjectListItem`                                                                   | `packages/shared/src/terminal/project.ts`、`GET /api/terminal/project`                  |
| Worktree、branch、projectId | `TerminalProjectContextListItem`                                                            | `packages/shared/src/terminal/project-context.ts`、`terminal-project-context-routes.ts` |
| Session 名称与状态          | alias、cwd、activeCommand、terminalState                                                    | `packages/shared/src/terminal/session.ts`、`state.ts`                                   |
| Completion 是否未确认       | completion revision 两个字段                                                                | `TerminalSessionListItem`、`acknowledgeSessionCompletion()`                             |
| Completion 标题             | 匹配 revision 的 `completion.payload.summary`，否则使用 `session.preview`                   | `packages/shared/src/terminal/completion.ts`、`completion-event-service.ts`             |
| Terminal 异常退出           | `status / exitCode`                                                                         | `TerminalSessionListItem`、`terminal-server.ts`                                         |
| Agent Team 任务与状态       | `task / status / loop / activeWorkerRole`                                                   | `packages/shared/src/agent-team.ts`                                                     |
| Human Gate 标题             | `pendingFindingDecision.finding.title / reason`                                             | `AgentTeamPendingFindingDecision`                                                       |
| 验收阻塞详情                | acceptance `caseId / text / skipReason / lastRunStatus`                                     | `AgentTeamAcceptanceCase`、`service-execution.ts`                                       |
| 相对时间                    | `updatedAt / createdAt / lastActivityAt`                                                    | Agent Team 与 Terminal DTO                                                              |
| 精确 Panel                  | Completion event `panelId`、Agent Team worker/dispatch `panelId` 或已读取的 Panel workspace | `terminal/panel.ts`、`focus-pane` 与 Terminal Panel PATCH 路由                          |

Terminal `preview` 来自已有 Codex thread snapshot 链路。`terminalHistory.scrollback` 只用于绘制背景 Terminal，不参与任何注意力判断。

## Panel 精度边界

`completionRevision` 是持久化的 Session 级事实；Completion event 中的 `panelId` 目前只保存在 Backend 内存事件流。Backend 重启后，未确认 Completion 仍然存在，但旧 event 的 Panel 身份可能不存在。

因此跳转规则固定为：

1. 有与当前 revision 匹配的 Completion event、Agent Team worker/dispatch，或已读取的 Panel workspace 时，携带 `panelId`。
2. 没有可靠 Panel 身份时，只携带 `terminalSessionId`，绝不使用 `activePanelId` 冒充完成事件来源。
3. Panel 已失效时退回 Session，并提示用户；不跳到其他 Panel。

## 一键跳转 Intent

原型中每个可点击 Slot 都带以下 `data-*` 字段，空的 `panelId / runId` 表示按上述规则降级：

```text
connectionId
projectId
terminalSessionId
panelId?
runId?
targetSurface: terminal | agent-team
```

生产实现按固定顺序执行：

1. Electron 主进程恢复、显示并聚焦现有主窗口。
2. 前端进入已有 `/terminal/:terminalSessionId` 路由。
3. 如 `panelId` 存在，调用现有 `PATCH /api/terminal/session/:sessionId/panels/:panelId`，请求 `{ focus: true }`。
4. 如 `targetSurface=agent-team`，启用当前 Session 的 panel split，并调用现有 `openAgentTeam()`。
5. 如点击的是 Completion，调用现有 Session PATCH 写入 `acknowledgedCompletionRevision`。

当前缺少的是桌面悬浮窗口与主窗口之间的统一 IPC intent；窗口恢复、Terminal 路由、Panel focus、Agent Team sidecar 和 Completion acknowledgement 的下游动作都已经存在。新增 IPC 只负责传递以上身份，不负责重新推断状态。

## 第一阶段采集闭环

第一阶段限定当前激活 Connection 对应的 Backend：

1. 读取 `GET /api/terminal/project` 与各 Project 的 contexts。
2. 读取 `GET /api/terminal/session`，建立全部 Terminal Slot。
3. 对每个 Project/Worktree `projectId` 读取 `GET /api/agent-team/runs?projectId=...`。
4. 订阅已有 Terminal events WebSocket，实时接收 Completion 与 Terminal 状态变化；断线重连后重新读取 Session 列表。
5. 只为需要精确 Panel 的活跃项读取 `GET /api/terminal/session/:id/panels`，不对所有 Session 持续轮询历史。
6. Agent Team 沿用当前页面的 4 秒轮询间隔，或在生产实现时补同等语义的事件推送；Companion 本身不维护第二套 Run 状态机。

跨 Connection 聚合不属于第一阶段。当前 Connection 配置与 token 都是 renderer 作用域，直接跨全部 Connection 拉取会额外引入认证、离线和资源隔离语义。

## 桌面窗口

生产实现新增一个独立 Electron `BrowserWindow`：透明、无边框、置顶、默认不获取焦点，固定锚定主屏幕 workArea 右下角。它不跟随鼠标、焦点或主窗口跨屏移动，只在主屏幕、分辨率、缩放、Dock 或任务栏导致 workArea 变化时重新计算位置。托盘和单卡展开时窗口按内容调整可点击区域；收起后只保留宠物区域。

窗口在所有桌面空间和全屏空间可见，普通空间与全屏空间使用同一套状态与升级规则。第一阶段不尝试检测其他应用是否进入全屏，也不引入 macOS Accessibility 或原生模块。

第一阶段只承诺 macOS 行为和验收。实现可以使用 Electron 跨平台 API，但不为 Windows 打包，也不把 Linux/Wayland 位置与置顶差异纳入首期范围。

Electron 托盘菜单提供默认勾选的“显示桌面宠物”。关闭后销毁 Companion 窗口并停止采集，偏好跨应用重启保留；第一阶段不增加设置页。

这个窗口只投影采集结果并发送跳转 intent。它不连接 PTY、不解析 Terminal 输出，也不直接操作 Agent Team 状态机。

## 展开与退役边界

- 首次启动且存在 Slot 时默认展开托盘；用户主动收起后，非高优先级变化不再自动展开。
- 自动展示、刷新和单卡升级不抢占系统焦点；只有用户点击 Slot 后才恢复并聚焦主窗口。
- 单卡只展示当前最高优先级 Slot；收起单卡时批量抑制当时已经存在的高优先级 attentionId，而不是永久忽略事实。
- Completion 的退役事实写入现有 `acknowledgedCompletionRevision`；必须先成功打开目标 Session。
- 失败事实的“已查看”只属于 Companion 展示层，按 Connection 与 attentionId 持久化；跳转失败不写入。
- Human Gate 与验收阻塞不因点击 Slot 自动消失；必须等待 Agent Team 产生新的结构化状态，或只在本进程中被用户暂时收起。

## 目标状态覆盖

隐藏 URL 参数只用于验收同一最终方案，不进入产品 UI：

```text
?scenario=mixed-attention
?scenario=flowing
?scenario=agent-team-running
?scenario=completed
?scenario=blocked
?scenario=terminal-exited
?scenario=quiet
```

七个场景分别覆盖：混合关注、持续执行、Agent Team 执行、未确认 Completion、验收阻塞、Terminal 非零退出和全部安静。

## 不进入第一阶段的数据

- Browser 页面是否加载成功。
- CDP 是否异常断开。
- Runtime、App Server 或外部线路是否健康。
- Terminal 输出是否包含 error、failed、blocked 等文本。
- Review、typecheck、lint 或验收是否通过，除非 Agent Team acceptance 已产生对应结构化事实。
- 跨 Connection 的统一注意力排序。
- 鼠标、焦点或主窗口所在屏幕的动态跟随。
- 外部应用全屏状态检测与全屏专用展示策略。

这些信息没有完整的 Slot identity 与稳定退役边界前，不允许进入 Companion。

## 原型文件

```text
index.html               页面挂载点
app.js                   状态计算、唯一 UI 与最终交互
style.css                唯一 UI 样式
mock-state.json          生产 DTO 字段投影的基础快照
scenario-states.json     只修改源字段的七个状态快照
prototype-slot-tray.png  最终托盘截图
prototype-scenario-*.png 七个状态截图
```

## 验收标准

- 页面中没有布局切换器、替代方案入口或替代方案 DOM。
- mock 与 scenario 文件不包含预计算的 HMI `state / statusLabel / priority / targetSurface`。
- 七个场景的可见状态均由生产字段现场计算。
- 所有可见 Slot 都有非空 `connectionId / projectId / terminalSessionId / statusSource / statusEvidence / targetSurface`。
- 只有具备可靠来源的 Slot 才携带 `panelId`。
- Human Gate 与明确验收阻塞首次显示单卡；收起后恢复托盘，同批高优先级事实在本进程中不反复弹出，新 attentionId 仍会升级。
- 点击 Completion 只有在 Session 成功打开后才确认 revision；Panel 失效可以降级，Connection 或 Session 跳转失败不能退役。
- 点击失败事实成功跳转后只退役 Companion 提醒，不修改真实失败状态；该记录跨重启保留，新失败仍会出现。
- 用户收起托盘后非高优先级变化不自动展开。
- 全部安静时只有禁用状态的休眠宠物。
- Backend 或认证不可用时显示断连宠物，不能与安静状态混淆。
- 窗口固定在主屏幕 workArea 右下角，在所有桌面空间和全屏空间保持同一行为，不跟随鼠标或焦点。
- Electron 托盘可关闭并持久化桌面宠物；关闭时不继续轮询。
- 浏览器 console 为 0 error / 0 warning。

本目录只冻结产品意图与可实现数据合同，不修改生产代码，也不新增单元测试。
