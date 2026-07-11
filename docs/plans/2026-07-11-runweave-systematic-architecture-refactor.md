# Runweave 系统性架构重构计划

> 状态：已实施，最终验收收尾中
> 计划粒度：L3（跨 Web、App、Backend、Electron、App Server、CLI、共享包和工程工具）
> 代码基线：`feature@8992cab`，2026-07-11，工作区无未提交改动
> 配套验收：`docs/testing/runweave-systematic-architecture-refactor-test-cases.md`

## 实施结果（2026-07-11）

- 架构门禁最终扫描 619 个源码文件、104,852 个物理行：`>600=0`、runtime cycle=0、type-only cycle=0、forbidden import=0、shared root import=0，迁移期 baseline 已删除。
- Web 与 App 已落 connection-scoped TanStack Query；Zustand 保留客户端 UI/选择状态，xterm 输出继续使用 imperative controller，不进入 Query/Zustand 高频更新。
- Web Terminal/Preview/Browser、App 页面与样式、Backend Terminal/WS/LowDB/tmux、Agent Team、Electron Browser/CDP/annotation、CLI、App Server、更新器和 Toolkit Hook 均按 truth owner 拆分；旧 façade 只承担兼容入口。
- 真实行为验收覆盖两套隔离 backend、Web/App、Electron、iOS Simulator、CLI、HTTP/WS、持久化重启、Agent Team 正常/恢复、20 轮资源回收和 Beta rollback/update。
- Backend 20 轮 PTY 创建/销毁发现上游 `node-pty@1.1.0` 的 macOS kqueue FD 泄漏；固定到已验证的 `1.2.0-beta.14` 后 FD、子进程、TCP 和 tmux session 全部回到基线。
- 全量 `architecture:check`、`architecture:verify`、typecheck、lint、build、Playwright E2E、三个 App Server verify、Toolkit Hook、Electron typecheck/macOS 打包和 `quality:gate` 已通过。DMG 首次遇到 APFS 临时状态 35，仓库重试机制第二次成功。
- 原计划建议拆成 11 个小 PR；本次按用户要求在同一工作流连续实施。模块仍按推荐 workstream 保持兼容和可回退，没有改公开协议或持久化 schema。

## 结论

这次不能把“拆到 600 行以下”当成重构本身。当前最严重的问题不是文件数量少，而是状态所有权、领域边界和依赖方向不清；如果只把函数搬到新文件，52 个 props 仍会变成 1 个 52 字段对象，3137 行服务仍会变成若干互相回调的文件，维护成本不会下降。

推荐的终态是：

1. 所有产品代码、运行脚本和 Hook 源码文件物理行数不超过 600，最终无永久豁免。
2. Web 与 App 继续使用已经引入的 Zustand，不再增加 Redux、MobX 或另一套客户端全局状态库。
3. 新增 TanStack Query，统一管理 HTTP 服务端状态、缓存、请求去重、竞态和 mutation；Zustand 只保存客户端拥有的状态。
4. Context 只用于注入连接、QueryClient 和实例级 store，不把业务字段装进一个巨型 Context。
5. Backend、Electron 和 Agent Team 采用“薄适配器 -> 应用服务 -> 领域状态/规则 -> 基础设施端口”的依赖方向，保留兼容 façade，逐步替换 god service。
6. 终端输出、xterm 实例、BrowserView、tmux 进程等高频或外部资源不进入 React Query/Zustand；继续由专门 controller/manager 和 refs 管理。
7. 用 11 个可独立回退、每个都可验收的 PR 完成，不做一次性目录大搬家。

## 目标与完成标准

全部条件同时满足才算完成：

- 纳入范围的文件中，`> 600` 行文件从 27 个降为 0；`scripts/architecture/legacy-baseline.json` 被删除。
- 运行时循环依赖从 1 组降为 0；类型级循环也降为 0。
- `services/store/domain` 不再反向 import `components/pages/routes`；Backend Agent Team 不再 import route helper。
- `@runweave/shared` 的新代码只允许显式子路径导入；完成迁移后产品源码不再从根 barrel 导入。
- `TerminalPreviewPanelContent`、`TerminalPreviewFileView`、`TerminalSurfaceLayout`、`TerminalWorkspaceOverlays` 不再承担 props 中转；业务组件公开 props 原则上不超过 12 个、回调 props 不超过 6 个，且禁止用单个巨型 `viewModel`/`controller` 对象隐藏超限字段。
- Web/App 的 HTTP 服务端数据只保留一个权威副本；Zustand 不复制 Query cache 中的 projects、sessions、preview file、changes 等实体。
- 多后端切换时，Query cache、认证、workspace 选择和事件流按 `connectionId/apiBase` 隔离，旧连接迟到响应不能覆盖新连接。
- Backend 的 Terminal、Agent Team、Electron Browser、App Server 对外 HTTP/WS/IPC/CLI 合约和持久化格式保持兼容。
- `pnpm test:e2e` / `pnpm quality:gate` 必须成为真实存在且与文档一致的命令；静态检查不能冒充浏览器或桌面行为验收。
- 配套用例全部执行通过，并保存真实浏览器、桌面、API、CLI、持久化文件和日志证据。

## 非目标

- 不改变产品功能、交互设计、API URL、WebSocket envelope、CLI 命令或 Electron IPC 名称。
- 不借重构切换数据库，不修改现有 LowDB、scrollback、Agent Team run/outbox、App Server event/state 文件格式。
- 不重写 xterm、tmux、BrowserView/CDP 或 App Server，不引入微服务、DI 框架、事件溯源框架或 XState。
- 不把 App-only、Web-only、Backend、Electron 或 CLI 代码错误迁入 `packages/common`。
- 不新增单元测试、Vitest、Jest 或 coverage 门槛；允许并要求 Playwright E2E、现有 verify 脚本和真实环境验收。
- 不打包 Windows；Electron 仍只按项目约束验证当前 macOS 客户端。
- 不顺手修复与重构目标无关的产品问题。

## 行数规则与作用域

### 纳入

- `frontend`、`app`、`backend`、`app-server`、`electron`、`packages`、`plugins/toolkit`、`scripts` 下所有受版本控制或未忽略的源码。
- 源码扩展名包括 `ts/tsx/js/jsx/mjs/cjs/css/scss/sh/py`，以及 App/Electron 原生层的 `swift/kt/kts/java/m/mm/h`。
- 根目录运行入口 `*.mjs`、`eslint.config.mjs`。
- `.husky/pre-commit`、`.husky/pre-push`。
- 后续新增的 Playwright E2E 与集成 verify 代码

### 排除

- `docs/**`，包括冻结原型；它们是文档/历史产物，不是产品业务源码。
- `dist/**`、`coverage/**`、`node_modules/**`、`electron/release/**`。
- lockfile、图片、图标、证书、二进制和真正由构建生成且不手工维护的产物。
- Skill 说明、reference、模板 Markdown；其中可执行 Hook 和模板 JS 仍按上面的源码规则处理。

### 计数语义

- 以磁盘物理行计数，空行和注释也计入；末尾换行不额外算一行。
- 600 行通过，601 行失败。
- 最终不允许 `eslint-disable`、路径白名单或“历史文件”永久豁免。
- 迁移期间只允许一份机器生成的 legacy baseline：禁止新增违规文件、禁止现有违规文件增长；每个重构 PR 必须减少 baseline，最终删除 baseline 并切为零豁免硬门禁。

## 当前代码事实

### 全仓量化基线

以下统计包含上述产品代码、脚本和 Hook，不含 `docs/prototypes`：

| 模块                          |  文件数 |    物理行数 |   >600 | 500-600 |
| ----------------------------- | ------: | ----------: | -----: | ------: |
| `frontend`                    |     160 |      29,685 |      7 |       4 |
| `backend`                     |     122 |      27,764 |      7 |       1 |
| `app`                         |      75 |      12,292 |      1 |       2 |
| `electron`                    |      39 |      11,593 |      5 |       1 |
| `scripts`                     |      27 |       8,217 |      5 |       2 |
| `packages/shared`             |      19 |       3,117 |      1 |       1 |
| `packages/runweave-cli`       |      21 |       3,076 |      1 |       0 |
| `app-server`                  |      13 |       2,603 |      0 |       0 |
| `plugins/toolkit` 可执行 Hook |       6 |       1,332 |      0 |       0 |
| `packages/terminal-renderer`  |       4 |         481 |      0 |       0 |
| `packages/common`             |       9 |         448 |      0 |       0 |
| 根运行入口/ESLint             |       5 |       1,229 |      0 |       0 |
| `.husky`                      |       2 |           5 |      0 |       0 |
| **合计**                      | **502** | **101,842** | **27** |  **11** |

补充指标：

- 6,059 个函数/方法中，149 个至少 100 行，72 个至少 200 行。
- 29 个 `*Props` 类型至少 10 个字段；32 个业务组件 JSX 调用至少传 10 个属性（不计原生 DOM 标签）。
- Web TSX 中有 128 个 `useState`、72 个 `useEffect`；App TSX 中有 67 个 `useState`、22 个 `useEffect`；两端复杂页面没有使用 reducer 表达成组状态迁移。
- 唯一运行时 import 环是 App 日志链路：`services/http.ts -> features/support-logs/index.ts -> SupportLogSheet.tsx -> services/diagnostic-logs.ts -> services/http.ts`。
- `packages/shared/src/index.ts` 有 16 个 wildcard export；当前有 187 个源码文件从共享包根入口导入，形成高 fan-in 编译和耦合面。
- `quality-gate.mjs` 当前只运行 typecheck/lint，但 `docs/quality/quality-harness.md` 宣称它会选择 Playwright smoke；根 `package.json` 也没有文档所写的 `test`/`test:e2e` 脚本。

### “缺乏状态管理”的准确诊断

原始前提并不完全成立：

- Web 已使用 Zustand 5：`workspace-store.ts`、`preview-store.ts`。
- App 已有 connection、auth、terminal UI、theme 等多个 Zustand store。
- 问题是 store 主要暴露 `setXxx`，业务规则仍散落在组件、hook 和 effect 中；服务端数据、本地 UI、连接生命周期和外部资源没有统一分类。
- `TerminalWorkspace` 和 `TerminalWorkspaceShell` 同时大量订阅 store，再把状态/回调继续向下传，形成“全局 store + prop drilling”双重复杂度。
- `use-terminal-preview-panel-data.ts` 仍维护 28 个本地 state；`TerminalPreviewPanelContent` 接收 52 个 props，说明拆文件没有拆职责。
- `use-app-terminal-ui-store.ts` 反向 import 组件类型，`services/http.ts` 反向 import feature barrel，说明状态层/服务层没有稳定依赖方向。

因此本次目标不是“引入状态库”，而是建立状态所有权、生命周期、作用域和更新语义。

## 根因与影响

### 1. 以文件为拆分单位，而不是以变化原因拆分

`terminal-preview-panel*.tsx`、`terminal-workspace*.tsx` 已经拆出多个文件，但父组件仍创建全部数据和动作，再逐层透传。结果是文件变多，耦合没有下降。

### 2. 服务端状态和客户端状态混放

projects、sessions、preview file、changes、loading/error/retry 由组件手工请求并写入 Zustand/本地 state；WebSocket 再直接改 store。连接切换、迟到响应、缓存失效和 optimistic update 都需要各页面重复处理。

### 3. 巨型 manager/service 同时承担状态、I/O 和编排

- `AgentTeamService` 的 class 本体约 2,200 行，同时负责 run 生命周期、worker 派发、completion reconciliation、recheck watchdog、export 和持久化更新。
- `TerminalSessionManager` 同时管理 project/session/panel、scrollback、write-behind、metadata 和 Codex 线程清理。
- `LowDbTerminalSessionStore` 同时实现 schema 初始化、迁移、四类实体 repository 和 scrollback 文件。
- `TmuxService` 同时处理环境探测、命令执行、session、pane、解析和限流。

### 4. 适配器拥有业务能力，导致依赖倒置

Agent Team 的 `service.ts`、`prompt-sender.ts`、`agent-readiness.ts` 直接 import `routes/terminal-panel-routes.ts` 和 `routes/terminal-input-dispatcher.ts`。Route 本应只解析 HTTP，不应成为其他领域的应用服务。

### 5. composition root 变成业务模块

`backend/src/index.ts` fan-out 54 个本地模块；`electron/src/main.ts` 同时包含窗口、协议、认证迁移、后端生命周期、诊断、IPC、CDP 和应用事件。入口文件无法只回答“系统如何装配”。

### 6. 共享合约按历史追加，缺少领域入口

`terminal-protocol.ts` 863 行，混合 project、session、panel、preview、input、completion、state、events 和 WS 消息。根 wildcard barrel 让每个运行时看到全部合约。

### 7. 质量门禁不能证明重构保持行为

当前没有可执行的 repo Playwright 命令，质量脚本与文档不一致。大重构若只跑 typecheck/lint，只能证明“能编译”，不能证明连接、终端、预览、BrowserView、App 和恢复链路没回退。

## 目标架构

### 前端状态分层

| 状态类别           | 当前例子                                                  | 终态权威源                          | 机制                                            | 禁止                                          |
| ------------------ | --------------------------------------------------------- | ----------------------------------- | ----------------------------------------------- | --------------------------------------------- |
| HTTP 服务端状态    | projects、sessions、panels、preview、changes、history     | Backend/App Server                  | TanStack Query，query key 必含 connection scope | 再复制进 Zustand 或组件 state                 |
| 推送后的服务端状态 | terminal events、panel update、Agent Team run             | Query cache / 专用 event projection | WebSocket reconciler 更新或 invalidate query    | 页面各自维护第二份实体表                      |
| 客户端持久状态     | active connection、theme、recent selection、sidecar width | 客户端                              | 小型 scoped Zustand slice；敏感值走安全存储     | 把 token 写入普通 persist/cache               |
| 屏幕工作流状态     | dialog、编辑草稿、mutation phase、录音 phase              | 当前 feature instance               | reducer 或语义化 Zustand action                 | 多个可能互相矛盾的 boolean/setter             |
| 瞬时 UI/DOM 状态   | focus、hover、ref、copy feedback                          | 组件                                | `useState`/`useRef`                             | 无条件全局化                                  |
| 高频终端流         | xterm 输出、尺寸、IME、scrollback viewport                | xterm/controller                    | imperative adapter + refs                       | 每个 chunk 写 Query/Zustand 触发 React render |
| Electron 外部资源  | BrowserView、WebContents、CDP session                     | Electron main manager               | registry + command + snapshot event             | renderer 自行推断进程资源状态                 |
| Backend 领域状态   | TerminalState、Agent Team phase/recheck                   | 领域 service + repository           | 显式 transition/command/effect                  | route、timer、store 各自改状态                |

具体规则：

- Query key 使用 `['connection', connectionId, ...domainKey]`；active connection 改变时不复用旧连接 cache。
- Zustand store 用 `createStore + Context + useStore(selector)` 建立 workspace/connection scope；slice 只按共同生命周期组合。
- Store action 用 `sessionSelected`、`connectionChanged`、`mutationStarted` 等领域语义，不暴露一组任意 `setXxx` 让组件拼事务。
- 可由 ID、实体或其他状态计算出的值使用 selector，不重复保存对象副本。
- Context 只提供 scope、port 或 store 实例；消费组件使用窄 selector/query hook。
- `TerminalRenderer` 的 15 个 props 是一个低层适配器的内聚配置面，可保留；不能拿它作为业务组件继续传几十个字段的先例。

### 后端与 Electron 依赖方向

```text
HTTP / WS / IPC / CLI adapter
            ↓
application command / query service
            ↓
domain state + transition + policy
            ↓
repository / process / filesystem / network port
            ↑
LowDB / tmux / node-pty / BrowserView / App Server adapter
```

- Domain 不 import Express、Electron、CLI formatter、具体 LowDB 或 route helper。
- Application service 返回领域结果/错误；adapter 负责 HTTP status、IPC validation 和输出格式。
- 兼容 façade 保留原公开方法，内部委托新模块，调用方按批次迁移。
- 所有 timer、queue、watchdog 明确 owner，并提供 `start/stop/dispose`；不能靠模块全局副作用隐式启动。

### 文件与模块门禁

新增 `scripts/architecture/`，职责拆分为：

- `file-size.mjs`：按统一 include/exclude 和物理行算法检查 600 行。
- `import-graph.mjs`：TypeScript AST 解析运行时/类型 import，检查 cycle 和依赖方向。
- `react-metrics.mjs`：报告组件 props、JSX 透传、函数长度、hook 数；首期作为 ratchet 指标，不鼓励为了过阈值包装对象。
- `check.mjs`：组合硬门禁，输出稳定 JSON/文本。
- `legacy-baseline.json`：迁移期临时记录文件体积、循环、反向依赖和根导入债务，最终必须删除。

根 `package.json` 增加 `architecture:report`、`architecture:check`；`quality:gate` 和 pre-push 调用硬门禁。`eslint.config.mjs` 继续负责语言规则，不复制另一套不一致的行数算法。

## 必拆文件矩阵

下表覆盖当前全部 27 个违规文件；目标文件名表达职责，实施时允许在同一职责内微调命名，但不能退化为 `part-1/part-2`。

| 当前文件（行）                                                              | 主要混合职责                                                        | 目标拆分                                                                                                                                                             |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend/src/agent-team/service.ts` (3137)                                  | 生命周期、派发、验收、completion、recheck、export                   | 保留 `<600` façade；新增 `run-lifecycle.ts`、`worker-dispatcher.ts`、`completion-reconciler.ts`、`recheck-coordinator.ts`、`run-exporter.ts`、`acceptance-policy.ts` |
| `app/src/main.css` (2121)                                                   | Home、connection、terminal、composer、preview、history、support log | `styles/tokens.css`、`home.css`、`connections.css`、`terminal-shell.css`、`terminal-composer.css`、`terminal-preview.css`、`overlays.css`；`main.css` 只做 imports   |
| `electron/src/terminal-browser-view.ts` (1561)                              | registry、tab order、BrowserView 生命周期、header、IPC              | `terminal-browser/registry.ts`、`manager.ts`、`window-lifecycle.ts`、`header-policy.ts`、`ipc-handlers.ts`；原文件做 façade                                          |
| `electron/src/main.ts` (1551)                                               | 窗口、协议、认证、backend、诊断、IPC、应用生命周期                  | `desktop/bootstrap.ts`、`window-manager.ts`、`backend-controller.ts`、`auth-profile.ts`、`diagnostics.ts`、`ipc-handlers.ts`；`main.ts` 只启动/退出                  |
| `backend/src/terminal/tmux-service.ts` (1280)                               | 探测、命令执行、session、pane、解析、env                            | `tmux/client.ts`、`session-service.ts`、`pane-service.ts`、`parsers.ts`、`environment.ts`；保留 façade                                                               |
| `backend/src/terminal/manager.ts` (1137)                                    | project/session/panel、metadata、scrollback、write-behind           | `project-catalog.ts`、`session-registry.ts`、`panel-registry.ts`、`metadata-coordinator.ts`、`write-behind.ts`；保留 `TerminalSessionManager` façade                 |
| `backend/src/terminal/lowdb-store.ts` (1066)                                | schema/migration、四类实体、scrollback 文件                         | `storage/lowdb/database.ts`、`migrations.ts`、`project-repository.ts`、`session-repository.ts`、`panel-repository.ts`、`scrollback-repository.ts`                    |
| `electron/src/terminal-browser-cdp-proxy.ts` (968)                          | WS server、连接、Browser/Target/Session CDP 路由                    | `cdp-proxy/server.ts`、`connection.ts`、`message-router.ts`、`browser-domain.ts`、`target-domain.ts`、`session-domain.ts`                                            |
| `electron/src/terminal-browser-annotation.ts` (905)                         | 701 行注入 runtime + main-process service                           | `annotation/service.ts` 与 `annotation/runtime/{selection,overlay,serialization,entry}.ts`；构建时生成注入字符串                                                     |
| `packages/shared/src/terminal-protocol.ts` (863)                            | 全部 terminal 合约                                                  | `terminal/{project,session,panel,input,preview,state,events,websocket}.ts`；原文件暂为兼容 export façade                                                             |
| `scripts/runweave-update.mjs` (853)                                         | CLI、Git、codesign、App/App Server/runtime 更新                     | `runweave-update/{cli,git,codesign,mac-app,runtime,app-server,workflow}.mjs`                                                                                         |
| `frontend/src/components/terminal/use-terminal-browser-controller.ts` (844) | snapshot、导航、proxy、device、header、annotation、tab order        | `browser/use-browser-sync.ts`、`use-browser-navigation.ts`、`use-browser-proxy.ts`、`use-browser-device.ts`、`use-browser-annotation.ts`；controller 只组合          |
| `scripts/runweave-beta.mjs` (843)                                           | status、health、update、rollback、CLI                               | `runweave-beta/{paths,status,health,update,rollback,cli}.mjs`                                                                                                        |
| `backend/src/routes/terminal.ts` (809)                                      | session CRUD、history、input、interrupt、注册器                     | `terminal-session-routes.ts`、`terminal-history-routes.ts`、`terminal-input-routes.ts`；业务命令移到 application service                                             |
| `backend/src/index.ts` (764)                                                | service 构造、App Server 消费、HTTP app、生命周期                   | `bootstrap/runtime-services.ts`、`app-server-integration.ts`、`http-app.ts`、`lifecycle.ts`；index 只解析配置和 start                                                |
| `frontend/src/components/terminal/terminal-preview-panel.tsx` (761)         | query、mutation、快捷键、dialog、内容装配                           | feature provider + `preview-mutations.ts`、`preview-shortcuts.ts`、`preview-dialogs-controller.ts`；Panel 只布局/组合                                                |
| `packages/runweave-cli/src/commands/terminal-agent.ts` (733)                | agent 推断、准备、确认、等待、control                               | `commands/terminal-agent/{infer,prepare,confirm,control}.ts`；命令入口只编排/格式化                                                                                  |
| `scripts/verify-toolkit-hooks.mjs` (710)                                    | fixture、安装、launcher、断言、场景                                 | `verify/toolkit-hooks/{fixture,launcher,assertions,scenarios}.mjs` + 薄入口                                                                                          |
| `backend/src/ws/terminal-server.ts` (697)                                   | WS 生命周期、输入、runtime 绑定、output/metadata                    | `terminal-connection.ts`、`terminal-input-handler.ts`、`terminal-output-subscription.ts`，复用已有 handshake/helpers                                                 |
| `frontend/src/components/terminal/terminal-surface.tsx` (686)               | search、IME、floating composer、scroll、input、layout               | `surface/use-terminal-search.ts`、`use-floating-composer.ts`、`use-scroll-controller.ts`、`use-input-controller.ts`；页面用 slots 组合                               |
| `frontend/src/features/terminal/preview-store.ts` (665)                     | sidecar UI、project preview、browser tabs                           | `preview/ui-store.ts`、`project-selection-store.ts`、`browser-store.ts`，或同一 scoped store 的独立 slices                                                           |
| `frontend/src/components/terminal/use-terminal-emulator.ts` (662)           | xterm 初始化、addons、IME、resize、生命周期                         | `emulator/use-xterm-lifecycle.ts`、`use-xterm-input.ts`、`use-xterm-resize.ts`、`addons.ts`                                                                          |
| `scripts/verify-app-server-state-sync.mjs` (661)                            | server fixture、HTTP/WS client、11 类场景                           | `verify/app-server-state-sync/{fixture,client,assertions,scenarios/*}.mjs` + 薄入口                                                                                  |
| `frontend/src/components/terminal/use-terminal-preview-panel-data.ts` (652) | search/file/diff/changes/query/mutation/本地 UI                     | TanStack Query hooks：`preview/queries.ts`、`file-mutations.ts`、`use-file-editor.ts`、`use-changes.ts`；删除巨型返回对象                                            |
| `frontend/src/components/terminal/terminal-quick-input-popover.tsx` (649)   | remote list、表单、tabs、row、格式化                                | `quick-input/use-quick-inputs.ts`、`quick-input-form.tsx`、`quick-input-list.tsx`、`quick-input-row.tsx`、`format.ts`                                                |
| `electron/src/backend-runtime.ts` (609)                                     | 路径、候选、orphan、端口、进程启动                                  | `backend-runtime/{paths,orphan-recovery,ports,launcher}.ts` + façade                                                                                                 |
| `scripts/sync-toolkit-plugin.mjs` (602)                                     | Hook 镜像、Codex cache、Trae 安装、版本                             | `toolkit-sync/{hook-assets,codex-cache,codex-install,trae-install,commands}.mjs`                                                                                     |

同一工作流中必须主动处理 11 个 500-600 行临界文件，避免刚完成就再次越线：

- `packages/shared/src/app-server-node.ts` (572)
- `frontend/src/components/terminal/terminal-workspace.tsx` (566)
- `app/src/hooks/use-app-session.ts` (561)
- `scripts/runweave-update-core.mjs` (554)
- `frontend/src/components/terminal/terminal-workspace-shell.tsx` (540)
- `electron/src/hooks/hook-installer.ts` (536)
- `scripts/verify-app-server-event-center.mjs` (535)
- `backend/src/terminal/runtime-launcher.ts` (531)
- `app/src/components/TerminalChangesTab.tsx` (523)
- `frontend/src/components/terminal/terminal-session-tab.tsx` (523)
- `frontend/src/pages/system-monitor-page.tsx` (510)

## 分阶段实施

### 阶段 0：行为基线与架构门禁

改动：

- 新增 `scripts/architecture/*` 和 legacy baseline，记录本计划中的指标。
- 新增根命令 `architecture:report`、`architecture:check`，接入 pre-push 和 `quality:gate`。
- 建立真实 `pnpm test:e2e` 入口、`frontend/playwright.config.ts` 和 `frontend/tests/*.spec.ts` 的关键路径 characterization；只写 E2E，不写单测。
- 修正 `quality-harness.md`、`layers.md`、`command-matrix.md` 与真实脚本不一致的问题。
- 在任何结构改动前，执行配套用例的核心 Web、App、Backend、Electron、CLI、App Server 基线并保存证据。

验收：架构检查能稳定复现 27 个 legacy 违规、1 个 runtime cycle 和已知反向依赖；新增 601 行 fixture、循环依赖或禁向 import 会失败；现有产品行为基线可重复。

### 阶段 1：共享合约与依赖方向

改动：

- 拆分 `terminal-protocol.ts` 与临界 `app-server-node.ts`，先保留 root/旧文件兼容 export。
- 为 `@runweave/shared` 增加 terminal、app-server、agent-team、diagnostic 等显式 subpath exports，按模块迁移消费者。
- 修复 App support-log runtime cycle：service 直接依赖 recorder/type 叶子模块，barrel 不再导出后被底层 service 使用。
- 把 `AppTerminalDetailTab`、`SelectedTerminalChange`、`AppAuthSession`、connection model 移到 feature model 层，store/service 不再 import component/page。
- 把 terminal panel/input 的业务函数从 Backend routes 移到 application 模块，Agent Team 只依赖 application port。

验收：运行时和类型循环均为 0；禁向依赖为 0；共享类型拆分不改变编译后的请求/响应形状。

### 阶段 2：Web 状态基础设施

改动：

- 在 Web root 建立 connection-scoped `QueryClientProvider` 和 terminal runtime/store provider。
- 定义 query keys、统一错误/401 处理、WebSocket event reconciler 和 cache reset 语义。
- 将 workspace store 改成 normalized client state + semantic actions；projects/sessions/panels 移入 Query cache。
- 拆分 `frontend/src/services/terminal.ts` 为 project/session/panel/input/ticket 客户端，但保持 feature API 对调用方稳定。
- 通过 selector 计算 active entity、project status、visible sessions；不存重复对象。

验收：切换连接不会串 cache；迟到请求被 scope 隔离；session/project 选择、marker、重连和缓存终端行为与基线一致。

### 阶段 3：Web Terminal、Preview 与 Browser UI

改动：

- 先迁移 Terminal Preview 这一条完整 vertical slice，验证 TanStack Query + scoped Zustand 模式，再扩展到 workspace。
- 删除 `use-terminal-preview-panel-data` 巨型返回对象；file、changes、search、mutation 各自拥有 query/hook/controller。
- 让叶子组件直接消费窄 query/selector；`TerminalPreviewPanelContent` 等不再由父组件传递几十个字段。
- `TerminalWorkspaceShell` 只负责视觉组合；header、stage、overlays 通过 feature hooks 获取自己的状态和 commands。
- 拆分 TerminalSurface、emulator、browser controller 和 quick input；xterm 高频输出保持 imperative。
- 用 React Profiler 或现有性能日志记录切换 project/session、持续输出、打开 Preview 前后的 render 次数和 blank frame。

验收：已知 52/37/36/35/32 props 热点消失且没有巨型对象替代；Web Terminal、Preview、Browser、IME、floating composer、panel split 和缓存无回归。

### 阶段 4：App 状态、页面与样式

改动：

- App 使用与 Web 相同的 server-state 原则，但保留 App 独立 UI 和 Ionic primitives。
- `useAppSession` 拆成 auth session、overview query、device connection、terminal events 四个职责；connection/auth store 只持客户端拥有状态。
- `AppTerminalPage` 建立 terminal-instance provider；`AppTerminalPanels`、Changes、Files 在叶子消费 query/commands。
- 把 terminal UI store 的 component 类型依赖移到 feature model；删除未使用的 `use-hello-store.ts`。
- 按 feature 拆分 `main.css`；继续使用原生 button + 项目 CSS 处理高密度 action slot，不把固定布局改成 `IonButton`。

验收：多连接认证隔离、offline 保留数据、恢复重连、terminal input/Stop/image/voice、Changes/Files、Native secure credentials 和 Ionic 页面结构保持一致。

### 阶段 5：Backend Terminal 核心与持久化

改动：

- 以 `TerminalSessionManager` 和 `TmuxService` façade 保护 41 个以上调用方，内部逐步委托新模块。
- 分离 project/session/panel registry、metadata、scrollback write-behind、runtime launch 和 tmux session/pane/process client。
- LowDB 按 repository 和 scrollback adapter 拆分；只搬代码，不改 JSON schema、migration 语义、写队列顺序或文件名。
- Terminal route/WS 只做 validation、auth、协议映射；输入、interrupt、panel split、history 进入 application commands/queries。
- 明确 dispose 顺序，保证 pending scrollback/activity、tmux pipe、PTY、WS listener 在退出时释放。

验收：创建/恢复/删除 session、tmux orphan、panel split、scrollback、TerminalState、hook、WS 输入输出和重启持久化与基线一致；旧数据无需迁移即可读取。

### 阶段 6：Agent Team 领域化

改动：

- 从 `AgentTeamService` 提取纯 transition/policy：phase/status、worker serial order、acceptance merge、bounce、recheck attempt、need_human。
- completion reconciler 只完成身份/新鲜度/幂等判定；worker dispatcher 只负责 pane 与 prompt；watchdog owner 只负责调度 timer。
- run update 使用单一 command/transition 入口，禁止任意 helper 拼接多个字段形成非法状态。
- 保持 `.runweave/agent-team/<runId>.json`、pane-scoped outbox、角色顺序、超时、日志和 API 兼容。

验收：现有 Agent Team 验收来源、completion recovery、review/verify 回弹、重复事件、backend 重启和 outbox 隔离用例全部通过。

### 阶段 7：Electron 与 Terminal Browser

改动：

- `main.ts` 降为 composition root；backend controller、auth/profile、diagnostics、window、IPC 各自有生命周期。
- `TerminalBrowserManager` 成为 BrowserView/tab 的唯一 owner；registry 不导出可任意修改的全局 Map。
- IPC handler 只验证和调用 manager；header/proxy/device/annotation/persistence 是独立能力。
- CDP proxy 按 Browser/Target/Session domain 路由；保留 scoped target、connection limit 和 heartbeat 语义。
- annotation runtime 源码模块化后在构建期打包，生成物不作为可手改源文件。
- backend runtime 分离候选路径、orphan recovery、端口和进程启动。

验收：macOS Electron 启动/重启、Stable/Beta、Browser tabs/order、popup、proxy/header/device、CDP/MCP、annotation、DevTools 和 cookie persistence 无回归。

### 阶段 8：CLI、App Server、脚本与 Hook

改动：

- CLI `terminal-agent` 拆成 inference、preparation、confirmation、control；命令入口只处理 args/output/exit code。
- App Server 当前 13 个源码文件均低于 600 且 event-center/projector/store 分层基本健康，不做大改；只迁移 shared subpath，必要时把 HTTP schema 从 `http-server.ts` 提出。
- `runweave-update`、`runweave-beta`、verify 和 toolkit sync 按矩阵拆分；工作流入口不拥有平台细节。
- `plugins/toolkit/hooks` 作为 Hook 唯一源码，`electron/resources/hooks` 作为受校验的 packaging mirror；构建/同步前生成并校验五组文件一致，禁止双写。
- `packages/common` 保持“Web 与 App 当前都调用”边界；`terminal-renderer` 只在需要降低 311 行组件生命周期复杂度时提取 `useTerminalRendererLifecycle`，不把其配置 props 全局化。

验收：CLI、App Server verify、Stable/Beta update/rollback、toolkit sync、Hook/飞书通知和 Electron packaging mirror 全部通过。

### 阶段 9：清债、硬门禁与活文档

改动：

- 删除 legacy baseline，切换为全仓零豁免 600 行硬门禁。
- `react-metrics` 中本计划列出的热点击穿为 0；禁止新的大函数、props 中转和整 store 订阅。
- 全量执行配套验收；对失败只回滚当前 workstream，不绕过门禁。
- 把稳定结论更新到 `docs/architecture/*`、`docs/quality/*`、`docs/testing/*` 和 `docs/README.md`。
- 本计划结论被活文档吸收后，按仓库约定删除临时 `docs/plans` 文件。

验收：本计划“目标与完成标准”全部满足，质量脚本、文档和实际命令一致。

## 11 个 PR 的推荐边界

| PR  | 范围                                            | 必须独立通过的门禁                            |
| --- | ----------------------------------------------- | --------------------------------------------- |
| 1   | 架构检查、E2E characterization、质量文档对齐    | architecture report、基线 E2E、typecheck/lint |
| 2   | shared 合约拆分、循环/禁向依赖修复              | 全运行时 typecheck、import graph              |
| 3   | Web Query/scoped store 基础与 workspace         | Web E2E、连接隔离                             |
| 4   | Web Preview/TerminalSurface/Browser/quick input | Playwright + Terminal Browser 相关用例        |
| 5   | App session/state/pages/CSS                     | App browser/native 真实验收                   |
| 6   | Backend manager/store/tmux                      | Backend verify、tmux 重启/持久化              |
| 7   | Backend routes/WS/bootstrap                     | API/WS/TerminalState 全链路                   |
| 8   | Agent Team                                      | Agent Team 全套现有用例                       |
| 9   | Electron main/Browser/CDP/annotation/runtime    | macOS Electron + Playwright/CDP               |
| 10  | CLI、App Server、update/beta、toolkit/hooks     | CLI/verify/update/rollback/hook               |
| 11  | 删除 baseline、全量门禁、活文档                 | 全量验收和零豁免检查                          |

每个 PR 只迁移一个 truth owner，保留旧 façade；不得在同一 PR 同时重写协议、存储格式和 UI。

## API、数据、兼容与安全

- HTTP URL、method、status、JSON 字段、WS/IPC event 名称、CLI flags 在本次重构中冻结；shared 拆分只改变源码 import。
- LowDB、scrollback、App Server JSONL/state、Agent Team run/outbox、App auth secure storage key 和 localStorage key 冻结。
- Query cache 只在内存存在，不持久化 access/refresh token；401 只清理当前 connection session。
- WebSocket 事件必须校验 connection scope 和 entity identity 后再更新 cache；迟到事件不得跨连接写入。
- Electron IPC 继续校验 sender/window/target；拆文件不能放宽 Origin、Bearer、ticket、path traversal 或 target scope。
- Hook mirror 生成过程不得把 webhook、token、Authorization 或用户路径写进 manifest/cache/report。
- 重构不做双写数据迁移；兼容 façade 可双读调用，但同一业务状态只能有一个写 owner。

## 错误处理与可观测性

- 保留现有用户可见错误、HTTP status、fallback 和 warning/error 级别；结构重构不借机改文案语义。
- Application/domain 返回 typed result/error；adapter 才映射 HTTP/IPC/CLI。
- Query error 统一分类 401、offline、not-found、conflict、unexpected；只对可重试错误 retry。
- 现有 requestId、outbox mtime、runId/panelId、TerminalState reason、releaseId 等诊断字段必须保留。
- 每个 controller/service 暴露明确 `dispose/stop`，验收检查 listener、timer、process 和 WebSocket 无泄漏。

## 迁移与回滚

- 使用 strangler 方式：旧公开入口保留，内部委托新模块；调用方迁完再删除 façade。
- 结构 PR 不改变持久化 schema，因此回滚代码即可，不执行数据回滚脚本。
- Query 迁移按 feature vertical slice 进行；一个 slice 未通过时可回退该 slice，不保留 Query/Zustand 双写。
- shared root export 在消费者迁移完成前保留；最终移除前用 import graph 证明无调用方。
- Electron annotation 构建生成失败时阻断 build，不回退到手工维护 700 行字符串。
- legacy line baseline 只能减少；若某 PR 需要增加，说明范围或拆分方式错误，应重做而非修改基线。

## 验证

实施阶段按 `docs/testing/runweave-systematic-architecture-refactor-test-cases.md` 执行。最低门禁包括：

```bash
pnpm architecture:check
pnpm typecheck
pnpm lint
pnpm build
pnpm test:e2e
pnpm app-server:verify
pnpm app-server:verify-cli-start
pnpm app-server:verify-state-sync
pnpm toolkit:verify-hooks
git diff --check
```

其中 typecheck/lint/build/architecture check 是前置门禁，不能作为 Web/App/Electron/Backend 行为通过证据。浏览器路径必须使用 `$playwright-cli`；桌面应用准备和系统操作使用 `$computer-use`；协议、CLI、持久化和进程恢复使用真实命令、文件和日志取证。

## 风险与控制

| 风险                                       | 控制                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------ |
| 只为过行数把代码机械搬走                   | 以 truth owner、依赖方向、props/状态指标和行为用例同时验收                     |
| Query cache 与 Zustand 双源漂移            | 明确 server/client state 清单；禁止双写；WebSocket 只更新权威 cache/projection |
| 多连接切换串数据                           | query key/store provider 都带 connection scope，覆盖迟到响应用例               |
| Terminal 输出进入 React state 导致性能回退 | 保留 imperative xterm 流；Profiler/perf 日志对比                               |
| Backend façade 变成永久转发层              | 每个 PR 记录迁移调用方，PR 11 删除无调用 façade                                |
| 存储/协议无意变化                          | schema/contract snapshot 与旧数据重启验收；本次不做数据迁移                    |
| Agent Team 并发/幂等回退                   | transition 单入口、per-run queue、completion/outbox 全套恢复用例               |
| Electron 资源泄漏                          | manager owner + dispose；窗口/tab/CDP 重复开关和进程退出验收                   |
| 新门禁拖慢开发                             | staged/changed 模式做快速检查，pre-push/CI 做全量；算法只有一个权威实现        |
| 重构长期分支漂移                           | 11 个小 PR 按序落主干，每个 PR 保持兼容和可回退                                |

## 实施时需验证的推测

- 基于当前代码，我推测 TanStack Query 能删除 Preview、Workspace、App Changes/Files 中大部分手工 loading/error/requestId 代码；先用 Preview vertical slice 验证，若无法同时满足连接隔离、WebSocket reconciliation 和 bundle 约束，则停止扩面并记录证据，不静默换另一套全局 store。
- 基于当前代码，我推测 `TerminalRenderer` 的高 props 是低层配置而非 prop drilling；只有真实调用方仍重复装配相同配置时，才引入配置 provider。
- 基于当前代码，我推测 Hook packaging mirror 可以在构建前可靠生成；实施前需确认所有 Electron 打包入口都经过同步步骤，再决定是否停止提交 mirror 文件。

## 参考依据

- React 官方建议避免冗余、重复和深层 state，并用 reducer/context 收敛复杂更新与深层透传：<https://react.dev/learn/choosing-the-state-structure>、<https://react.dev/learn/scaling-up-with-reducer-and-context>
- TanStack Query 官方将异步服务端状态与普通客户端 state 区分，覆盖 fetching、caching、synchronizing 和 updating：<https://tanstack.com/query/latest/docs/framework/react/overview>
- Zustand 官方 slices pattern 用于把增长的 store 按模块拆分，并建议以 selector 控制订阅：<https://github.com/pmndrs/zustand/blob/main/docs/learn/guides/slices-pattern.md>、<https://zustand.docs.pmnd.rs/reference/hooks/use-shallow>
- ESLint 官方 `max-lines` 将大文件视为维护风险；本仓因需覆盖 CSS/Shell/MJS，使用统一自定义检查器作为最终权威：<https://eslint.org/docs/latest/rules/max-lines>
