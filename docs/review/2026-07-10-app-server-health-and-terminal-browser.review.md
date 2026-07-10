# App Server 健康检查与 Terminal Browser 改动评审

## 结论

当前改动不建议直接合入：未发现 P0，但有 1 个 P1、3 个 P2、1 个 P3。App Server 健康检查复用 Electron IPC 的总体方向成立；Terminal Browser 新增的事件节流存在可导致前端长期停留在过期状态的竞态，应先修复。当前分支还落后 `origin/main` 2 个提交，合入前需基于最新主分支复核文档与前端拆分后的兼容性。

## 发现

- **P1 严重｜节流窗口内的回摆事件会把过期状态发给前端**：`queueTerminalBrowserTabUpdate()` 在新快照等于 `lastSentUpdateKey` 时直接返回，却没有取消已经排队的另一份快照。以 `loading=false(A) → loading=true(B) → loading=false(A)` 为例，第二个 A 不会清掉待发送的 B，定时器随后仍发送 B，导致 UI、持久化状态可能一直显示 loading，直到另一个事件偶然纠正；`canGoBack`、`canGoForward`、MCP 活跃态等字段同样受影响。定位：`electron/src/terminal-browser-view.ts:552-553`。修复方向：当最新快照回到已发送状态时清空 pending/timer；或始终让 pending 代表“当前最新快照”，到期时再与已发送状态比较，保证只提交最新状态。
- **P2 一般｜“仅提示、不阻断”实际会串行拖慢每次终端创建**：前端在发起 `POST /api/terminal/session` 前 `await` Electron 检查；底层 health fetch 单次超时为 1 秒，App Server 可用时默认路径还会经 `getAppServerStatus()` 与 `discoverAppServer()` 做两轮健康读取。因此故障/卡死时终端创建会被同步延迟约 1 秒，健康但响应慢时最坏约 2 秒，与计划的“不阻断”目标不一致。定位：`frontend/src/services/terminal.ts:78-84`、`docs/plans/2026-07-09-app-server-health-check.md:23,31,50,89`、`packages/shared/src/app-server-node.ts:156-173,176-209,226-234`。修复方向：保留当前 IPC，但从创建链路改为 fire-and-forget，并由主进程自行弹窗；若必须保证提示先触发，则给前端等待设置远小于 health 超时的上限，不要让诊断能力成为终端创建的串行依赖。
- **P2 一般｜移除横向滚动和最小宽度后，多 tab 在窄面板中会失去可操作空间**：容器从 `overflow-x-auto` 改为 `overflow-hidden`，tab 与 sortable wrapper 同时改为 `min-w-0 flex-1 basis-0`。在项目允许的 10 个 AI tab 加人工 tab 场景下，每项会继续缩到低于图标、padding、关闭按钮的固定宽度；内容会重叠或被总容器裁剪，且用户没有横向滚动的恢复路径。定位：`frontend/src/components/terminal/terminal-browser-tabs.tsx:111,120-131,163-170,183-186`。修复方向：保留一个可操作的最小 tab 宽度并恢复横向滚动；若产品目标是始终单行等分，则需要 overflow 菜单/固定当前 tab 等明确降级方案，并用最窄窗口 + 10 个 tab 做真实浏览器验收。
- **P2 一般｜计划要求的桌面与页面级真实验收尚无证据，当前只能证明静态门禁通过**：计划明确要求 dev、packaged 两种形态验证不可用弹窗、恢复后重置、终端不阻断，并要求 `$computer-use` 与 `$playwright-cli` 取证；当前工作区没有对应结果记录，且本轮只读评审未停启本机 App Server/Electron，不能把 typecheck/lint 当成行为验收。定位：`docs/plans/2026-07-09-app-server-health-check.md:69-71,79-84`。修复方向：修复上述问题后按计划执行两种形态的真实验证；Terminal Browser 还需补测快速 `start/stop loading` 回摆与窄宽 10-tab 场景，并保存命令、DOM/桌面证据。
- **P3 提示｜计划关联了最新主分支已删除的文档**：当前分支落后 `origin/main` 2 个提交，而 `origin/main` 已删除 `docs/plans/2026-07-09-app-server-driven-loop-completion.md`；新计划仍在“非目标”和“关联”两处引用它，合入后会形成失效链接。定位：`docs/plans/2026-07-09-app-server-health-check.md:29,95`。修复方向：同步最新主分支后改指当前有效架构章节/PR，或删除这两个失效引用。

## 计划方案判断与更简替代

健康检查继续复用 `checkAppServerAvailability()`，通过 preload/IPC 让 Electron 主进程负责桌面弹窗，这个职责边界比让 backend `POST /session` 返回 UI 提示标记更合理，也同时覆盖 dev Electron 与 packaged Electron。

更简单且更符合“诊断不阻断业务”的替代是：保留现有 IPC 设计，但前端调用改为 fire-and-forget。权衡是弹窗可能比终端创建晚几十毫秒出现；收益是 App Server 卡死不会给终端主路径增加 1～2 秒串行延迟，也不需要在 backend HTTP 契约中新增状态字段。若产品硬性要求“弹窗先出现”，再采用有明确短上限的等待，而不是直接等待完整 health timeout。

## 检查范围与结果

- 基线：`HEAD=bddf2c6`；工作分支 `main` 落后 `origin/main=f29981c` 2 个提交。
- 评审范围：当前 10 个已修改文件、1 个未跟踪计划文件，以及受影响的 App Server health、Electron 生命周期、Terminal Browser 状态/持久化与前端 store 调用链。
- `git diff --check`：通过。
- `pnpm typecheck`：通过（9 个 workspace 项目）。
- `pnpm lint`：通过（9 个 workspace 项目）。
- `$computer-use` / `$playwright-cli`：**未执行**。阻塞原因：完整验证需要主动停启本机 App Server、重启 dev/packaged Electron 并改变当前桌面运行态；本轮严格只读评审未做这类运行态操作，因此不把静态检查冒充验收。

## 残余风险

- App Server 不可用弹窗的父窗口聚焦、100ms 延迟与多时机去重仍需在真实 macOS Electron 中确认。
- 新 tab 插入 opener 右侧目前只在 renderer 顺序中体现；Electron 持久化仍按主进程 `Map` 插入顺序保存，重启后的顺序是否符合产品预期需确认。
- 同步最新 `origin/main` 后，`docs/architecture/app-server-event-center.md` 与刚拆分的 terminal workspace 文件需要重新检查冲突与行为归属。
