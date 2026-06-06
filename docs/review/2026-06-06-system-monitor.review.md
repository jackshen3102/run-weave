# System Monitor review-only 评审

日期：2026-06-06

范围：

- 已跟踪 diff：`electron/src/application-menu.ts`、`electron/src/main.ts`、`electron/src/preload.ts`、`electron/src/tray.ts`、`frontend/src/App.tsx`、`frontend/src/pages/home/components/home-header.tsx`、`frontend/src/pages/home/index.tsx`、`packages/shared/src/index.ts`
- 未跟踪实现：`electron/src/system-monitor.ts`、`packages/shared/src/system-monitor.ts`、`frontend/src/features/system-monitor/*`、`frontend/src/pages/system-monitor-page.tsx`
- 方案文档：`docs/plans/2026-06-06-mac-system-monitor.md`

评审强度：强力模式。该变更跨 Electron Main、preload IPC、共享协议、React 路由和桌面入口。

## 架构 / 策略发现

### P1 - 全量进程命令行通过普通 renderer IPC 暴露，边界过宽

当前决策：

- 主进程用 `ps -axo pid,ppid,pcpu,rss,command` 采集完整 command line（`electron/src/system-monitor.ts:318-322`）。
- preload 将 `getSystemMonitorSnapshot` 暴露给普通渲染端（`electron/src/preload.ts:51-52`）。
- shared model 和 UI 都把 `command` 当作页面展示字段（`packages/shared/src/system-monitor.ts:9-18`、`frontend/src/pages/system-monitor-page.tsx:143-149`）。

为什么它在系统层面可能是错的：

- `command` 可能包含 token、临时文件路径、内部服务参数、用户目录和业务命令参数。把“整机进程明细”内化到 Runweave 的普通 React renderer，相比现有 runtime stats，隐私和攻击面明显扩大。
- 当前 IPC 没有按 route、sender origin、用户确认或敏感字段脱敏做边界收缩。一旦 renderer 出现 XSS、依赖注入或未来加载了非预期内容，攻击者可以直接调用该 API 读取本机进程快照。
- 这不是单纯实现细节；它改变了 Runweave 从“自身运行时诊断”到“整机系统盘点工具”的责任边界。

更好的候选方案：

- 推荐方案 A：P0 只内置 Runweave 自身诊断，整机诊断提供“打开 Activity Monitor”的入口。交付最快、隐私风险最低，但产品闭环较弱。
- 推荐方案 B：保留 System Monitor，但主进程只返回脱敏后的 appName、pid、cpu、rss、isCurrentApp，默认不返回完整 command；如需查看完整命令，增加显式用户动作、二次确认和按需 IPC。交付成本中等，隐私风险可控。
- 不推荐方案：继续把完整 `command` 作为默认列表字段跨 IPC 返回。交付快，但把敏感本机信息长期暴露给普通页面上下文。

迁移/过渡风险：

- 如果已经依赖 `command` 作为 `appKey` 或详情展示，需要把采样层拆成“聚合标识”和“展示字段”两类数据；旧 UI 的进程详情要改为可选字段或按需加载。
- 如果采用 Activity Monitor 外链，P0 信息密度会下降，需要明确“Runweave 自身诊断”和“整机诊断”的产品边界。

修复方向：

- 先把 shared schema 中的默认 `command` 降级为脱敏 displayName 或 executableName。
- `appKey` 使用不可展示的稳定 key，UI 不直接展示原始命令行。
- IPC handler 增加 sender URL / route 校验，并考虑只允许 Electron 本地 app origin 调用。

### P2 - 菜单/托盘入口复用主窗口，诊断面板会劫持用户当前工作流

当前决策：

- 菜单/托盘入口调用 `openSystemMonitor`，如果主窗口存在，就 `show/focus` 后把同一个 `mainWindow` 导航到 `/system-monitor`（`electron/src/main.ts:627-638`）。
- 首页按钮也直接在当前 React route 内跳转（`frontend/src/pages/home/index.tsx:222-226`）。

为什么它在系统层面可能是错的：

- System Monitor 是诊断面板，不是主工作流。用户从菜单或托盘打开它时，预期更接近“辅助窗口”；当前实现会把正在查看的 terminal、viewer、connections 或其他页面直接替换掉。
- 这类全局入口带有隐藏副作用：从菜单打开诊断工具会改变主窗口导航状态，且没有 return-to-previous-route 机制。对长时间 terminal/session 操作尤其容易造成上下文丢失。

更好的候选方案：

- 推荐方案 A：用独立 singleton `BrowserWindow` 承载 System Monitor。交付成本中等，最符合桌面诊断工具心智，主窗口状态不受影响。
- 方案 B：保留当前 route，但菜单/托盘入口打开新窗口并设置 `initialPath`，首页按钮仍在当前窗口内导航。交付成本较低，副作用边界清晰。
- 不推荐方案：所有入口都复用 `mainWindow` 并强制导航。实现简单，但全局入口和主业务导航耦合过紧。

迁移/过渡风险：

- 独立窗口需要生命周期管理：单例复用、关闭/隐藏策略、主进程退出时销毁、菜单项重复触发聚焦。
- 如果窗口共享 preload IPC，需要确认只暴露该窗口需要的 API，避免进一步扩大 renderer 能力。

修复方向：

- 把菜单/托盘入口改成独立诊断窗口或新窗口 initial path；只让首页显式按钮在当前 SPA 内跳转。
- 至少记录并恢复打开前 route，避免全局入口不可逆地覆盖主工作区。

## 代码 / 实现发现

### P1 - “Memory”排序只在 CPU Top 50 内重排，会漏掉低 CPU 高内存应用

为什么这是风险：

- 方案 P0 明确要求“进程 / 应用 Top N 列表，按 CPU、内存两种维度可切”（`docs/plans/2026-06-06-mac-system-monitor.md:19-26`）。
- 但主进程先把 app 聚合结果按 CPU 排序并截断 Top 50（`electron/src/system-monitor.ts:368-370`）。
- 前端 Memory 按钮只是对已经被 CPU 截断后的 `snapshot.apps` 本地重排（`frontend/src/pages/system-monitor-page.tsx:135-140`、`frontend/src/pages/system-monitor-page.tsx:441-447`）。
- 结果是一个低 CPU 但高内存的 app，如果不在 CPU Top 50，就永远不会出现在 Memory 视图。用户排查“内存吃满”时会看到错误榜单。

具体文件 + 行号：

- `docs/plans/2026-06-06-mac-system-monitor.md:23-24`
- `electron/src/system-monitor.ts:368-374`
- `frontend/src/pages/system-monitor-page.tsx:135-140`
- `frontend/src/pages/system-monitor-page.tsx:441-447`

可执行的修复方向：

- 后端返回 `topAppsByCpu` 和 `topAppsByMemory` 两个集合，或返回 CPU Top N 与 Memory Top N 的 union，再由前端切换。
- 或者让 IPC 接收 `sortKey/limit`，每次按当前维度在主进程排序截断。
- 同步处理 `processes` 的截断策略，否则展开高内存 app 时仍可能没有对应进程详情。

### P2 - 计划文档仍标注“仅设计，不动代码”，需求追溯状态与真实 diff 不一致

为什么这是风险：

- 文档头部写明“草案 / 仅设计，不动代码”（`docs/plans/2026-06-06-mac-system-monitor.md:1-5`），文件落点也写“占位，本期不写代码”（`docs/plans/2026-06-06-mac-system-monitor.md:146-170`）。
- 但工作区已经新增 Electron 采样、IPC、React 页面和 shared 类型。这会让后续 reviewer 或执行 agent 误判当前阶段，以为还没进入实现。
- 对跨 Electron/IPC 的变更来说，计划状态是验收边界的一部分；状态错会降低“需求 -> 设计 -> 实现”的可追溯性。

具体文件 + 行号：

- `docs/plans/2026-06-06-mac-system-monitor.md:1-5`
- `docs/plans/2026-06-06-mac-system-monitor.md:146-170`

可执行的修复方向：

- 把计划状态更新为“实现中/待评审”，并列出已实现、未实现、偏离计划项。
- 如果这份文档只应保留原始计划，新增一份实现说明或验收清单，不要让“仅设计”文档和代码状态混在一起。

### P3 - 暂停状态下刷新按钮无效，控制语义不一致

为什么这是风险：

- `refresh` 只是增加 `refreshToken`，但 effect 在 `params.paused` 为 true 时直接 return（`frontend/src/features/system-monitor/use-system-monitor.ts:20-29`、`frontend/src/features/system-monitor/use-system-monitor.ts:69-74`）。
- 页面始终展示刷新按钮（`frontend/src/pages/system-monitor-page.tsx:347-349`），用户暂停后点击刷新不会采样一次，也没有禁用态或提示。

具体文件 + 行号：

- `frontend/src/features/system-monitor/use-system-monitor.ts:20-29`
- `frontend/src/features/system-monitor/use-system-monitor.ts:69-74`
- `frontend/src/pages/system-monitor-page.tsx:347-349`

可执行的修复方向：

- 明确语义二选一：暂停只停止自动轮询但允许手动刷新；或暂停时禁用刷新按钮。
- 如果保留手动刷新，hook 需要让 `refreshToken` 触发一次采样而不恢复定时轮询。

## 验证摘要

- `git diff --check -- . ':(exclude)docs/review'`：通过。
- `pnpm exec tsc --noEmit --pretty false --project electron/tsconfig.json`：通过。
- `pnpm exec node --test electron/dist/application-menu.test.js`：通过，但运行的是已构建 dist 的现有菜单测试，不覆盖新增 System Monitor 菜单项。
- `pnpm exec tsc --noEmit --pretty false --project frontend/tsconfig.app.json`：失败，错误集中在既有 `react-complex-tree` 依赖/类型缺失相关文件；未能作为本次前端变更的完整验证证据。
- 本机命令抽样：`ps -axo pid,ppid,pcpu,rss,command`、`memory_pressure`、`sysctl -n vm.swapusage`、`pmset -g batt` 输出形态与采样器的大体假设一致，但未覆盖所有 macOS 版本差异。

## 剩余风险 / 测试缺口

- 缺少对 `parsePsOutput`、`parseVmStatUsedMb`、`parseBattery`、排序截断策略的 Electron 端测试或样本验证。
- 缺少 Electron 打包后 `browser-viewer://app/system-monitor` 深链与菜单/托盘入口的手工验证证据。
- 前端全量 typecheck 当前被既有依赖问题阻塞，无法确认新增页面没有隐藏类型回归。
