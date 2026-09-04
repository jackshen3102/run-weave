# Terminal Browser Automation 可视化实施计划

> 状态：产品链路已实现并完成关键真实桌面验证；全量 YAML 与 fresh-process 性能仍是发布门禁
> 粒度：L3（跨 CLI、shared、Electron CDP/IPC、renderer 与真实桌面性能验收）
> 代码基线：`main@383be140`
> 配套测试计划：`docs/testing/terminal/terminal-browser-automation-observability.testplan.yaml`

## 结论

在 Runweave Desktop 的 Terminal Sidecar 中增加常驻一级工具 `Automation`，按当前主窗口内的
`terminalSessionId` 汇总活跃浏览器自动化连接。页面展示所有 Tab 的标题、URL、favicon、状态等
元数据，但只为当前选中的一个 Tab 生产实时画面；观察面板严格只读，人工控制仍回到既有
`Browser 1/2/3`。

该模型参考 Playwright Dashboard 的信息架构和生命周期：Controller 同一时间只持有一个
`AttachedPage`，切换时释放旧页；侧栏只展示 Tab 元数据，主区域只有一个实时 `<img>`，frame 消费
使用显式 ACK。Runweave 不照搬它的 screencast 传输：真实 Electron 33 桌面验证发现，resolver 新建且
从未显示过的嵌套 `WebContentsView` 没有有效 compositor surface，`innerWidth/innerHeight` 为 `0x0`，
`Page.startScreencast` 不产帧，`capturePage()` 也返回空图。人工打开一次后能恢复，根因是挂载顺序和
surface 生命周期，而不是编码性能。

最终产品路径为 `10 路元数据 + 1 路 selected-only capturePage + 640px/5 FPS + renderer ACK`。
未挂载页面在 Automation 可见期间进入一个无额外 webContents 的 `BaseWindow` 合成宿主；必须先挂载
嵌套 View、再设置 bounds，并让宿主保持在主窗口之后。已挂载但尚未布局的 AI Tab 则在挂载后补齐
bounds。这样不向外部 Playwright/CDP 会话注入 screenshot 或 screencast 命令，也不争用客户端的
screencast 状态。画面只存在于 Electron/renderer 内存，不落盘、不进入 Activity、日志或遥测。

Playwright 参考：

- `packages/playwright-core/src/tools/dashboard/dashboardController.ts`：单一 `_attachedPage` 与切页释放。
- `packages/dashboard/src/dashboard.tsx`：Tab 侧栏为 favicon/标题/URL，主区域为单个 live frame。
- `packages/playwright-core/src/server/screencast.ts`：latest frame 与显式 ACK；只参考背压，不复用传输。

## 当前代码事实

| 领域            | 当前实现                                                                                  | 本计划的差异                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Browser surface | Electron `WebContentsView` 承载真实页面，renderer 只同步状态和 bounds                     | 复用真实页面作为画面源，不再创建第二个浏览器或 Chromium Dashboard                            |
| Profile         | `profile-1/2/3` 是应用级固定隔离环境，具有独立 partition 和 Whistle                       | 保持三 Profile 语义；一个 Terminal 在活跃连接期间只能绑定其中一个                            |
| Group           | `browserGroupId` 是 Profile 内 CDP target 可见性边界；缺省 group 的连接能看到整个 Profile | Terminal 默认解析为专属 Group，避免不同 Terminal 的页面串用；显式 `--group-id` 继续兼容      |
| Terminal 身份   | Backend 已向 PTY/tmux 注入 `RUNWEAVE_TERMINAL_SESSION_ID`                                 | CLI resolver 把该身份带给 Electron，并换成短期、内存态 attribution token 进入 WebSocket 握手 |
| CDP 连接        | 一个物理 loopback Proxy，最多 8 个连接；同 target 的 debugger attach 可复用               | 增加窗口级连接 registry，按 Terminal 合并 transport connection，并投影到 Automation snapshot |
| Tab 上限        | `Target.createTarget` 按整个窗口最多创建 10 个 AI Tab                                     | 元数据列表按最多 10 个设计；Tab 数量不等于并发画面流数量                                     |
| 活动提示        | `Input.*` 与部分 `Page.*` 命令只把 `mcpActivityUntil` 延长 4.5 秒                         | 增加经过脱敏的有限动作类型、指针坐标和 connection attribution；不保存动作历史                |
| 截图            | 批注使用 `webContents.capturePage()`；Playwright screenshot 经 CDP 与显示缩放兼容层处理   | 观察帧使用 selected-only `webContents.capturePage()`；单 in-flight + renderer ACK，不写磁盘  |
| Renderer bridge | `packages/shared/src/desktop-bridge.ts` 定义窄 IPC，`preload.ts` 实现                     | 新增 snapshot、可见性/选择请求、状态事件和二进制帧事件；frame bytes 不进入 snapshot          |
| Sidecar         | `Preview`、`Browser 1/2/3`、`Agent Team`、`Race` 共用宽度、展开和 active tool 状态        | Desktop 增加常驻 `Automation`；Web/PWA 不展示；不自动改变宽度或展开状态                      |
| 持久化          | Browser workspace schema v3 保存 Profile 内 Group/Tab；连接、活动和错误不落盘             | Automation 连接、帧、选择、固定查看和动作继续全部只存在内存；断开后 UI 立即删除              |

关键现状入口：

- `docs/architecture/terminal-code-preview.md`
- `backend/src/terminal/runtime/environment.ts`
- `backend/src/terminal/tmux/process.ts`
- `packages/runweave-cli/src/commands/browser.ts`
- `packages/shared/src/terminal-browser-profile.ts`
- `packages/shared/src/desktop-bridge.ts`
- `electron/src/terminal-browser-cdp-proxy.ts`
- `electron/src/terminal-browser-cdp-proxy-types.ts`
- `electron/src/terminal-browser-cdp-proxy-session.ts`
- `electron/src/terminal-browser-cdp-activity.ts`
- `electron/src/terminal-browser-runtime.ts`
- `electron/src/terminal-browser-workspace.ts`
- `electron/src/terminal-browser-annotation.ts`
- `electron/src/preload.ts`
- `frontend/src/features/terminal/preview-store-types.ts`
- `frontend/src/features/terminal/preview-store.ts`
- `frontend/src/components/terminal/preview/panel-shell.tsx`
- `frontend/src/components/terminal/browser/tool.tsx`

## 目标

1. 用户可在一个 Desktop Sidecar 页面中看见当前窗口所有活跃浏览器自动化，以及每个 Terminal
   正在控制的唯一 Profile、Group 和 Tab。
2. 所有受控 Tab 都提供元数据；仅一个选中 Tab 提供足以看懂点击、输入、滚动和导航的实时画面。
3. 默认跟随最近发生用户可感知动作的 Tab；用户手动选择后固定，显式恢复后才继续自动跟随。
4. 观察页面只读；从 Automation 发出的唯一跨工具动作是“在 Browser 中打开”。
5. Agent 光标和点击反馈与实际 CSS viewport 坐标一致；键盘只投影“正在输入”，不暴露按键和文本。
6. Terminal 默认获得专属 Browser Group；不同 Terminal 即使使用同一 Profile，也不能看到彼此的 target。
7. 一个 Terminal 有活跃连接时只能绑定一个 Profile；全部连接断开后可以改用另一个 Profile。
8. 画面只在 Automation 对当前 BrowserWindow 可见时产生；切走、收起、隐藏、销毁或断开都及时清理。
9. 10 Tab 最坏规模始终只有一个画面 producer，并满足 FPS、延迟、CPU、RSS 和自动化无干扰硬门槛。

## 非目标

- 不嵌入、vendor 或启动官方 Playwright Dashboard，不新增“打开 Dashboard”产品按钮。
- 不增加人工接管、暂停 Agent、从 Automation 导航/输入、远程控制或 ownership lock。
- 不增加动作历史、Trace Viewer、录屏、自动截图、Activity 投影或持久化审计。
- 不声称识别具体 Codex/Claude run、thread、panel 或 Agent Team worker；可信操作者粒度仅到 Terminal。
- 不跨 Runweave 实例、远程机器或独立 App Server 聚合；第一版只支持当前 macOS Desktop 主窗口。
- 不在 Web/PWA/App Server surface 中转发 Desktop 画面。
- 不改变 Profile 的 Cookie、Cache、LocalStorage、IndexedDB、Whistle、Header 或证书隔离语义。
- 不把 Group 升级为 Profile 或账号隔离；Group 仍只是 Profile 内 CDP 控制边界。
- 不自动关闭 Terminal 断开后的 Group 或 Tab，不删除用户页面和页面状态。
- 不增加全页截图、Retina 2 倍帧、30/60 FPS 视频或音频传输。
- 不为未选中 Tab 生成缩略图、截图或后台 screencast。
- 不持久化 Automation 选择、固定查看、连接、帧、指针或动作提示。
- 不新增单元测试或历史 spec；使用 YAML 合同、静态门禁、真实桌面验收和独立发布性能实验。
- 不同时解决多 Electron BrowserWindow 的 Terminal 归属；保持现有 Proxy 选择主窗口的边界。

## 用户可见行为

### 1. 入口与自动打开

1. Desktop Sidecar 工具顺序为 `Preview`、`Automation`、`Browser 1/2/3`、现有条件工具；
   `Automation` 常驻，Web/PWA 不渲染该入口。
2. 没有活跃连接时只显示“当前没有浏览器自动化”，不显示历史 Terminal、旧画面或旧动作。
3. Sidecar 关闭时，第一个活跃自动化连接自动打开 Sidecar 并选中 Automation。
4. 用户正在查看其它 Sidecar 工具时不抢焦点，只更新 Automation 入口徽标和动态提示。
5. 用户在当前连接周期主动关闭 Sidecar 后，同周期新增或重连不再自动打开；活跃连接全部归零后，
   下一周期重新允许一次自动打开。
6. 打开 Automation 不改变当前 Sidecar 宽度或展开状态，继续使用现有 resize/expand 持久化逻辑。

### 2. Terminal、Profile、Group 与 Tab

1. 第一层是 Terminal 卡片；同一 `terminalSessionId` 的多个 transport connection 合并到一张卡片。
2. 卡片标题优先使用现有 Terminal alias，缺失时使用可识别的短 session id；Electron snapshot 只传
   `terminalSessionId`，alias 由 renderer 与现有 Terminal session list 关联，不复制 Backend 数据。
3. Terminal 卡片只能同时出现一个 Profile；请求第二 Profile 返回明确冲突，不能暗中切换或合并。
4. 未显式传 `--group-id` 时，resolver 从 `terminalSessionId` 派生稳定、不含原始 ID 的 Group id，
   并确保该 Group 至少存在一个 `about:blank` Tab；同一 Terminal 重连复用该 Group。
5. 新 Terminal 获得新 Group；Terminal 断开不删除 Group/Tab；在 Browser 中显式关闭后才销毁。
6. Automation 只显示当前存在连接的 Group；连接存在时展示该 Group 全部 Tab，包括还没有动作的 Tab。
7. 同一 target 在 Tab 元数据列表中只出现一次。兼容性路径若多个显式 scoped connection 指向同一
   Group，卡片可以共同引用该 target，但不能重复启动画面 producer 或伪造唯一 owner。
8. 不带有效 attribution token 的 loopback CDP connection 显示为“未归属自动化”警告卡片；
   客户端自报名称不作为可信身份。
9. 最后一个连接断开后，Terminal/未归属卡片、画面和动作立即消失；没有“最近断开”区域。

### 3. Tab 列表与主画面

1. 所有受控 Tab 只显示 title、URL、favicon、loading、动作和连接归属等元数据；未选中 Tab 不采帧。
2. 选中 Tab 显示最长边不超过 640px 的主画面，连续变化时目标 5 FPS。显示区域小于 640px 时按实际
   CSS 尺寸请求，不为 Retina 或隐藏区域超采样。
3. 画面保持实际 viewport 宽高比并 letterbox，不裁剪、不变形、不全页拼接、不传 Retina 2 倍像素。
4. Sidecar 尺寸变化时仅在尺寸档位变化后重启选中页流并请求匹配区域的 fresh frame，不能拉伸旧帧。
5. 默认 follow 最近发生点击、输入、滚动、导航或 reload 的 target；只读 discovery、DOM 查询、
   网络初始化和单纯 mouse move 不触发主画面切换。
6. 用户选择任意 Tab 元数据项后进入 pinned 状态；其他 target 的动作不抢走画面，直到点击“恢复跟随”。
7. capture 第一次失败即在最后一帧上覆盖“画面中断”和时间；旧帧最多保留 2 秒，随后撤销并显示
   明确错误。恢复后只用更大 sequence 的 fresh frame 清除错误。

### 4. 只读与跨工具跳转

1. Tab 列表和主画面不转发 pointer、keyboard、wheel、drag、navigation 或 clipboard 事件给页面。
2. 点击 Tab 列表项只选择/固定画面；主画面容器不能成为页面 input target。
3. “在 Browser 中打开”调用 renderer 的受控跳转：切换到目标 Profile，等 workspace snapshot
   就绪后选中同一 tab id；不能创建新 Tab、复制 WebContentsView 或改变 URL。
4. 人工操作继续只发生在 Browser 1/2/3；返回 Automation 后看到新帧，但人工输入不冒充 Agent 动作。

### 5. 指针和动作提示

1. `Input.dispatchMouseEvent` 只投影逻辑 CSS 坐标和鼠标事件类型；显示 Agent cursor，click 显示
   短暂圆环。坐标必须经过 viewport、Device、displayScale、minimum width 和宿主横向偏移模型验证。
2. `Input.dispatchKeyEvent`、`Input.insertText` 等只投影 action kind `input`，立即丢弃 key、code、text、
   unmodifiedText、commands、clipboard 和 composition 数据。
3. 动作枚举固定为 `idle | click | input | scroll | navigate | reload`；无法安全分类的命令只沿用
   现有通用 activity pulse，不进入可视化动作标签。
4. 动作标签使用现有 4.5 秒窗口后回到 idle；click ring 使用更短的纯 UI 动画，不写入历史。
5. connection、action、pointer 和 frame event 都带单调 sequence/revision；renderer 丢弃旧事件，
   不能让迟到帧覆盖新 target 或已断开状态。

### 6. 资源、隐私和降级

1. renderer 只有在 Automation 对当前 BrowserWindow 可见时，才提交 `visible: true`；切到其它工具、
   收起 Sidecar、窗口 hide/destroy 都提交或触发等价 cleanup。
2. 不可见后 1 秒内停止全部 capture、resize/encode 和 frame IPC；连接/动作轻量状态仍可更新入口徽标。
3. frame bytes 只通过 Electron structured-clone 二进制 payload 传递；禁止 base64/data URL 进入状态、
   日志或持久化。renderer 使用单个 `<img>` 与 Blob URL；新帧 load 后 revoke 旧 URL，隐藏、断开和
   卸载时立即 revoke 当前 URL。
4. renderer 只有在一帧成功 load 或明确失败后才 ACK；Electron 在 ACK 前不采集、不编码也不发送
   下一帧，不保留 pending frame。固定 5 FPS、最长边 640px 和单 in-flight 共同形成资源上界；
   观察能力永远不能阻塞 CDP command relay、Browser 页面或 renderer 主交互。
5. 不在错误、日志或 telemetry 中打印 frame bytes、完整 endpoint、attribution token、输入参数或页面文本。

## 状态所有权与协议

### 1. Resolver 与 Terminal attribution

扩展 `packages/shared/src/terminal-browser-profile.ts`，保持旧调用兼容：

```ts
interface ResolveTerminalBrowserProfileRequest {
  projectId: string | null;
  explicitProfileId: TerminalBrowserProfileId | null;
  browserGroupId: string | null;
  terminalSessionId?: string | null;
}

interface ResolvedTerminalBrowserProfile {
  // 既有字段保持不变
  browserGroupId?: string | null;
  automationAttribution?: "terminal" | "unattributed";
}
```

- `rw browser profile resolve` 从 `RUNWEAVE_TERMINAL_SESSION_ID` 读取身份并放入 request；`--group-id`
  仍优先于默认 Group。
- Electron resolver 校验 Terminal ID 长度/空白/control character，不信任客户端提供的显示名称。
- 对可信 request，Electron 创建 5 分钟内可用于首次 WebSocket upgrade 的随机 attribution token；
  token 只存在内存，绑定 `terminalSessionId + profileId + groupId`，使用一次建立连接后即可释放。
- `cdpEndpoint` 携带 opaque token；Proxy upgrade 解析 token 后得到 actor。缺失、过期或非法 token
  不获得 Terminal 身份，只能成为 `unattributed`。
- attribution token 只证明 UI 归属，不扩大 CDP 权限；真实 target 权限仍由 `profileId + groupId`
  fail-closed 过滤。

### 2. Profile 绑定状态机

```text
unbound
  └─ first attributed connection(profile A) → bound(profile A, connectionCount=1)
       ├─ same Terminal + profile A → connectionCount + 1
       ├─ same Terminal + profile B → reject AUTOMATION_PROFILE_CONFLICT
       ├─ disconnect while count > 1 → connectionCount - 1
       └─ last disconnect → unbound，Automation 卡片立即删除
```

- resolver 可做快速冲突检查，但 WebSocket upgrade 必须再次原子校验；并发解析不同 Profile 时
  第一个成功 upgrade 的连接获胜，另一个得到明确冲突。
- 新错误码加入 `TerminalBrowserErrorCode`，CLI 映射为既有 conflict 退出码 `4`，stderr 给出 Terminal
  当前 Profile 和请求 Profile；JSON stdout 不被诊断信息污染。
- 同一 Terminal、同一 Profile 的多个 connection 允许存在并合并展示；connection 本身不是产品卡片。

### 3. Automation snapshot

新增 `packages/shared/src/terminal-browser-automation.ts` 并在 package exports 暴露明确子路径：

```ts
type TerminalBrowserAutomationActor =
  | { kind: "terminal"; terminalSessionId: string }
  | { kind: "unattributed"; connectionId: string };

type TerminalBrowserAutomationActionKind =
  | "idle"
  | "click"
  | "input"
  | "scroll"
  | "navigate"
  | "reload";

interface TerminalBrowserAutomationConnectionSnapshot {
  connectionId: string;
  actor: TerminalBrowserAutomationActor;
  profileId: TerminalBrowserProfileId;
  browserGroupId: string | null;
  connectedAt: number;
  attachedTargetIds: string[];
}

interface TerminalBrowserAutomationTargetSnapshot {
  targetId: string;
  tabId: string;
  profileId: TerminalBrowserProfileId;
  browserGroupId: string;
  title: string;
  url: string;
  loading: boolean;
  actorKeys: string[];
  action: TerminalBrowserAutomationActionKind;
  actionUntil: number | null;
  pointer: { x: number; y: number } | null;
}

interface TerminalBrowserAutomationSnapshot {
  revision: number;
  connections: TerminalBrowserAutomationConnectionSnapshot[];
  targets: TerminalBrowserAutomationTargetSnapshot[];
}
```

精确字段名可按现有命名风格调整，但必须保留这些语义：actor 使用 discriminated union、target
只引用 live tab、同 target 可引用多个 actor、连接/动作与 Browser workspace 分离、snapshot 不含帧。

### 4. IPC 与 frame event

在 `RunweaveElectronBridge` 增加窗口级窄合同：

```ts
terminalBrowserAutomationGetSnapshot(): Promise<TerminalBrowserAutomationSnapshot>;
terminalBrowserAutomationSetViewState(request: {
  visible: boolean;
  selectedTargetId: string | null;
  mainMaxEdge: number;
}): Promise<void>;
terminalBrowserAutomationAcknowledgeFrame(request: {
  targetId: string;
  sequence: number;
}): Promise<void>;
onTerminalBrowserAutomationStateChanged(listener): () => void;
onTerminalBrowserAutomationFrame(listener): () => void;
```

frame event 包含 `targetId`、`sequence`、`capturedAt`、`width`、`height`、`mimeType`
和 `Uint8Array bytes`。Electron 必须根据 `event.sender` 解析 BrowserWindow，只允许请求该窗口 snapshot
中的 target；不接收任意 URL、任意 target id 列表或文件路径。`visible: false`、sender destroyed、
connection removed 和 target destroyed 都走同一个幂等 stop/cleanup。`mainMaxEdge` 在 Electron 侧钳制为
`1..640`；renderer 只有在 `<img>` 完成 load 或明确失败后才 ACK。ACK 之前 Electron 不开始下一次
capture，不能形成无界 IPC 队列。

Browser owner 不能从 `BrowserWindow.getAllWindows()[0]` 推断。Desktop Companion 可能先出现在该数组，
导致 resolver、target 与 Automation connection 全部注册到 Companion，而 Terminal 主窗口看到空 snapshot。
resolver、connection fallback 与 `Target.createTarget` 统一以 `desktopRuntime.mainWindow` 为权威 owner；辅助
窗口不承载 Browser workspace 或 Automation registry。

## Phase 0：技术 Spike 硬门禁

### 根因与结论

最初的 Phase 0 只在已具有非零 viewport 的页面上比较过 capture/screencast 性能，没有覆盖产品最
关键的“resolver 创建、从未人工打开”的页面，因此不能决定产品采集 API。真实桌面反例把根因收敛为：

1. 新建 `WebContentsView` 嵌套在 `viewportView` 中，但尚未挂入任何窗口时，renderer viewport 是 `0x0`。
2. 在挂载前调用 `setBounds()` 不会在后续自动传播 resize；挂载后必须再次设置父子 View bounds。
3. hidden/unattached surface 的 screencast 无事件，`capturePage()` 返回空图；使用可合成的临时
   `BaseWindow`，并严格按先挂载后布局，fresh 页面立即变为 `1280x720` 并可稳定采帧。
4. 已在 Browser 工具挂载过的页面无需第二宿主；Automation 隐藏原 View 后可直接 `capturePage()`。

旧 benchmark 的 `passed: false` 仍揭示 RSS 测量设计把 Chromium working set、renderer 自然增长与
GC 顺序效应混入增量；同时它测的是 screencast 候选，不能作为当前产品 capturePage 路径的性能结论。
实现不再被该旧报告阻塞，但发布前必须用当前产品路径重跑 fresh-process A/B：

| 实验                                                    | 结果     | 根因/结论                                                                                                                  |
| ------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| 10 Tab：1 路主画面 + 9 路缩略图                         | 否决     | 10 个 inactive `WebContentsView` 的 bounds 为 `0x0`；并发画面与真实 Sidecar 布局不一致，也不是 Playwright Dashboard 的架构 |
| 未挂载/0×0 View 上的 `capturePage()`                    | 否决     | 返回空图；根因是没有有效 compositor surface，不是 API 本身不可用                                                           |
| selected-only `Page.captureScreenshot`                  | 否决     | 与自动化共享 debugger 命令队列，画面采集直接增加命令竞争和超时                                                             |
| `beginFrameSubscription`                                | 否决     | 主线程像素 readback 干扰自动化，资源隔离不成立                                                                             |
| `Page.startScreencast`                                  | 否决     | fresh hidden/unattached Electron View 不产帧，且会与外部客户端共享同一个页面级 screencast 状态                             |
| 挂载后布局 + selected-only `capturePage()`，640px/5 FPS | 功能可行 | fresh 页面真实收到约 4.9 FPS、640×360 帧；单 `<img>`、切走停止、恢复、指针与 Browser reveal 已通过真实桌面验证             |
| 同进程交替测量 RSS                                      | 无法判定 | Desktop renderer/Chromium working set 与 GC 顺序效应远大于画面信号，前后段 RSS growth 会正负翻转                           |

原 canvas fixture 还存在每帧重设 `canvas.width/height` 的问题，会反复分配 backing store；Electron 33
中的 `HTMLImageElement.decode()` 也观察到在 `load` 已完成、`complete/naturalWidth` 有效时仍不 resolve。
因此 renderer 固定使用 `<img>` 的 `load/error` 作为 ACK，不把 `decode()` 或每帧 canvas readback 放入
产品链路。

### 收敛后的 adapter

- Electron 同时最多管理一个选中 target 的 capturePage producer；切换 target 必须先停止旧流、清 generation，
  再启动新流，行为与 Playwright Dashboard 的单一 `_attachedPage` 一致。
- producer 只调用目标 `webContents.capturePage()`，最多 5 FPS、最长边 640px、单 in-flight；不通过
  shared debugger 发内部 CDP 命令，因此不需要仲裁或改写外部客户端 screencast。
- renderer ACK 控制下一次 Electron→renderer frame；等待 ACK 时不继续 encode/IPC，切换和隐藏以
  generation 丢弃迟到结果。
- fresh 未挂载页面使用 focus-free `BaseWindow` 合成宿主，宿主位于 owner 后方且跟随 owner bounds；
  释放时先移除 View 再销毁宿主。已挂载页面只补齐 bounds，不创建宿主。
- 10 个 Tab 都在 snapshot 中提供元数据；未选中 Tab 的 renderer、compositor 和 CDP 不承担观察采集。

### 文件

- 新建 `electron/src/terminal-browser-automation-capture.ts`：最小 frame producer 接口与完整 cleanup。
- 不保留旧的 screencast benchmark bridge 和脚本；它绕过正式 Automation surface，会制造一条无法
  代表产品的第二采集路径。
- 发布性能 harness 必须只通过正式 snapshot/view/frame/ACK 合同驱动 Automation，并在 Dev Session
  外围采样进程指标；不能向生产 preload 增加 benchmark-only capture API。

### 固定测量合同

```json
{
  "schemaVersion": 2,
  "tabs": 10,
  "tabMetadataCount": 10,
  "captureStrategy": "webcontents-capture-page-selected-only",
  "rendererStrategy": "image",
  "requestedFps": 5,
  "requestedMaxEdge": 640,
  "selectedFps": 0,
  "selectedActionToFrameP95Ms": 0,
  "selectedMaxFrameGapMs": 0,
  "switchToFirstFrameP95Ms": 0,
  "incrementalCpuSingleCorePct": 0,
  "incrementalRssMb": 0,
  "automationLatencyRegressionPct": 0,
  "automationFailureCount": 0,
  "captureStoppedWithinMs": 0,
  "hiddenIncrementalCpuSingleCorePct": 0,
  "bufferCountAfterCleanup": 0,
  "passed": false
}
```

当前仓库没有可代表产品路径的权威性能命令。发布前需补一个外围 harness，输出上述 schema 并驱动
正式 Automation UI；在该 harness 和 fresh-process A/B 证据落地前，性能 verdict 固定为未验证。

执行前必须用 `$toolkit:runweave-dev-session` 启动隔离 Session，并用其 `dev:open` 结果取得 fresh
desktop/browser endpoint；不能使用 ambient `9224` 或 Stable 用户数据。10 个页面必须属于同一
`browserContextId`/Group，只有 selected 页设置可见 viewport。页面操作和帧内容用
`$toolkit:playwright-cli` 验证，Desktop 工具切换用 `$computer-use`，测量时目标 Electron 窗口必须
真实可见且前台，不能在 DevTools/Terminal 获得焦点后把暂停的 `requestAnimationFrame` 当作产品性能。

CPU、画面和自动化数据可在同一 fresh 进程内做 counterbalanced AB/BA/AB 三轮。RSS 不再使用同进程
连续区段的斜率相减：需要至少三组 fresh Desktop 进程，每组使用相同 warmup、相同 10 Tab fixture 和
相同采样时长，A 进程始终不开画面，B 进程始终开启画面；按进程角色比较 steady-state RSS 中位数，
并保留每个 PID 的原始样本。A/B 启动顺序交替；任一进程混入额外窗口、DevTools、fixture 失败或 GC
干预则整组作废。只有三组配对增量都不超过 100MB，RSS 才通过。

### 通过线

| 指标                         |                   硬门槛 |
| ---------------------------- | -----------------------: |
| 主画面连续变化帧率           | `>= requested FPS x 90%` |
| 页面变化到 renderer 展示 P95 |               `<= 500ms` |
| 最大连续帧间隔               |                  `<= 1s` |
| 十 Tab 切换到首帧 P95        |                  `<= 2s` |
| 增量 CPU                     |            `<= 单核 15%` |
| fresh-process 配对增量 RSS   |      三组分别 `<= 100MB` |
| Playwright 操作延迟劣化      |                 `<= 10%` |
| 新增自动化失败/超时          |                      `0` |
| 切走后的采集停止             |                  `<= 1s` |
| 隐藏稳定态增量 CPU           |              `< 单核 1%` |
| cleanup 后 frame buffer      |                      `0` |

三轮性能与三组独立 RSS 都满足才把 `passed` 设为 `true`。报告缺字段、只有平均值没有 P95、fixture
本身不稳定、测试期间发生额外页面失败或 cleanup 不完整，都判定发布性能门禁失败；这类失败不再
阻止 UI 与协议实现，但禁止宣称性能验收通过或进入发布。

历史 `artifacts/terminal-browser-automation-spike/report.json` 的 screencast 非 RSS 结果为：5 FPS、action-to-frame
P95 467ms、最大帧间隔 643ms、CPU +2.01%、自动化延迟中位数 -6.33%/-11.67ms、失败 0、停止 478ms、
隐藏增量 CPU 0、cleanup buffer 0、10/10 切换成功且首帧 P95 1200ms。RSS 三轮归因值为
784.4MB、0MB、471.9MB；对应基线/观察 RSS growth 的方向发生翻转，证明现有同进程归因无效，不能
据此断言真实增量，也不能把报告改为通过；这些数值也不能替代 capturePage 产品链路的发布性能验收。

## Phase 1：实施任务

### Task 1：落地 shared 合同与兼容字段

- [x] 新建 `packages/shared/src/terminal-browser-automation.ts`，定义 actor、connection、target、action、
      snapshot、view request、state event 和 frame event。
- [x] 更新 `packages/shared/package.json` exports 和 `packages/shared/src/desktop-bridge.ts`；frame bytes
      只属于 event，不进入可序列化 snapshot。
- [x] 扩展 `packages/shared/src/terminal-browser-profile.ts` 的 resolver request/response 和 conflict
      error code；新字段采用 optional/nullable 兼容旧 Desktop/CLI。
- [x] 用 `rg` 检查所有 request 构造方；renderer 的人工 Profile resolve 不提供 Terminal 身份，
      不能意外创建 Terminal Group。

验证：

```bash
pnpm --filter @runweave/shared typecheck
pnpm architecture:check
```

失败判断：任一消费者复制近似 DTO、frontend 导入 Electron 模块、frame bytes 进入普通 Zustand 状态，
或旧 resolver response 无法解析。

### Task 2：让 CLI resolver 建立可信 Terminal scope

- [x] 更新 `packages/runweave-cli/src/commands/browser.ts`：读取 `RUNWEAVE_TERMINAL_SESSION_ID`，保留
      显式 `--profile` / `--group-id` 优先级，把 terminal identity 传给本地 resolver。
- [x] 更新 Electron resolver：归一化 Terminal ID；未显式 group 时服务端派生不可逆短 Group id，
      restore/materialize Profile 后确保该 Group 和一个初始 Tab 存在。
- [x] attribution token 用 `crypto.randomUUID()` 生成、只存内存、绑定 Terminal/Profile/Group、5 分钟
      首次 upgrade TTL；token 不写日志、workspace 或 Activity。
- [x] 更新 endpoint 构造和 Proxy upgrade，token 成功消费后把 actor 写入 connection registry；缺失或非法
      token 进入 unattributed，不信任 query 中的显示名称。
- [x] 保持 `--json` stdout 机器可读和现有退出码；更新 `docs/cli/browser-profile.md`。现有 Playwright
      skill 已经通过 resolver 取 endpoint 并按 Terminal 命名 session，无需增加 Dashboard 路径。

验证：

```bash
pnpm --filter @runweave/cli typecheck
pnpm --filter @runweave/cli lint
pnpm cli:build
```

真实协议检查：从两个 Terminal 同时解析 Browser 1，确认 endpoint 的 Group 不同；显式
`--group-id` 仍返回请求的 Group；不带 Terminal 身份的 raw endpoint 仍可连接但被标为 unattributed。

### Task 3：实现 connection registry 与 Profile 绑定状态机

- [x] 在 CDP connection state 增加 opaque connection id；actor、connectedAt 和 window scope 只进入
      Automation registry，不记录输入参数。
- [x] 新建 `electron/src/terminal-browser-automation-runtime.ts`，以 BrowserWindow 为 snapshot/订阅边界，
      以 `terminalSessionId` 合并连接，以 target id 去重帧源。
- [x] 在 resolver 和 WebSocket upgrade 两处检查 Terminal/Profile 绑定，upgrade 使用同步临界区作为
      最终事实源；第一个连接建立绑定，最后一个连接 cleanup 时释放。
- [x] 将 `CdpSessionManager` 的 attach/detach、target destroyed 和 connection close 事件投影进 registry；
      所有 cleanup 幂等，不能让一个连接断开清掉另一个连接的 shared debugger attachment。
- [x] Group/Tab workspace 更新后重算 active scope；连接存在时显示该 Group 全部 live Tab，断开后立即
      删除 actor 投影，但不调用 Browser Group/Tab close。
- [x] 多个 actor 显式指向同一 Group 时 target 只保留一个 capture source，snapshot 的 `actorKeys`
      表达多引用。

验证：用 raw CDP 同时覆盖同 Terminal 多连接、两个 Terminal 同 Profile、同 Terminal 跨 Profile 冲突、
unattributed 和乱序 disconnect；对照 TBAO-005～010。

### Task 4：投影脱敏动作与指针

- [x] 在 Automation runtime 增加独立有限 action classifier；只读取 method 和鼠标数值坐标，不复制任意
      params，不改变既有 Browser activity classifier。
- [x] 在 `electron/src/terminal-browser-cdp-proxy-session.ts` command relay 成功进入目标 session 时更新
      actor/target activity；失败命令不能显示为已完成动作。
- [x] click、scroll、navigate、reload 和 input 使用固定枚举；mouse move 只更新 cursor，不触发 follow；
      discovery、enable、只读查询不产生动作。
- [x] 在 action event 构造点立即丢弃 key/text/clipboard/composition；诊断日志只允许 method、targetId、
      actor kind 和时间，不允许完整 params。
- [x] 复用现有 displayScale/device/minimum-width 坐标模型，记录 CSS logical pointer；实际画面映射由
      capture metadata 和 renderer 共同完成，Spike/验收必须覆盖 TBAO-014、019。

### Task 5：实现可见性驱动的 frame producer

- [x] `TerminalBrowserAutomationCapture` adapter 进入产品；全窗口
      同时最多一个 selected target producer，迟到结果按 generation/sequence 丢弃。
- [x] selected target 使用 `webContents.capturePage()`；应用层最多 5 FPS、最长边 640px、单 in-flight。
      未选中 target 只有 snapshot 元数据，不创建 timer、capture、encode 或 frame IPC。
- [x] fresh 未挂载 target 进入临时 `BaseWindow` 合成宿主并严格先挂载后布局；已挂载 0×0 target 在
      挂载后补齐 bounds。离开 Automation 时移除宿主且不销毁页面。
- [x] renderer 每成功 load/失败一帧后发送 ACK；Electron 等待 ACK 时不继续采集或向 renderer 排队。
      产品 producer 不发送内部 screencast/screenshot CDP 命令，不篡改外部客户端订阅。
- [x] 按 BrowserWindow visibility、Automation view request 和 target lifecycle 启停；stop 会取消 timer、
      忽略 in-flight completion、清 digest/bytes，并发送 target frame unavailable 状态。
- [x] capture 连续失败时保留最后一帧最多 2 秒；恢复必须用新 sequence，不能复用其它 target 的帧。
- [x] 资源上界固定为单 selected、单 in-flight、无 pending、5 FPS/640px；失败只更新画面错误并按
      有界 cadence 重试，不引入后台 Tab 缩略图或第二条 CDP command 队列。

### Task 6：增加窄 IPC 与 preload bridge

- [x] 在 `electron/src/terminal-browser-automation-runtime.ts` 内注册 get snapshot、set view state 和事件
      分发；由 `event.sender` 解析 BrowserWindow 并校验 selected target 属于该窗口 active scope。
- [x] 在 `electron/src/main.ts`/现有 Terminal Browser 注册入口装配 handlers，应用退出、窗口关闭和
      renderer reload 都调用统一 cleanup。
- [x] 更新 `electron/src/preload.ts` 和 bridge 类型；事件 unsubscribe 必须真实移除 listener。
- [x] frame 使用 `Uint8Array` structured clone；禁止字符串化、data URL、文件路径或对象 URL 穿过 preload。
- [x] 增加 frame ACK handler；校验 sender、targetId 和 sequence，只接受当前 target 的 awaiting frame，
      重复或迟到 ACK 幂等忽略。
- [x] snapshot 只返回活跃 connection/target 元数据；`visible: false` 后任何 get snapshot 都不能返回旧帧。

验证：

```bash
pnpm --filter @runweave/electron typecheck
pnpm --filter @runweave/electron lint
```

### Task 7：实现 Desktop Automation Sidecar

- [x] 在 preview store 增加 `automation` tool 和 `openAutomation`，沿用现有宽度/展开状态；reveal 复用
      `terminalBrowserShow` 与既有 `activateBrowser`，不增加第二套 Tab 状态。
- [x] 从始终挂载的 `frontend/src/components/terminal/workspace/stage.tsx` 订阅轻量 connection state；
      Sidecar 关闭时 auto-open 不依赖 Automation tool component。
- [x] 新建 `frontend/src/components/terminal/automation/tool.tsx`：Terminal 卡片、Tab 元数据列表、
      单个 main preview、pointer/action overlay、empty/error/degraded state。稳定回调使用 `useMemoizedFn`。
- [x] stage 只订阅无帧 snapshot/revision；实际 tool 只在 Sidecar 已挂载时订阅 frame，且仅在
      active tool 与窗口都可见时提交 `visible: true`。Blob URL cleanup 跟随同一 visibility generation。
- [x] Terminal alias 通过现有 session query 关联；找不到 session 时显示短 ID，不能向 Electron
      回写 alias 或创建新 Backend API。
- [x] `panel-shell.tsx` 在 Desktop available tools 中加入 Automation 和活跃 Terminal 数量徽标；Web/PWA
      不渲染。frame 区域只用一个 `<img>` + Blob URL 呈现，不注册页面控制事件；以 `load/error` 触发
      ACK 和 Blob URL 交接，不调用 `HTMLImageElement.decode()`，不在每帧重建 canvas backing store。
- [x] 实现 auto-open epoch：Sidecar 关闭时 0→1 自动打开；其它工具 active 时只提示；用户主动关闭后
      在连接数回到 0 前 suppress；下一次 0→1 恢复。
- [x] 实现 follow/pin 状态机和 monotonic frame acceptance；手动选中只影响唯一主画面，Tab 元数据
      继续由 snapshot 更新。
- [x] 实现“在 Browser 中打开”：先停止 capture surface，再调用主进程 reveal 同一 tab 并切换到所属
      Profile；不新建 Tab。
- [x] Automation 隐藏、组件卸载、target/actor 删除时 revoke 全部 owned Blob URL，清除 2 秒 stale timer、
      click animation 和 pointer state。

验证：

```bash
pnpm --filter @runweave/frontend typecheck
pnpm --filter @runweave/frontend lint
```

### Task 8：更新当前架构与操作文档

- [x] 更新 `docs/architecture/terminal-code-preview.md`：Terminal attribution、默认 Group、Profile lock、
      Automation read-only UI、frame lifecycle、隐私和 Desktop-only 边界。
- [x] 更新 `docs/cli/browser-profile.md`：默认 Terminal Group、显式 group 优先级、新 JSON 字段、旧 Desktop
      降级和 conflict 退出码。
- [x] Playwright skill 现有流程继续先 resolver、复用确定性 CLI session 并 detach；无需增加 Dashboard
      或改写仓库外安装的 skill。
- [x] 文档明确区分 connection、瞬时动作、实时画面、用户截图、录屏和 Trace；不把静态门禁写成桌面验收。

## 兼容、迁移与回滚

1. `terminal-browser-tabs.json` schema 不升级。Terminal 派生 Group 继续使用现有 group/tab 持久化结构；
   Automation actor、token、frame、selection 和 action 不进入文件。
2. 旧 CLI 不带 Terminal 身份时仍能连接，但显示为 unattributed；新 CLI 连接旧 Desktop 时保留既有
   resolver warning，不声称已经获得 Terminal Group 隔离。
3. 显式 `--group-id` 保持优先，避免破坏已有 scoped automation；多 actor 同 Group 只影响观察标签，
   不改变现有 CDP 权限和 shared debugger 语义。
4. Browser 1/2/3、DevTools、Device、Zoom、Minimum Width、Header、Whistle、批注、人工关闭和
   Playwright screenshot 行为必须保持。
5. 产品回滚只需移除 Automation renderer 入口并停止 frame handler；CDP 新 optional 字段对旧消费者
   无害。若回滚 Terminal 默认 Group，不能删除已生成的 Group/Tab 或清用户数据。
6. 历史 screencast Spike 不再作为产品实现前置门禁，也不保留会绕过产品链路的 dev-only capture
   bridge。发布前必须由外围 harness 对正式 capturePage 链路跑完性能门禁。

## 错误处理

| 场景                                | 行为                                                                                      |
| ----------------------------------- | ----------------------------------------------------------------------------------------- |
| Terminal ID 非法                    | resolver 参数错误，CLI 退出码 2，不建立 token/Group                                       |
| 同 Terminal 请求第二 Profile        | `AUTOMATION_PROFILE_CONFLICT`，CLI 退出码 4，既有连接不受影响                             |
| attribution token 缺失/过期/伪造    | 连接不获得 Terminal 身份，显示 unattributed，不接受自报名称                               |
| Terminal Group 被用户关闭           | 现有 target 发 destroyed；同 Terminal 下次 resolve 重建同 id 的空 Group，不能恢复已删页面 |
| selected target 已销毁              | 清主画面并按 follow 规则选择剩余最近 active target；没有 target 时显示 Group 空状态       |
| selected stream capture/encode 失败 | 标 stale，2 秒后清图；保持 5 FPS 上限重试且不阻塞 snapshot 更新或 CDP relay               |
| renderer/frame listener 消失        | Electron 视为不可见并 cleanup，不积压 frame queue                                         |
| 迟到 frame/action                   | sequence/revision 小于当前 generation 时丢弃                                              |
| CPU/queue 过载                      | 单 selected、单 in-flight、ACK 前不生产下一帧；性能不达标则阻止发布而非静默扩容           |
| BrowserWindow 销毁                  | 停止该窗口全部 producer、清 actor projection、revoke renderer URL；不处理其它窗口         |

## 验收与验证

### 1. 文档和静态门禁

```bash
pnpm testplan:validate docs/testing/terminal/terminal-browser-automation-observability.testplan.yaml
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/cli typecheck
pnpm --filter @runweave/cli lint
pnpm cli:build
pnpm --filter @runweave/electron typecheck
pnpm --filter @runweave/electron lint
pnpm --filter @runweave/frontend typecheck
pnpm --filter @runweave/frontend lint
pnpm architecture:check
pnpm docs:check
git diff --check
```

这些命令只证明类型、架构、文档和格式，不证明画面、坐标、资源清理或真实用户行为。

### 2. Spike 门禁

升级 Phase 0 benchmark 以驱动正式 Automation capturePage 链路，再检查 JSON 所有字段、三轮原始
样本和 cleanup。`passed !== true` 或任一硬门槛失败时不得发布，也不得把功能验收或历史 screencast
结果写成性能通过。

### 3. YAML 行为验收

使用 `$toolkit:run-test-cases` 执行：

```text
docs/testing/terminal/terminal-browser-automation-observability.testplan.yaml
```

- Dev Session 生命周期必须使用 `$toolkit:runweave-dev-session`。
- Browser 页面和 CDP 行为必须使用 `$toolkit:playwright-cli` 取证。
- Desktop 工具切换、Sidecar 可见性和真实窗口联动使用 `$computer-use`。
- 默认 fail-fast；任何 case 未执行、blocked 或没有 fresh endpoint 都不能报告全量通过。
- 每个 case 使用 owned fixture、独立连接和明确 cleanup，不复用上一个 case 的 tab、窗口或 UI ref。

### 4. 打包验收

全部 required case 通过后执行：

```bash
pnpm dist:electron:mac
```

在打包产物中至少复验 TBAO-001、003、006、013、016、017、020；Dev 构建通过不能替代打包客户端的
frame IPC、资源清理和性能证据。

## 风险与控制

| 风险                               | 控制                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| 多路 capture 抢占页面渲染或 CDP    | 取消全部后台画面；10 Tab 固定为 10 路元数据 + 1 路 selected stream                  |
| fresh View 没有 compositor surface | 临时 BaseWindow；先挂载后 setBounds；真实断言 viewport 非 0 且 fresh 页直接出帧     |
| capturePage 长尾或阻塞             | 单 selected、单 in-flight、5 FPS 与 renderer ACK；正式产品路径需重跑性能门禁        |
| 观察采集干扰 Playwright/DevTools   | 不发送内部 CDP screenshot/screencast 命令；客户端协议延迟和事件完整性仍需回归       |
| renderer 帧消费慢导致 IPC/内存堆积 | `<img>` load/error ACK；最多一帧 awaiting、没有 pending；cleanup 计数必须为零       |
| RSS 对照被进程自然增长和 GC 污染   | 三组 fresh-process A/B 配对测量；保留 PID 级原始样本，不接受同进程斜率相减          |
| Terminal 身份可伪造                | resolver mint opaque attribution token；不信任 query display name；token 不扩大权限 |
| 输入内容泄露                       | action classifier allowlist；立即丢弃 params；TBAO-014/017 搜索唯一隐私标记         |
| 迟到帧串到错误 Tab                 | window + target + generation + sequence 四重校验，Blob URL ownership 明确           |
| 自动打开打断用户                   | 只在 Sidecar 关闭的 0→1 周期触发；其他工具 active 和人工关闭后 suppress             |
| Terminal Group 改变旧行为          | 只作为带 Terminal 身份 resolver 的默认；显式 group 与旧 unattributed path 兼容      |
| 观察 UI 变成第二控制面             | frame 组件只读；唯一动作是受控 reveal 到既有 Browser                                |
| 静态通过被误报为真实验收           | YAML required cases、真实 Dev Session、Playwright、UI 与性能实验分开报告            |

## Definition of Done

- [ ] Phase 0 报告三轮全部通过，JSON 字段完整，cleanup 为零残留。
- [ ] 20 条 required YAML case 全部在 fresh 隔离环境取得 verdict，没有 skipped/blocked。
- [ ] 两个 Terminal 同 Profile 默认 target 完全隔离；一个 Terminal 活跃时不能绑定第二 Profile。
- [ ] Automation 只展示 active scope，断开立即消失，Browser 页面不丢失。
- [ ] Tab 元数据列表、唯一主画面、follow/pin、只读跳转、指针、动作和 stale frame 行为全部符合合同。
- [ ] Automation 不可见时 1 秒内停止采集，frame/input/token 不落盘或进日志。
- [ ] focused typecheck/lint、CLI build、architecture、docs、diff check 全部通过。
- [ ] macOS 打包成功，并在打包产物复验关键性能、隐私和生命周期 case。
- [ ] 当前架构文档、CLI 文档和 Playwright skill 与最终行为一致。
- [ ] 未新增后台 Tab 画面、单元测试、官方 Dashboard 依赖、远程画面协议或用户数据清理逻辑。
