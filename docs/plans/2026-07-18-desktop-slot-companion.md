# Desktop Slot Companion 实施计划

> 状态：待实施
> 粒度：L2（跨 shared、backend、frontend、Electron、持久化与桌面验收）
> 交互基准：docs/prototypes/desktop-slot-companion/
> 配套测试计划：docs/testing/platform/desktop-slot-companion.testplan.yaml
> 首期平台：macOS

## 决策摘要

Desktop Slot Companion 是当前激活 Connection 的全局注意力入口，不是第二套 Terminal、Agent Team 或运行健康系统。

唯一产品形态是：

```text
结构化 Terminal / Agent Team 事实
             ↓
      Attention 投影
             ↓
休眠或断连宠物 ← Slot 托盘 → 高优先级单卡
             ↓ 用户点击
主窗口 → Terminal Session → 可靠 Panel → 可选 Agent Team 二路窗
```

首期冻结以下规则：

1. 平时使用 Slot 托盘聚合当前 Connection 的结构化状态。
2. Agent Team Human Gate 或明确验收阻塞出现时，只把最高优先级 Slot 升级为单卡。
3. 收起单卡时，本进程内批量抑制当时已经存在的全部高优先级 attentionId；新的 attentionId 仍重新升级，应用重启后未解决事实重新提醒。
4. 用户主动收起普通托盘后，working、completed、failed 的变化只更新宠物徽标或颜色，不自动展开；新的高优先级事实仍自动打开单卡。
5. 点击 Slot 后才聚焦主窗口。自动展示、轮询刷新和升级单卡不抢系统焦点。
6. Completion 必须先成功打开目标 Session，并在有界时间内返回 opened 或 opened_with_panel_fallback；之后异步确认精确 completionRevision。Panel 失效可降级到 Session，Connection 或 Session 跳转失败不得确认；确认失败或挂起时保持提醒，不能把已经完成的跳转改写为失败或超时。
7. 失败事实成功跳转后，只在 Companion 中按 Connection 与 attentionId 持久化为已查看，不改变真实 Terminal 或 Agent Team 失败状态。
8. 当前 Connection 无法认证或 Backend 不可达时显示断连宠物，不把未知状态表现成全部安静。
9. 窗口固定在主屏幕 workArea 右下角，不跟随鼠标、焦点或主窗口；显示器拓扑或 workArea 改变时重新定位。
10. 窗口在所有桌面空间和全屏空间可见，普通空间与全屏空间使用同一状态规则；不检测其他应用全屏状态。
11. Electron 托盘提供默认启用且持久化的“显示桌面宠物”开关；关闭后销毁窗口并停止采集。
12. 首期只承诺当前激活 Connection 和 macOS，不做跨 Connection 聚合、不打包 Windows、不承诺 Linux/Wayland。

## 目标

- 用一个独立、低打扰的 Electron 窗口承载跨 Terminal Session 的 Slot 注意力聚合。
- 只使用当前代码中可验证的结构化事实，明确区分 needs_action、blocked、failed、completed、working、quiet 与 disconnected。
- 让用户从桌面宠物一键恢复主窗口并精确打开对应 Session；可靠身份存在时继续聚焦 Panel 或打开 Agent Team 二路窗。
- 为 Completion、失败提醒和高优先级收起分别建立可解释、不会误伤真实状态的退役边界。
- 保持现有 Terminal、Agent Team、Connection 与认证模型不变，新增能力只做投影、展示和导航编排。

## 非目标

- 不解析 Terminal 输出、scrollback、日志关键字或停顿时长来判断异常或阻塞。
- 不判断 Browser 页面、CDP、Runtime、App Server 或外部线路健康。
- 不跨 Connection 拉取、排序或跳转 Slot。
- 不新增第二套 Agent Team 状态机或修改 Human Gate 的解决语义。
- 不使用 activePanelId 猜测 Completion 来源。
- 不跟随鼠标、焦点或主窗口切换显示器，也不支持拖拽改锚点。
- 不检测其他应用是否进入全屏，不引入 macOS Accessibility 权限或原生模块。
- 不增加设置页、Windows 安装包或 Linux/Wayland 专项兼容。
- 不新增单元测试文件。

## 原型交接

- 原型目录：docs/prototypes/desktop-slot-companion/
- 启动命令：python3 -m http.server 6188 --directory docs/prototypes/desktop-slot-companion
- 唯一方案：Slot 托盘 + 高优先级单卡 + 休眠宠物。
- 产品核心：跨 Slot 状态聚合、人工介入优先、桌面一键跳回 Slot、断连与安静分离、提醒退役。
- 原型辅助：隐藏 scenario 参数和 mock 数据只用于同一方案的状态验收，不进入产品 UI。
- 放弃方向：极简宠物、单卡常驻、任务岛、多方案切换器、指标总览行和不可实现的 Browser 线路推断。

现有静态原型冻结视觉密度与主要状态；README 冻结新增的断连、定位、全屏、收起和退役规则。实现阶段不得恢复原型中的过渡方案，也不得把 mock 文案直接当生产事实。

## 当前代码事实与差异

| 领域              | 当前事实                                                                                             | 本次差异                                                                               |
| ----------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Electron 窗口     | electron/src/desktop-window.ts 只创建主窗口，electron/src/desktop-runtime-state.ts 只持有 mainWindow | 增加独立 companionWindow、生命周期、尺寸与主屏锚定                                     |
| Electron 托盘     | electron/src/tray.ts 使用静态菜单管理主窗口                                                          | 增加持久化复选项，负责创建或销毁 Companion                                             |
| Electron preload  | electron/src/preload.ts 没有 Companion API                                                           | 增加最小尺寸上报、Slot 打开与结果回传 API                                              |
| Frontend 路由     | frontend/src/App.tsx 处理认证与主产品路由；frontend/src/main.tsx 总是渲染 Beta 标识                  | 增加 Electron 专用 /desktop-companion 路由，断连时也能渲染，并跳过 Beta 标识           |
| Connection 与认证 | useConnections 和 useScopedAuth 从 localStorage 初始化，但没有跨窗口 storage 同步                    | 补 storage 监听，让主窗口与 Companion 使用同一当前 Connection 和 token                 |
| Terminal 状态     | TerminalSessionListItem 已含 status、exitCode、terminalState、completion revisions                   | 投影 failed、completed、working，不改 Session 存储                                     |
| Completion        | completion event 带 revision、summary、panelId，但事件只在 Backend 内存中保留                        | 精确 event 存在时携带 panelId；重启丢失时只跳 Session                                  |
| Agent Team        | AgentTeamRun 已含 status、pendingFindingDecision、frameworkRepair、acceptance、run/worker/panel 身份 | 投影 needs_action、blocked、failed、working，不改 Run 状态                             |
| Agent Team 查询   | 现有页面偏向单 Session；Backend 已有 listAllProjectContexts 和按 projectId listRuns 能力             | Backend 一次生成当前 Connection 的全量 Attention snapshot，避免 Companion N 路 fan-out |
| Terminal 跳转     | /terminal/:terminalSessionId、Panel focus PATCH、openAgentTeam 和 Completion ack 已存在              | 增加跨窗口 intent、主窗口应用结果和精确退役握手                                        |
| 状态刷新          | Terminal events WebSocket 已可触发刷新；Agent Team 页面采用 4 秒轮询                                 | Companion 4 秒拉取 snapshot，Terminal event 到达时立即刷新                             |
| Activity          | Activity 是历史审计事实，不是完整当前状态                                                            | 不作为 Attention 当前状态源                                                            |

## 目标架构

### 单一状态投影

```text
TerminalSessionManager ─┐
TerminalStateService ───┤
CompletionEventService ─┼─ AttentionService ─ GET /api/attention/slots
AgentTeamService ────────┘                         │
                                                  ▼
                                 Companion renderer read model
```

AttentionService 位于 Backend，原因是：

- Backend 已持有全部 Project context、Session、Completion event 和 Agent Team run。
- 可以在一个一致的请求中完成一 Slot 一事实、排序、来源证据和 Panel 精度降级。
- 避免独立 renderer 对每个 Project、Session 和 Run 发起 N 路请求。
- 状态规则可由 Web、Electron 和后续其他消费者共享，但不把 UI 状态写回业务实体。

AttentionService 是只读投影。它不得读取 Terminal scrollback、历史输出或浏览器状态，也不得直接确认 Completion、解决 Human Gate 或修改 Run。

### Shared 合约

新增 packages/shared/src/attention.ts，并在 packages/shared/package.json 暴露 @runweave/shared/attention 子路径。

建议合约：

```ts
export type AttentionState =
  | "needs_action"
  | "blocked"
  | "failed"
  | "completed"
  | "working";

export type AttentionTargetSurface = "terminal" | "agent-team";

export interface AttentionSlot {
  attentionId: string;
  projectId: string;
  parentProjectId: string;
  projectName: string;
  contextName: string;
  branch: string | null;
  terminalSessionId: string;
  panelId: string | null;
  panelLabel: string | null;
  runId: string | null;
  state: AttentionState;
  title: string;
  detail: string;
  updatedAt: string;
  source: {
    kind: "terminal_session" | "agent_team_run";
    evidence: string;
  };
  targetSurface: AttentionTargetSurface;
  completionRevision: number | null;
}

export interface AttentionSnapshot {
  generatedAt: string;
  slots: AttentionSlot[];
}

export interface AttentionOpenIntent {
  requestId: string;
  connectionId: string;
  attentionId: string;
  projectId: string;
  terminalSessionId: string;
  panelId: string | null;
  runId: string | null;
  targetSurface: AttentionTargetSurface;
  completionRevision: number | null;
}

export type AttentionOpenResult =
  | { status: "opened" }
  | { status: "opened_with_panel_fallback"; message: string }
  | {
      status: "connection_unavailable" | "session_not_found" | "timed_out";
      message: string;
    };
```

Connection 是 Electron renderer 的本地选择，不属于 Backend snapshot；Companion 在发送 intent 时补入当前 connectionId。IPC 不传 token、任意 URL、文件路径或命令。

### 状态投影与排序

优先级固定为：

| 状态         | 分值 | 结构化条件                                                                                    | 自动单卡 |
| ------------ | ---: | --------------------------------------------------------------------------------------------- | -------- |
| needs_action |  600 | Agent Team status=need_human 且 pendingFindingDecision 非空                                   | 是       |
| blocked      |  500 | status=need_human 且 frameworkRepair.result=blocked，或存在 pending + skipped acceptance case | 是       |
| failed       |  400 | Agent Team failed，或 Terminal exited 且 exitCode 非 0                                        | 否       |
| completed    |  300 | completionRevision 大于 acknowledgedCompletionRevision                                        | 否       |
| working      |  200 | Agent Team running，或 Terminal 为 agent_starting / agent_running                             | 否       |

规则：

1. 每个 Terminal Session 最多输出一个 AttentionSlot。
2. 同一 Session 存在相关 Agent Team run 时，Agent Team 事实优先于 Terminal 事实；Run 已完成且没有待处理事实时再回落到 Terminal。
3. Agent Team run 的选择与现有 RunStore 语义一致：优先最新的非 done、非 failed run，否则取最新 run。
4. 同优先级按 updatedAt 倒序，再按 attentionId 稳定排序。
5. idle 不进入 slots。成功响应且 slots 为空才表示 quiet。
6. 请求失败、401 或尚未建立当前 Connection 分别进入 disconnected 或 checking，禁止折叠成 quiet。
7. title 和 detail 只来自现有结构化字段并做长度裁剪；不暴露 token、原始日志、scrollback 或完整 cwd。

### 稳定 attentionId

attentionId 必须标识“同一事实修订”，用于本进程抑制、失败已查看和新事实重提醒：

| 事实                     | ID 构成                                                                    |
| ------------------------ | -------------------------------------------------------------------------- |
| Finding decision         | agent-team:{runId}:finding:{pendingFindingDecision.id}                     |
| Framework repair blocked | agent-team:{runId}:framework-repair:{repairId}                             |
| Acceptance skipped       | runId + 排序后的阻塞 caseId + recheckRequestedAt 或 loop round 的稳定 hash |
| 其他 need_human          | runId + loop round + reason fingerprint                                    |
| Agent Team failed        | agent-team:{runId}:failed                                                  |
| Terminal failed          | terminal:{sessionId}:exit:{lastActivityAt}:{exitCode}                      |
| Completion               | terminal:{sessionId}:completion:{revision}                                 |
| Working                  | 对应 runId；无 Run 时使用 sessionId 与当前 agent activity epoch            |

不得只用状态名作为 ID。相同失败或阻塞事实的轮询结果必须稳定，新 run、新 revision、新 finding 或新的退出事实必须生成新 ID。

## Backend 设计

### AttentionService

新增 backend/src/attention/attention-service.ts：

1. 读取 listAllProjectContexts，建立 projectId、父 Project、名称、分支映射。
2. 读取全部 Terminal Session，丢弃无法归属当前 Backend Project context 的陈旧记录。
3. 对各 context 读取 Agent Team runs，并按 terminalSessionId 建立当前 run 索引。
4. 对未确认 Completion 查找相同 sessionId 与 revision 的最新 Completion event。
5. 按上述规则为每个 Session 选择一个最高优先级事实。
6. 裁剪 title/detail，生成稳定 attentionId 与 source.evidence。
7. 排序并返回 AttentionSnapshot。

首期数据规模沿用本机 Backend 范围。实现时先复用 WorkHistoryService 已有的 context/run 枚举模式；若一次读取出现可测性能问题，再在 AttentionService 内做短 TTL 缓存，不能先引入第二套事件总线。

### HTTP 路由

新增 backend/src/routes/attention.ts：

| 方法 | 路径                 | 行为                                  |
| ---- | -------------------- | ------------------------------------- |
| GET  | /api/attention/slots | 返回当前 Backend 的 AttentionSnapshot |

- 在 backend/src/index.ts 的 requireAuth 保护之后挂载。
- 响应设置 no-store。
- 未认证按现有 401 语义返回；服务不可用由 renderer 识别为 disconnected。
- 路由不接受 connectionId、projectId 列表或任意筛选表达式，避免跨租户或路径枚举。

### Runtime 注入

- 在 backend/src/bootstrap/runtime-services.ts 创建 AttentionService。
- 复用 TerminalSessionManager、TerminalStateService、TerminalEventService 和 AgentTeamService。
- 不让 AttentionService 反向依赖 Express request、Electron 或 frontend 类型。
- 不修改 Terminal 与 Agent Team 的持久化 schema。

## Frontend Companion 设计

### 路由和认证边界

新增 /desktop-companion 特殊路由：

- 只在 Electron 环境渲染 Companion 页面；普通 Web 访问回到现有产品入口。
- 路由必须在主窗口登录重定向之前识别，保证 token 缺失或 Connection 断开时仍能显示断连宠物。
- frontend/src/main.tsx 在该路由不渲染 Beta badge。
- useConnections 与 useScopedAuth 增加 storage 事件同步；主窗口切换 Connection、登录或退出时，Companion 立即切换数据源。
- 不在 IPC 中复制或同步 token；两个 BrowserWindow 继续使用同一 Electron session/origin 的 localStorage。

### 数据 Hook

新增：

- frontend/src/services/attention.ts
- frontend/src/features/attention/use-attention-snapshot.ts
- frontend/src/features/attention/attention-retirement.ts

状态机：

```text
checking
   ├─ 请求成功 + slots=[] → quiet
   ├─ 请求成功 + slots>0 → tray / card
   └─ 无 Connection、401、网络失败 → disconnected
                                      │
                                      └─ 重连成功 → tray / card / quiet
```

- 默认每 4 秒刷新 snapshot。
- Terminal events WebSocket 收到 Completion 或 Terminal 状态变化后立即 invalidate。
- 当前 Connection、token 或 enabled 变化时取消旧请求，忽略迟到响应。
- 断开时不保留过时 Slot 冒充当前事实；可以保留内部 last snapshot 用于调试，但不得显示。
- Companion 被 Electron 销毁时自然停止计时器和订阅；不在主窗口后台继续采集。

### UI 和交互状态

新增：

- frontend/src/pages/desktop-companion-page.tsx
- frontend/src/components/desktop-companion/desktop-companion.tsx
- frontend/src/components/desktop-companion/desktop-companion.css

可见模式：

| 模式         | 条件                                        | 用户动作                                   |
| ------------ | ------------------------------------------- | ------------------------------------------ |
| checking     | 初次读取尚未完成                            | 不可展开，短暂加载语义                     |
| quiet        | 成功读取且没有 Slot                         | 休眠宠物，不可展开                         |
| disconnected | 无当前 Connection、无 token、401 或网络失败 | 灰色断连宠物；点击打开主窗口连接或登录入口 |
| tray         | 存在 Slot且没有未抑制高优先级事实           | 展开、收起、滚动、点击 Slot                |
| card         | 存在未抑制 needs_action 或 blocked          | 只显示最高优先级 Slot，可处理或收起回托盘  |

展开规则：

- 新进程第一次成功读到非空 slots 时打开托盘。
- userCollapsed 只在当前进程保存。
- userCollapsed 后，working、completed、failed 更新不打开托盘。
- 新的高优先级 attentionId 清除视觉收起并打开单卡。
- 单卡收起把当前 snapshot 中全部高优先级 attentionId 加入 process-local suppressedEscalationIds。
- 托盘已打开时，所有变化原位刷新，不额外播放抢眼动画。
- 自动状态变化通过 Electron showInactive 展示，不聚焦窗口。

### 退役存储

| 类型             | 存储位置                                                  | 写入时机                                                  | 重启语义                                         |
| ---------------- | --------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------ |
| 高优先级暂时收起 | Companion 内存 Set                                        | 收起单卡时批量写入                                        | 应用重启后清空，未解决事实重新提醒               |
| Completion 确认  | 现有 Session acknowledgedCompletionRevision               | openSlot 已返回成功后，异步按 intent 的精确 revision 写入 | 服务端持久化；仅 snapshot 已确认 revision 时退役 |
| 失败已查看       | Companion localStorage，key 含 connectionId + attentionId | Session 成功打开后                                        | 跨重启保留；新 attentionId 不受影响              |
| 托盘展开/收起    | Companion 内存                                            | 用户展开或收起                                            | 新进程重新按当前 Slot 决定                       |
| 桌面宠物启用     | Electron userData 偏好文件                                | 托盘复选项改变时                                          | 跨重启保留                                       |

失败已查看集合必须有边界：只保存合法 connectionId/attentionId、最多 500 条，并清理超过 30 天的记录。它只影响 failed Slot；不得隐藏 Human Gate、blocked、Completion 或 working。

## Electron 窗口与 IPC

### Companion BrowserWindow

新增 electron/src/desktop-companion-window.ts：

- transparent、frame=false、resizable=false、skipTaskbar=true。
- alwaysOnTop 使用 floating 级别；窗口不进入任务切换器。
- 使用与主窗口相同的 preload、default session 和 setupSessionIntercept。
- 加载 /desktop-companion。
- 创建后使用 showInactive，不抢当前应用焦点。
- setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })。
- renderer 通过受限 IPC 上报内容宽高；主进程校验范围后 resize 并重新锚定。

位置算法只使用 screen.getPrimaryDisplay().workArea：

```text
x = workArea.x + workArea.width - companionWidth - rightInset
y = workArea.y + workArea.height - companionHeight - bottomInset
```

- 宽高和 inset 使用固定设计值并 clamp 到 workArea。
- 监听 display-added、display-removed、display-metrics-changed。
- 主屏或 workArea 改变时重新读取 primary display。
- 不监听 cursor、focus 或主窗口移动。

### 生命周期和偏好

新增 electron/src/desktop-companion-preferences.ts：

- 在 app.getPath("userData") 下保存最小 JSON，只含 enabled boolean 与 schema version。
- 文件缺失、损坏或字段非法时回退 enabled=true。
- 用临时文件 + rename 原子写入，避免退出时留下半文件。

修改：

- electron/src/desktop-runtime-state.ts：增加 companionWindow 引用。
- electron/src/main.ts：ready 时按偏好创建，退出时清理。
- electron/src/tray.ts：增加“显示桌面宠物”复选项；关闭时销毁窗口，开启时重新创建。
- electron/src/desktop-window.ts：抽取或复用只与 session intercept、主窗口恢复相关的最小能力，不把主窗口尺寸策略复用给 Companion。

### IPC 最小权限

preload 只暴露：

```ts
companionAPI.reportContentSize({ width, height });
companionAPI.openSlot(intent);
electronAPI.onAttentionOpenIntent(listener);
electronAPI.reportAttentionOpenResult(result);
```

主进程校验：

- reportContentSize 和 openSlot 的 sender 必须是 companionWindow.webContents。
- reportAttentionOpenResult 的 sender 必须是 mainWindow.webContents。
- requestId、connectionId、attentionId、Project/Session/Panel/Run ID 均做类型、非空和最大长度校验。
- targetSurface 只接受 terminal 或 agent-team。
- completionRevision 只接受 null 或非负整数。
- 拒绝额外 URL、token、path、shell command 和任意 route。
- 同一 requestId 只完成一次；超时后丢弃迟到结果。

## 一键打开与结果握手

直接让 Companion 在 IPC 返回后立刻退役提醒会产生误确认：主进程只能知道主窗口被显示，不知道 Session、Panel 或 Agent Team 是否真的打开。因此使用结果握手：

```text
Companion
  │ invoke attention:open-slot(intent)
  ▼
Electron main
  │ 校验 sender 与 intent
  │ 恢复 / 显示 / 聚焦 mainWindow
  │ send attention:open-intent
  ▼
Main renderer
  │ 核对当前 connectionId
  │ 导航 /terminal/:terminalSessionId
  │ 等待 Session 可用
  │ 可选 focus panel
  │ 可选 open Agent Team sidecar
  │ report opened / opened_with_panel_fallback
  ▼
Electron main ─ resolve invoke ─▶ Companion
  │
  └─ Main renderer 异步确认精确 completionRevision
```

主窗口处理顺序：

1. 检查 intent.connectionId 仍等于当前激活 Connection；不一致时 fail closed 并让 Companion 刷新，不能跳到另一个 Connection 的同名资源。
2. 恢复并导航到 /terminal/:terminalSessionId。
3. 等待目标 Session 被现有 workspace 选中；Session 不存在返回 session_not_found。
4. panelId 存在时调用现有 focusTerminalPanel。Panel 失效时保留 Session，显示降级提示并继续。
5. targetSurface=agent-team 时启用当前 Session 的 panel split，并调用 openAgentTeam。
6. 第 3 至 5 步完成后立即报告 opened 或 opened_with_panel_fallback；Electron 在 deadline 内把它作为本 requestId 唯一的 openSlot 终态返回。连接失败、Session 不存在或在报告成功前超时返回失败或 timed_out，超时后的迟到结果不得再次完成请求。
7. completionRevision 非空时，在成功结果已经确定后异步调用现有 acknowledgement，只写 intent 携带的精确 revision，不读取并确认更晚 revision。确认失败或挂起不得改写已经返回的 openSlot 结果，也不得提前隐藏提醒。

openSlot 的成功只证明目标表面已经打开，不证明 Completion acknowledgement 已持久化。Completion 是否退役只以之后 snapshot 中 `acknowledgedCompletionRevision >= intent.completionRevision` 为准：确认失败、挂起或 Backend 没有持久化时提醒继续存在；目标表面没有在 deadline 前打开时不发起确认。同一 requestId 只产生一个 openSlot 终态和至多一次确认副作用。

Companion 收到结果后：

- completed：opened 或 opened_with_panel_fallback 后等待异步 acknowledgement，并且只有 snapshot 反映精确 revision 后才退役；确认失败或挂起时保留提醒。
- failed：成功结果才写 failure seen 并从托盘退役；失败时保留。
- needs_action / blocked：打开 Slot 不解决真实事实；只按用户是否收起决定本进程展示。
- working：不写退役事实。

Panel 降级算 Session 打开成功，因此 Completion 可以确认、失败提醒可以标为已查看；UI 必须明确提示没有跳到原 Panel。

## 文件改动清单

| 文件                                                                  | 改动                                                 |
| --------------------------------------------------------------------- | ---------------------------------------------------- |
| packages/shared/src/attention.ts                                      | 新增 Attention snapshot、Slot、intent 与 result 合约 |
| packages/shared/package.json                                          | 增加 @runweave/shared/attention 子路径导出           |
| backend/src/attention/attention-service.ts                            | 聚合结构化 Terminal、Completion 与 Agent Team 事实   |
| backend/src/routes/attention.ts                                       | 新增受认证保护的 GET /api/attention/slots            |
| backend/src/index.ts                                                  | 注入服务并挂载路由                                   |
| backend/src/bootstrap/runtime-services.ts                             | 创建 AttentionService，传入现有服务依赖              |
| frontend/src/services/attention.ts                                    | snapshot 请求                                        |
| frontend/src/features/attention/use-attention-snapshot.ts             | 轮询、事件刷新、断连和迟到响应隔离                   |
| frontend/src/features/attention/attention-retirement.ts               | failure seen 有界持久化                              |
| frontend/src/pages/desktop-companion-page.tsx                         | Electron 专用页面                                    |
| frontend/src/components/desktop-companion/\*                          | 最终托盘、单卡、宠物和状态样式                       |
| frontend/src/App.tsx                                                  | 特殊路由与主窗口 open intent 接收                    |
| frontend/src/main.tsx                                                 | Companion 路由不渲染 Beta badge                      |
| frontend/src/features/connection/use-connections.ts                   | 跨 BrowserWindow 同步当前 Connection                 |
| frontend/src/features/auth/use-scoped-auth.ts                         | 跨 BrowserWindow 同步当前 Connection 的认证          |
| frontend/src/pages/terminal-page.tsx                                  | 把待打开 intent 传入 Terminal workspace              |
| frontend/src/components/terminal/terminal-workspace-content.tsx       | 选择 Session、精确确认 Completion 并回传结果         |
| frontend/src/components/terminal/use-terminal-workspace-agent-team.ts | 复用 Agent Team 二路窗打开链路                       |
| frontend/src/services/terminal.ts                                     | 复用 Panel focus 与 Session acknowledgement 请求     |
| electron/src/desktop-companion-window.ts                              | 独立窗口、定位、尺寸和显示器事件                     |
| electron/src/desktop-companion-preferences.ts                         | enabled 偏好读写                                     |
| electron/src/desktop-runtime-state.ts                                 | 保存 companionWindow                                 |
| electron/src/preload.ts                                               | 最小 Companion IPC surface                           |
| electron/src/tray.ts                                                  | 持久化开关和窗口生命周期                             |
| electron/src/main.ts                                                  | 初始化、IPC handler 与清理                           |
| frontend/tests/desktop-slot-companion.spec.ts                         | 浏览器可验证的状态、展开和退役 E2E；不新增单元测试   |
| docs/README.md                                                        | 实施完成后登记正式功能文档入口                       |

实施时以上述现有职责文件为落点，不得新建平行 workspace store 或重复 Terminal 路由；只有代码在实施前已发生移动时，才允许沿现有导入链落到等价新路径，并在变更说明中记录。

## 实施任务

### 任务 1：冻结交互基准与验收数据

文件：

- docs/prototypes/desktop-slot-companion/README.md
- docs/prototypes/desktop-slot-companion/app.js
- docs/prototypes/desktop-slot-companion/scenario-states.json
- docs/testing/platform/desktop-slot-companion.testplan.yaml

步骤：

1. 保留唯一最终方案，补齐 checking、disconnected、批量抑制、收起后非关键不展开和失败已查看的可视状态。
2. hidden scenario 仍只修改生产 DTO 字段；断连作为请求层场景，不伪造成空 slots。
3. 原型不得增加方案切换器、指标总览或不可实现的 Browser 线路状态。

验证：

- 原型全部场景 console 0 error / 0 warning。
- 页面 DOM 不存在替代方案入口。
- YAML 测试计划通过 pnpm testplan:validate。

### 任务 2：建立 Shared Attention 合约

文件：

- packages/shared/src/attention.ts
- packages/shared/package.json

步骤：

1. 添加 snapshot、Slot、open intent、open result 和枚举。
2. 只通过 @runweave/shared/attention 子路径导出。
3. Backend、frontend 和 Electron 全部引用同一合约，不各自复制 union。

验证：

- pnpm typecheck。
- pnpm lint。
- 检查 shared 合约不依赖 Electron、React、Express 或 Node runtime。

### 任务 3：实现 Backend Attention 投影

文件：

- backend/src/attention/attention-service.ts
- backend/src/routes/attention.ts
- backend/src/index.ts
- backend/src/bootstrap/runtime-services.ts

步骤：

1. 复用现有 context、Session、Completion event、Agent Team run 枚举。
2. 实现一 Session 一 Slot、优先级、稳定 attentionId、Panel 精度和字段裁剪。
3. 新增受 requireAuth 保护的 no-store 路由。
4. 不读取 Terminal scrollback，不修改原始业务状态。

验证：

- pnpm typecheck。
- pnpm lint。
- 使用真实本地结构化状态核对 working、completed、failed、needs_action、blocked、quiet。
- 未认证请求返回 401；成功空结果与网络失败可区分。

### 任务 4：实现 Companion 数据与最终 UI

文件：

- frontend/src/services/attention.ts
- frontend/src/features/attention/\*
- frontend/src/pages/desktop-companion-page.tsx
- frontend/src/components/desktop-companion/\*
- frontend/src/App.tsx
- frontend/src/main.tsx
- frontend/src/features/connection/use-connections.ts
- frontend/src/features/auth/use-scoped-auth.ts

步骤：

1. 增加 Electron 专用特殊路由和跨窗口 Connection/Auth 同步。
2. 实现 checking、quiet、disconnected、tray、card 五种模式。
3. 实现首次展开、用户收起、非关键不重开、高优先级批量抑制和新事实重开。
4. 实现有界 failure seen 存储；过滤已查看 failed Slot，不过滤其他状态。
5. 使用 ahooks useMemoizedFn 保持交互回调稳定；若现有路由边界必须使用 useCallback，在改动说明中写清原因。

验证：

- pnpm typecheck。
- pnpm lint。
- 使用 toolkit:playwright-cli 验证 DOM、点击、滚动、场景切换和 console。
- 对断连、quiet、collapsed + noncritical update、新 attentionId 四个边界保留截图或 DOM 证据。

### 任务 5：实现 Electron 全局固定窗口

文件：

- electron/src/desktop-companion-window.ts
- electron/src/desktop-companion-preferences.ts
- electron/src/desktop-runtime-state.ts
- electron/src/tray.ts
- electron/src/main.ts
- electron/src/preload.ts

步骤：

1. 创建独立透明 BrowserWindow，复用 session intercept 与 preload，但不复用主窗口尺寸。
2. 使用主屏 workArea 固定右下角，响应显示器与 workArea 变化，不监听 cursor/focus。
3. 启用 all workspaces 与 visible on full screen，同一套 UI 状态覆盖普通和全屏。
4. 托盘开关持久化 enabled；关闭时销毁窗口。
5. 增加受 sender 身份和 schema 约束的尺寸与打开 IPC。

验证：

- pnpm typecheck。
- pnpm lint。
- pnpm dist:electron:mac。
- 使用 computer-use 核对主屏右下角、跨 Space、全屏、主窗口切换和托盘开关。
- 使用 toolkit:playwright-cli attach 到 desktop CDP 核对 Companion DOM 与 console；不得用普通浏览器冒充桌面窗口。

### 任务 6：实现主窗口打开握手与精确退役

文件：

- electron/src/main.ts
- electron/src/preload.ts
- frontend/src/App.tsx
- frontend/src/pages/terminal-page.tsx
- frontend/src/components/terminal/terminal-workspace-content.tsx
- frontend/src/components/terminal/use-terminal-workspace-agent-team.ts
- frontend/src/services/terminal.ts
- frontend/src/features/attention/attention-retirement.ts

步骤：

1. 主进程校验 intent，聚焦主窗口并等待 renderer 结果。
2. 主 renderer 核对 Connection、选择 Session、可靠时聚焦 Panel、需要时打开 Agent Team 二路窗。
3. Session 成功后先在 deadline 内返回 opened 或 opened_with_panel_fallback，再异步确认 intent 携带的 completionRevision。
4. Companion 只在成功结果后写 failure seen；Panel fallback 显示提示并算 Session 成功。
5. 超时、Connection 变化、Session 不存在和非法 IPC 都 fail closed。

验证：

- 按配套 testplan 验证成功、Panel fallback、Connection mismatch、Session missing 和 timeout。
- Completion 跳转失败后 acknowledgedCompletionRevision 不变；跳转成功但确认失败或挂起时 openSlot 仍保持成功，提醒继续存在。
- failed 跳转成功后真实 Terminal/Run 失败状态不变，Companion 提醒退役并跨重启保持。
- 新 attentionId 不被旧 seen 或 suppression 隐藏。

### 任务 7：真实 macOS 闭环验收与正式文档

文件：

- frontend/tests/desktop-slot-companion.spec.ts
- docs/testing/platform/desktop-slot-companion.testplan.yaml
- docs/README.md
- 与实际实现对应的正式架构或用户文档

步骤：

1. 只添加 Playwright E2E 和 YAML 测试计划，不添加单元测试。
2. 按 docs/testing/platform/desktop-slot-companion.testplan.yaml 逐条验证。
3. 真实桌面操作使用 computer-use，页面 DOM/CDP 证据使用 toolkit:playwright-cli。
4. 如需执行 pnpm dev:session、dev:status、dev:open 或 dev:stop，必须使用 toolkit:runweave-dev-session，并从 dev:open 的 desktop surface 获取 CDP endpoint。
5. 验收后停止 Dev Session，关闭本次新建 tab 并 detach，不影响用户已有窗口。
6. 将稳定架构和使用入口写入正式文档；计划文件继续保留为历史实施记录，不承担长期事实维护。

验证：

- pnpm typecheck。
- pnpm lint。
- pnpm testplan:validate docs/testing/platform/desktop-slot-companion.testplan.yaml。
- Playwright E2E 通过。
- pnpm dist:electron:mac 通过。
- 配套 required cases 全部具有真实桌面或 CDP 证据。

## 实施顺序与提交边界

依赖顺序固定为：

```text
原型与用例冻结
  → Shared 合约
  → Backend snapshot
  → Frontend Companion
  → Electron 窗口
  → 主窗口打开与退役
  → macOS 真实验收和文档
```

建议按以下提交边界实施：

1. shared + Backend Attention read model。
2. frontend Companion route、状态机和 UI。
3. Electron window、tray preference 和 IPC。
4. 主窗口 intent、退役闭环、E2E 与文档。

每个提交都必须能通过 typecheck 和 lint；最终桌面行为不能以静态原型或 Web 页面通过代替 Electron 验收。

## 风险与失败策略

| 风险                                              | 影响                                | 固定策略                                                                       |
| ------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------ |
| Completion event 在 Backend 重启后丢失 Panel 身份 | 无法精确回到完成来源 Panel          | 只跳 Session，绝不猜 activePanelId                                             |
| 主窗口 Connection 在点击期间变化                  | 可能打开错误 Backend 的同名 Session | intent 带 connectionId，主 renderer fail closed 并让 Companion 刷新            |
| Renderer 先退役、实际跳转或确认后失败             | 用户丢失提醒                        | 目标表面打开后先返回唯一 openSlot 结果；只由后续 snapshot 的确认 revision 退役 |
| Agent Team 轮询与 Terminal event 到达顺序不同     | 短暂状态闪烁                        | snapshot 一次投影，一 Session 一事实；迟到请求按 Connection/epoch 丢弃         |
| alwaysOnTop 与全屏在不同 macOS 版本有差异         | 窗口可见性不稳定                    | 首期打包态真实验收；不承诺外部全屏检测                                         |
| Companion 尺寸变大超出小屏 workArea               | 卡片被裁切或不可点                  | 主进程 clamp 尺寸，托盘内部滚动，不改变固定锚点                                |
| 已查看记录无限增长                                | localStorage 膨胀                   | 最多 500 条、30 天清理                                                         |
| 偏好文件损坏                                      | 窗口无法恢复                        | schema 校验失败回退 enabled=true，原子写入                                     |
| 直接遍历全部 Run 产生性能问题                     | 轮询放大 Backend 压力               | 先测真实规模；仅在 AttentionService 内增加短 TTL 缓存                          |

## 完成定义

以下条件全部满足才算首期完成：

- 产品只存在最终 Companion 方案，没有布局或方案切换器。
- 当前 Connection 的结构化 Terminal 与 Agent Team 事实可被投影为稳定、可解释的一 Slot 一状态。
- quiet、disconnected 和 checking 不混淆。
- 高优先级单卡、批量收起、新事实再提醒、重启再提醒符合冻结规则。
- 普通托盘被收起后，非高优先级更新不自动展开。
- Completion、失败事实与 Human Gate 分别使用正确的退役语义；Completion 的打开结果与异步确认/退役边界互不混淆。
- 点击 Slot 能恢复主窗口并打开正确 Session；Panel 失效只降级，不误跳。
- 窗口固定在主屏 workArea 右下角，不随鼠标或焦点移动，并在所有 Space 与全屏空间保持同一行为。
- 托盘开关默认启用、跨重启持久化，关闭时 Companion 不继续采集。
- 未认证与非法 IPC fail closed，不泄露 token、日志、scrollback 或路径。
- pnpm typecheck、pnpm lint、Playwright E2E、macOS 打包和配套 required testplan 全部通过。
