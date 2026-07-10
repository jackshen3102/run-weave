# 当前工作区代码与计划混合评审

> 后续状态（2026-07-10）：本报告记录的是 `HEAD=bddf2c6` 的评审快照。GitHub PR 准备阶段已基于最新 `origin/main` 迁移 Terminal Workspace 改动、撤回生产 tab strip 的 equal-shrink 中间态，并修复失效文档链接，因此下述两个 P1 与 P3 已解决。Electron tab 顺序持久化和完整跨层验收仍按 P2/计划后续阶段跟进。

## 结论

当前改动不建议直接合入：未发现 P0，但有 **2 个 P1、2 个 P2、1 个 P3**。App Server 健康检查已经改成 fire-and-forget，旧报告中的终端创建串行等待问题已解决；Terminal Browser 事件节流也已能在状态回摆时清理 pending update。当前阻断点是：生产 tab strip 实现与同工作区调研/原型的结论相反，且补丁无法直接应用到已经拆分 Terminal Workspace 的最新 `origin/main`。

## 发现

- **P1 严重｜生产 tab strip 正在提交调研明确否决的不可操作方案**：生产代码把条带改为 `overflow-hidden`，同时让 wrapper 与 tab 都使用 `min-w-0 flex-1 basis-0`，却仍常驻 group marker、favicon、MCP badge、padding 和 close button；tab 数增加时固定控件会溢出/重叠，尾部又被裁剪且没有滚动或 Overview 找回入口。工作区调研明确写出“不推荐”这套组合，并把 `320px + 10 tabs` 的成功标准定义为最小宽度、无重叠、active 可见可关。定位：`frontend/src/components/terminal/terminal-browser-tabs.tsx:111,121,131,147-170`；`docs/plans/2026-07-10-terminal-browser-chrome-tab-strip-ux-research.md:15-22,224-268,316-324`。修复方向：不要把 equal-shrink 当成 adaptive strip；要么先保留旧版 `min-w-[76px] + overflow-x-auto` 作为安全过渡，要么一次完成 Phase 1 的 active/inactive minimum、内容降级、overflow viewport 和 active `scrollIntoView`。Overview/Search 可作为下一阶段，但在没有任何找回入口时不能裁掉不可操作的 tab。
- **P1 严重｜当前补丁不能落到目标主分支，Terminal Workspace 改动已基于过期文件归属**：当前 `HEAD=bddf2c6` 落后 `origin/main=b9e9da3` 3 个提交；上游 `d324e0d` 已把 header、session tabs、stage、overlays 等从 `terminal-workspace-shell.tsx` 拆出，而本工作区仍在旧 shell 内抽取 `TerminalProjectTabBar`。把 tracked diff 放到 `origin/main` 快照执行 `git apply --check`，在 `terminal-workspace-shell.tsx:26` 即失败。这不是单纯“稍后解决冲突”：若直接按旧调用点迁移，项目 tab 的 store 订阅和 callbacks 会落错组件边界。定位：`frontend/src/components/terminal/terminal-workspace-shell.tsx:26-87,787-906,1187-1204`；最新主分支实际归属为 `frontend/src/components/terminal/terminal-workspace-header.tsx`。修复方向：先同步最新主分支，再把 `TerminalProjectTabBar` 接入新的 header 边界，删除 header 已不再需要的 project/session/status props，并重新跑完整门禁与页面验收。
- **P2 一般｜“在 opener 右侧插入”和拖拽顺序没有进入 Electron 持久化真相源**：renderer 会把新 tab 插到 opener/active tab 右侧，也只在 Zustand 中处理拖拽；Electron 仍按 `terminalBrowserEntries` 的 `Map` 插入顺序生成持久化记录。Browser 工具重挂载时 `syncElectronTabs()` 会用 Electron 列表整体覆盖 renderer 顺序，应用重启同样恢复为主进程顺序，因此新行为不是稳定契约；调研 Phase 3 也明确要求“重启后顺序一致”。定位：`frontend/src/features/terminal/preview-store.ts:497-550,572-592`；`frontend/src/components/terminal/use-terminal-browser-controller.ts:206-230,422-433`；`electron/src/terminal-browser-view.ts:149-184,790-814`；`docs/plans/2026-07-10-terminal-browser-chrome-tab-strip-ux-research.md:334-342`。修复方向：由 Electron 持有显式 order（或接收 reorder/insert IPC）并按该 order 列表化、落盘和恢复；不要只在 renderer 数组中制造暂态顺序。
- **P2 一般｜跨层真实行为验收尚未闭环，静态门禁覆盖不到本次高风险状态机**：本轮改动同时改变 inactive snapshot/output 缓冲、128 KiB 回退、xterm synchronized output、DOM frame overlay、App Server 桌面弹窗、tab 快速 loading 回摆与多 tab 布局。`pnpm typecheck`/`pnpm lint` 均通过，但不能证明“inactive snapshot → output → 激活”“超过阈值后 REST restore”“空 snapshot”“快速切换 session”“overlay 一定移除”“dev/packaged 不可用→恢复→再不可用”等行为。定位：`frontend/src/components/terminal/use-terminal-output-stream.ts:118-238`；`frontend/src/components/terminal/use-terminal-snapshot-restore.ts:45-126`；`docs/plans/2026-07-09-app-server-health-check.md:69-84`；`docs/plans/2026-07-10-terminal-browser-chrome-tab-strip-ux-research.md:354-370`。修复方向：同步主分支并修完 P1 后，用真实 Electron + `$playwright-cli` 覆盖上述时序和 320/480/expanded × 1/3/6/10/20 tab 矩阵；桌面启动/弹窗用 `$computer-use` 取证。未完成前不要把原型通过或静态门禁写成生产验收通过。
- **P3 提示｜健康检查计划仍引用主分支已删除的计划文档**：`origin/main` 已删除 `docs/plans/2026-07-09-app-server-driven-loop-completion.md`，当前新计划在“非目标”和“关联”两处继续引用，合入后会形成失效链接。定位：`docs/plans/2026-07-09-app-server-health-check.md:29,95`。修复方向：改指当前有效的架构章节/PR，或删除两处关联。

## 已确认修复/成立的部分

- `createTerminalSession()` 现在用 `void window.electronAPI?.checkAppServer?.()` 启动诊断后立即继续请求，健康检查不再串行增加 1～2 秒创建延迟：`frontend/src/services/terminal.ts:73-93`。
- `queueTerminalBrowserTabUpdate()` 在最新状态回到 `lastSentUpdateKey` 时会清理 pending timer，旧报告中的 `A → B → A` 过期状态发送竞态已修正：`electron/src/terminal-browser-view.ts:516-590`。
- `updateBrowserTab()` 增加 device state 结构比较，避免等值 Electron 更新反复触发 Zustand 订阅，方向合理：`frontend/src/features/terminal/preview-store.ts:246-291,631-656`。
- `TerminalProjectTabBar` 用一次 project status selector 替代每个项目对 sessions 的三次扫描，性能方向成立；问题在于需要移植到最新 header 边界，而不是继续修改旧 shell。

## 计划判断与更简替代

Terminal Browser 调研与原型的目标定义、三阶段拆分、最小宽度和全量找回入口是成立的；当前问题不是计划太复杂，而是生产代码只落了一个被计划否决的中间态。更简单、低风险的过渡方案是：本次先不改生产 tab 宽度，保留旧版 `76px minimum + 横向滚动`，只合入与布局无关的节流/等值更新优化；随后把 Phase 1 作为一个可独立验收的完整切片实现。代价是短期体验仍不如原型，收益是不会把“部分实现”变成不可操作回归。

App Server 健康检查复用现有 Electron IPC/主进程 dialog 的职责边界成立，fire-and-forget 也是最短且符合“不阻断”的路径。剩余工作是删除失效文档引用并完成 dev/packaged 真实验收，不需要把诊断状态扩进 backend HTTP 契约。

## 检查范围与结果

- 基线：`HEAD=bddf2c6`；`origin/main=b9e9da3`；本地 `main` 落后 3 个提交。
- 范围：当前 15 个 tracked 修改文件、`TerminalProjectTabBar`、两份计划、adaptive tabs 原型，以及相关 Electron persistence、renderer store、terminal output/snapshot 调用链。
- `git diff --check`：通过。
- `pnpm typecheck`：通过（9 个 workspace 项目）。
- `pnpm lint`：通过（9 个 workspace 项目）。
- `node --check docs/prototypes/terminal-browser-adaptive-tabs/app.js`：通过。
- `mock-state.json` JSON 解析：通过。
- 最新主分支适配检查：失败；tracked patch 无法应用到 `origin/main` 的 `terminal-workspace-shell.tsx`。
- `$playwright-cli` 原型复核：执行。`http://127.0.0.1:6188/?tabs=10&width=320&active=4` 下 10 个 tab 的 inactive/active 宽度为 `44px/80px`，DOM 无 tab slot 重叠，active 在 viewport 内，Overview 与 New Tab 固定可见。这证明原型关键策略可行，但不证明当前生产组件已实现。
- 真实 Web/Electron 生产验收：**未执行**。当前工作区补丁尚未适配最新主分支，且 dev/packaged Electron 的 App Server 状态、终端会话和 WebContentsView 需要主动切换运行态；在 P1 修复前执行无法形成有效合入证据。

## 残余风险

- synchronized output 包装与 DOM frame overlay 在 Canvas/WebGL renderer、alternate screen、空白 snapshot 下的视觉一致性尚未实测。
- App Server 多时机并发检查的 dialog 聚焦、去重与“恢复后再次不可用”语义尚未在真实 macOS Electron 验证。
- prototype README 的 15/15 全矩阵结果本轮只抽查了 `320px + 10 tabs`，其余组合未重新执行。
- 同步最新主分支后，`docs/architecture/app-server-event-center.md` 与上游新增内容仍需重新检查语义冲突。
