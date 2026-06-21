# Zustand State Refactor Review

## 检查范围

- Web: `frontend/src/App.tsx`, `frontend/src/features/connection/*`, `frontend/src/features/terminal/preview-store.ts`, `frontend/src/components/terminal/*`
- App: `app/src/pages/AppTerminalPage.tsx`, `app/src/components/AppTerminalPanels.tsx`, `app/src/hooks/use-app-session.ts`, `app/src/hooks/use-app-terminal-connection.ts`, `app/src/store/*`
- 结论基于只读代码检查；本轮未修改源码。

## 现状

- `zustand` 已经在 Web 和 App 两端引入：`frontend/package.json:57`, `app/package.json:32`。
- App 已经有多个 zustand store：`app/src/store/use-app-connection-store.ts`, `app/src/store/use-auth-store.ts`, `app/src/store/use-theme-store.ts`。
- Web 端也已有 `useTerminalPreviewStore`：`frontend/src/features/terminal/preview-store.ts:53`，但它主要覆盖 preview UI、project preview selection 和 browser tabs；核心 workspace/session/preview data 仍大量停留在 React state、hook 返回对象和 props 传递中。

## Findings

### P1 严重：Web terminal workspace 的状态和动作集中在父组件，形成 57 个 props 的 shell 接口

风险：`TerminalWorkspace` 管理 projects、sessions、active selection、loading/error、markers、dialogs、history、cached surfaces、terminal state 等多组状态，再把它们和 34 个回调传给 `TerminalWorkspaceShell`。任何新增 terminal 行为都必须同时改父组件 state、actions hook、shell props 和子组件调用，回归面很大。

定位：

- `frontend/src/components/terminal/terminal-workspace.tsx:62`
- `frontend/src/components/terminal/terminal-workspace.tsx:439`
- `frontend/src/components/terminal/terminal-workspace.tsx:490`
- `frontend/src/components/terminal/terminal-workspace-shell.tsx:507`

修复方向：优先抽一个 Web 专用 `terminal-workspace-store`，把 session/project list、active ids、markers、dialog/history 状态和 workspace actions 收到 store slice；shell 组件直接用 selector 读取局部状态，减少父子参数传递。

### P1 严重：Preview 面板已有 store 但只存“选择态”，真实数据态仍散落在 hook 中并向下传 49 个 props

风险：`useTerminalPreviewStore` 已保存 `mode/openFileQuery/selectedFilePath/selectedChangePath/viewMode`，但 `useTerminalPreviewPanelData` 又在本地维护 search/file/editor/save/changes/diff/mutation/pathCopied 等几十个状态，并返回 80 多个字段给 `TerminalPreviewPanel`。随后 `TerminalPreviewPanelContent` 再接收 49 个 props，`TerminalPreviewFileView` 再接收 35 个 props。状态读写链路过长，最容易出现 selected path、loaded file、dirty state、diff state 不一致。

定位：

- `frontend/src/features/terminal/preview-store.ts:40`
- `frontend/src/components/terminal/use-terminal-preview-panel-data.ts:81`
- `frontend/src/components/terminal/use-terminal-preview-panel-data.ts:531`
- `frontend/src/components/terminal/terminal-preview-panel.tsx:57`
- `frontend/src/components/terminal/terminal-preview-panel.tsx:354`
- `frontend/src/components/terminal/terminal-preview-panel-content.tsx:36`
- `frontend/src/components/terminal/terminal-preview-file-view.tsx:55`

修复方向：把 preview 拆成 `ui`, `selection`, `file`, `changes`, `mutation` slices；异步动作如 `loadFile/loadChanges/loadDiff/saveFile/rename/delete` 进入 store action 或 store-adjacent action module。Content/FileView 只读取自己需要的 slice selector。

### P1 严重：Workspace actions/events 通过注入 setter 操作父组件内部状态，边界反了

风险：`useTerminalWorkspaceActions` 接收十几个 React setter，`useTerminalWorkspaceEvents` 也接收 setter、refs 和 selection 函数。这让 action/event 模块不能独立维护状态不变量，父组件必须了解每个动作要改哪些字段。后续迁移到 zustand 时，如果只是把 setter 换成 store setter，问题仍会保留。

定位：

- `frontend/src/components/terminal/terminal-workspace-actions.ts:23`
- `frontend/src/components/terminal/terminal-workspace-actions.ts:53`
- `frontend/src/components/terminal/terminal-workspace-events.ts:12`
- `frontend/src/components/terminal/terminal-workspace-events.ts:50`

修复方向：改成 action 模块从 store 的 `get/set` 读写完整 workspace state，暴露业务动作如 `createSession`, `closeSession`, `applyTerminalEvents`, `selectProject`；组件不再传 setter。

### P1 严重：Preview action 类型被弱化成 `Record<string, string | number | undefined>`，会绕过 store 状态契约

风险：`useTerminalPreviewPanelActions` 内部定义的 `UpdateProjectPreview` 接受任意 string/number patch。它实际更新的是 `TerminalPreviewProjectState`，但类型已经丢失，新增字段或错误字段不会被类型系统拦住。这与引入状态管理的目标相冲突。

定位：

- `frontend/src/components/terminal/terminal-preview-panel-actions.ts:8`
- `frontend/src/components/terminal/terminal-preview-panel-actions.ts:21`
- `frontend/src/components/terminal/terminal-preview-panel-actions.ts:104`

修复方向：复用 `Partial<TerminalPreviewProjectState>` 或在 store 中暴露更语义化动作，例如 `openFile`, `selectChange`, `setMarkdownViewMode`，避免任意 patch。

### P2 一般：Browser tool 的 tabs 已进 store，但 controller 仍混合运行时副作用和大量局部 UI 状态

风险：`preview-store` 保存 browser tabs/activeTabId，但 `useTerminalBrowserController` 仍管理 proxy、headers panel、device panel、annotation、Electron sync、bounds sync 等状态，然后 `TerminalBrowserTool` 解构 30 多个字段继续传给 navigation/surface。浏览器工具后续扩展会持续膨胀。

定位：

- `frontend/src/features/terminal/preview-store.ts:56`
- `frontend/src/components/terminal/use-terminal-browser-controller.ts:48`
- `frontend/src/components/terminal/use-terminal-browser-controller.ts:78`
- `frontend/src/components/terminal/terminal-browser-tool.tsx:31`
- `frontend/src/components/terminal/terminal-browser-navigation-bar.tsx:26`

修复方向：browser 可独立成 `terminal-browser-store` 或 preview store 的 browser slice，至少把 panel open state、proxy/header/device/annotation 状态和 tab actions 分层。Electron side effects 保留在 controller，但 controller 只驱动 store action。

### P2 一般：Web 和 App 的连接状态实现不一致，公共抽象边界需要先定清楚

风险：App 连接管理已是 zustand store，并带 URL 规范化、默认连接、持久化和 activeConnection selector；Web 连接仍是 `useConnections` + `useState` + localStorage，并把 connections/activeConnectionId 通过路由层一路传到页面。后续若要“公共部分抽象在一起”，容易误把运行时相关代码迁入 `packages/common` 或复制两套逻辑。

定位：

- `app/src/store/use-app-connection-store.ts:137`
- `frontend/src/features/connection/use-connections.ts:85`
- `frontend/src/App.tsx:164`
- `frontend/src/App.tsx:260`
- `frontend/src/App.tsx:288`

修复方向：抽纯数据模型和 URL/持久化 helper 时放在合适边界；Web/App UI store 分别保留在各自 app 内。若确实两端复用浏览器端 helper，才放 `packages/common` 子路径；跨运行时 DTO/协议进 `packages/shared`。

### P2 一般：App terminal 页面承担过多职责，后续也需要 store 化，但优先级低于 Web terminal

风险：`AppTerminalPage` 同时管理 terminal connection、状态轮询、删除弹窗、tab、changes 跳转、composer action、support log scope，再向 `AppTerminalPanels` 传 20 个 props。当前规模小于 Web terminal，但已经出现相同趋势。

定位：

- `app/src/pages/AppTerminalPage.tsx:58`
- `app/src/pages/AppTerminalPage.tsx:160`
- `app/src/pages/AppTerminalPage.tsx:250`
- `app/src/pages/AppTerminalPage.tsx:417`
- `app/src/components/AppTerminalPanels.tsx:18`

修复方向：先抽 App terminal session UI store：`activeTab`, `changesCount`, `requestedChange`, delete dialog state；连接 WebSocket hook 和 renderer refs 暂不强行放入 store。

### P3 提示：存在示例型 zustand store 未被使用，容易误导后续结构

风险：`use-hello-store` 没有调用方，且使用单引号风格，与现有项目风格不一致。它会让新 store 命名和组织方式变得不清晰。

定位：

- `app/src/store/use-hello-store.ts:1`

修复方向：后续正式整理 store 目录时删除或替换为真实 store 示例；本轮未处理。

## 建议重构顺序

1. 先做 Web terminal workspace store：这是最大 props 爆点，也最接近 terminal 全局工作台模型。
2. 再扩展/拆分 Web preview store：把现有 `preview-store` 从 selection store 升级成完整 preview domain store。
3. 再处理 browser slice：保留 Electron side-effect controller，但把 controller 内 UI 状态和 tab action 下沉。
4. 最后处理 App terminal：以页面 UI store 为主，不急着把 WebSocket/renderer refs 放进 zustand。

## 验证建议

- 每个阶段先跑 `pnpm --filter @runweave/frontend typecheck` 或 `pnpm --filter @runweave/app typecheck`。
- Web terminal 和 preview 行为需要用 `$playwright-cli` 做浏览器验证，重点覆盖：创建/切换/关闭 session、project 切换、preview 打开文件、保存冲突、changes diff、browser tab 切换。
