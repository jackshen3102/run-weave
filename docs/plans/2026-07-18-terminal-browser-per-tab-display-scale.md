# Terminal Browser per-tab 显示缩放收口实施计划

> 状态：按现有 CDP 能力边界重新整理，待重新验收
> 粒度：L2（shared、Electron runtime、受限 CDP Proxy、preload 与 frontend）
> 产品原型：`docs/prototypes/terminal-browser-tool-menu/`
> 配套测试计划：`docs/testing/terminal/terminal-browser-display-scale.testplan.yaml`

## 前提与决策

Terminal Browser CDP Proxy 是受限代理，不是完整 Chromium browser CDP 的透明转发层。本功能必须保留以下既有设计：

- 每条 WebSocket 连接内，一个 `targetId` 最多对应一个 primary proxy target session。
- 同一连接重复 `Target.attachToTarget(targetId)` 是幂等操作，返回该 target 已存在的 primary session。
- Browser group 通过 scoped WebSocket endpoint 限制可见 target；连接不能枚举或附着其它 group。
- `Target.*`、Browser domain、危险导航和输入能力继续经过现有 allowlist、拦截与参数校验。
- 不承诺支持 Playwright `browserContext.newCDPSession(page)` 创建同 target 的第二个 nested session。

因此，Agent 缩放控制使用“scoped root connection → primary target session”，不通过 Playwright nested CDPSession：

```text
Dev Session terminal-browser scoped endpoint
  ├─ $toolkit:playwright-cli attach
  │    └─ 页面导航、DOM、点击、viewport、截图等受支持 Playwright 行为
  │
  └─ 独立 raw CDP root connection
       ├─ Target.getTargets → 只得到当前 Browser group 的 target
       ├─ Target.attachToTarget(targetId) → primary target sessionId
       └─ sessionId + Runweave.*DisplayScale → 目标 Tab 的缩放状态
```

这不是把 CDP 扩展成多 session multiplexing。raw control connection 与 Playwright connection 各自拥有自己的 `CdpSessionManager`；每条连接仍遵守“一 target 一 primary session”。物理 `webContents.debugger` 继续由现有 shared attachment/ref-count 机制复用。

## 当前代码事实

| 领域            | 当前实现                                                                                         | 本计划结论                                                 |
| --------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| Scoped endpoint | `terminal-browser-cdp-proxy.ts` 按 `groupId` 过滤 `/json/list` 和 WebSocket target               | 保留，作为 Agent target 选择的权限边界                     |
| Target session  | `CdpSessionManager` 保存 `targetId -> AttachedTarget.proxySessionId`，重复 attach 返回旧 session | 保留，明确为 primary target session 合约                   |
| Root attach     | `terminal-browser-cdp-proxy-messages.ts` 已支持 root `Target.attachToTarget` 并校验 scoped group | 作为 Agent displayScale 唯一支持入口                       |
| Browser session | `handleBrowserSessionMessage` 只提供受限 Browser/Target 兼容响应                                 | 不增加 browser-session 内的 nested `Target.attachToTarget` |
| Agent 命令      | `handleSessionMessage` 已拦截 `Runweave.get/set/resetDisplayScale`，由 session 解析 target       | 保留；命令体不接受 `targetId`                              |
| Per-tab 状态    | `TerminalBrowserEntry.displayScale` 与 mutation queue 已存在                                     | 保留为主进程权威状态                                       |
| Metrics 组合    | automation metrics、mobile fit 与 displayScale 在单一 service 合成                               | 保留，不把缩放转成页面 CSS 或 Electron page zoom           |
| UI              | 原生 Zoom 子菜单、IPC setter、frontend snapshot/update 已接线                                    | 保留，并按真实 Tab 状态验收                                |

本轮已撤回仅为适配 `newCDPSession(page)` 增加的 browser-session `Target.attachToTarget`/detach 接线；它不属于目标方案。

## 目标

1. 人可以从 Terminal Browser 原生 Zoom 子菜单调整当前 Tab 的显示比例。
2. Agent 可以在 scoped root connection 上附着目标的 primary target session，并读取、设置、重置该 Tab 的显示比例。
3. A Tab 为 80%、B Tab 为 100% 时，两者状态、可见呈现和菜单反馈严格隔离。
4. Playwright 页面操作继续使用现有受支持 page API；displayScale 不改变其逻辑 viewport、CSS 坐标和截图结果。
5. 缩放、设备模式、导航、重连、关闭和重启生命周期有可判定规则。

## 非目标

- 不支持或模拟 Playwright `browserContext.newCDPSession(page)`。
- 不增加同 target 多 logical session registry、event fan-out 或独立 nested detach 生命周期。
- 不把 Terminal Browser CDP Proxy 变成完整 Chromium browser CDP 代理。
- 不允许 browser-level 或 root-level `Runweave.*DisplayScale` 直接携带 `targetId` 修改页面。
- 不使用 `webContents.setZoomFactor`、CSS `zoom`、页面脚本注入或 PNG 后处理。
- 不把 `displayScale` 写入 `terminal-browser-tabs.json`，不做存储迁移。
- 不新增单元测试文件；验收使用格式化 YAML、静态门禁和真实 Electron/Playwright/raw CDP 行为。

## 产品与协议规则

### Per-tab 显示规则

1. 档位固定为 `50%、67%、75%、80%、90%、100%、110%、125%、150%、175%、200%`。
2. 新 Tab、page-open Tab 和 Agent 创建的 Tab 都从 100% 开始。
3. Zoom 父菜单显示当前百分比；子菜单为 Zoom out、Zoom in、分隔线、Reset zoom。
4. 到达最小/最大档位时禁用对应动作；100% 时禁用 Reset zoom。
5. A Tab 的状态不传播到 B Tab、其它窗口或其它 Browser group。
6. 人与 Agent 修改同一 Tab 时，经 per-entry mutation queue 串行处理；最后一个成功请求生效，失败请求不提交状态。
7. displayScale 跨同一 Tab 的导航、隐藏/显示和 CDP connection 重建保留。
8. displayScale 不跨 `WebContents` 生命周期；关闭 Tab 或桌面重启后的恢复 entry 回到 100%。

### Agent primary target session 合约

支持流程固定为：

```text
1. 连接 Dev Session 返回的 scoped terminal-browser WebSocket。
2. root 调用 Target.getTargets，选择当前 group 内的 targetId。
3. root 调用 Target.attachToTarget({ targetId, flatten: true })。
4. 使用返回的 primary sessionId 调用 Runweave.*DisplayScale。
5. 完成后 root 调用 Target.detachFromTarget({ sessionId }) 或关闭连接。
```

扩展命令保持：

```text
Runweave.getDisplayScale({}) -> { factor }
Runweave.setDisplayScale({ factor }) -> { factor }
Runweave.resetDisplayScale({}) -> { factor: 1 }
```

约束：

- 每个 target 在同一 connection 内只有一个 primary session；重复 attach 必须返回相同 sessionId。
- A、B 两个同 group target 可以各自拥有一个 primary session，sessionId 必须分别映射到 A、B。
- `Runweave.*DisplayScale` 只能在有效 primary target session 上调用；root/browser session 调用必须失败。
- 命令参数不接受 `targetId`；target ownership 由 sessionId 决定。
- scoped endpoint 之外的 target attach 必须失败，不能通过猜测 targetId 跨 group。
- 非法档位、额外字段、关闭 target 和未知 session 均 fail closed，且不得改变已有状态。

### Playwright 与 raw CDP 分工

- `$toolkit:playwright-cli` 负责 attach、页面选择、DOM、viewport、locator、mouse、scroll 和 screenshot 取证。
- raw CDP root connection 只负责取得 primary target session 和调用 Runweave custom domain。
- 两条连接必须来自同一个 Dev Session 返回的 scoped endpoint，证据中记录 endpoint、groupId 与 targetId 对应关系。
- 验收不得调用 `page.context().newCDPSession(page)`，也不得用 browser session 模拟第二个 target session。
- raw CDP 操作成功后，必须回到 Playwright/desktop UI 观察页面和菜单结果，不能只把协议返回值当成产品验收。

## 状态与 metrics 组合

`packages/shared/src/terminal-browser-display-scale.ts` 是档位与校验事实源；`electron/src/terminal-browser-display-scale.ts` 是运行时应用事实源。

组合规则保持：

1. 有 Playwright automation metrics 时：保留 width、height、deviceScaleFactor、mobile、screen 与 orientation，只组合 `effectiveScale = rawScale × displayScale`。
2. 有 mobile preset 时：`effectiveScale = mobileFitScale × displayScale`，逻辑 viewport 保持 preset 值。
3. 普通桌面页面在非 100% 时：根据当前 bounds 与 factor 推导逻辑 width/height；100% 时清除额外 desktop override。
4. `Emulation.clearDeviceMetricsOverride` 清除 automation base 后，若 displayScale 非 100%，立即恢复 bounds-derived metrics。
5. 不改写 `Input.*` 的 CSS 坐标；不要求 Agent 手工乘除 factor。
6. `Page.captureScreenshot` 暂时切回 100% 逻辑 metrics，完成后恢复 displayScale；失败也必须执行恢复。
7. metrics mutation 与 displayScale mutation 使用同一 per-entry queue，状态只在 CDP command 成功后提交。

## 文件范围与任务

### 1. 收口 CDP 能力边界

修改：

- `electron/src/terminal-browser-cdp-proxy-session-messages.ts`
- `docs/plans/2026-07-18-terminal-browser-per-tab-display-scale.md`
- `docs/testing/terminal/terminal-browser-display-scale.testplan.yaml`

工作：

- 删除 browser-session 内为 nested `Target.attachToTarget` 增加的临时接线。
- 保留 root `Target.attachToTarget` 与 session-level `Runweave.*DisplayScale`。
- 文档和验收统一使用 primary target session，不再宣称支持 Playwright nested CDPSession。
- 不改变现有 blocked command、safe no-op、group filter 和 connection limit。

验证：

- `git diff` 中 browser-session handler 不再创建或释放 target debugger。
- root attach、重复 attach 幂等、session command、root/browser rejection 均由 TBZ-002 覆盖。

### 2. Shared 与 Electron per-tab runtime

涉及：

- `packages/shared/src/terminal-browser-display-scale.ts`
- `packages/shared/src/terminal-browser-tool-menu.ts`
- `electron/src/terminal-browser-display-scale.ts`
- `electron/src/terminal-browser-runtime.ts`
- `electron/src/terminal-browser-view-lifecycle.ts`
- `electron/src/terminal-browser-device-emulation.ts`
- `electron/src/terminal-browser-proxy-api.ts`
- `electron/src/terminal-browser-view-updates.ts`

工作：

- 保持共享档位、严格校验和 Zoom step helper。
- 保持 entry 初始化 1、关闭时终止 mutation queue、导航/连接重建不重置。
- 保持 automation/mobile/desktop metrics 的单一组合 service。
- 保持并发 last-success-wins 与失败不提交状态。
- list/update payload 始终携带 displayScale；旧 frontend payload 缺失时兼容为 1。

验证：

- TBZ-001、TBZ-003、TBZ-005 至 TBZ-009。
- `pnpm typecheck`、`pnpm lint`。

### 3. Primary target session 的 Agent 命令

涉及：

- `electron/src/terminal-browser-cdp-proxy-messages.ts`
- `electron/src/terminal-browser-cdp-proxy-session.ts`
- `electron/src/terminal-browser-cdp-proxy-session-messages.ts`
- `electron/src/terminal-browser-view.ts`

工作：

- root attach 继续按 scoped group 选择 target，并通过 `CdpSessionManager.attachDebugger` 返回 primary sessionId。
- displayScale custom domain 继续从 sessionId 解析 target；不在 command params 中读取 targetId。
- 重复 attach 不新建 session；detach 释放该 connection 对 target 的 attachment。
- 保持 shared physical debugger attachment/ref-count，不增加 logical session multiplexing。
- Emulation 与 screenshot 仍通过 `CdpSessionManager.sendCommand` 的受控出口组合。

验证：

- TBZ-002 覆盖正向、重复 attach、A/B 映射、跨 group、root/browser session、额外参数与非法档位。
- TBZ-003 至 TBZ-005 用 raw control connection 改 displayScale，用 Playwright 读取页面行为。

### 4. Preload、frontend store 与原生 Zoom 菜单

涉及：

- `electron/src/preload.ts`
- `electron/src/terminal-browser-tool-menu.ts`
- `electron/src/terminal-browser-handlers.ts`
- `frontend/src/App.tsx`
- `frontend/src/features/terminal/preview-store-types.ts`
- `frontend/src/features/terminal/preview-browser-slice.ts`
- `frontend/src/components/terminal/terminal-browser-model.ts`
- `frontend/src/components/terminal/use-terminal-browser-display-scale.ts`
- `frontend/src/components/terminal/use-terminal-browser-controller.ts`
- `frontend/src/components/terminal/terminal-browser-navigation-bar.tsx`
- `frontend/src/components/terminal/terminal-browser-tool.tsx`

工作：

- 原生菜单和 renderer setter 操作同一主进程 entry 状态。
- controller 稳定 handler 使用 `useMemoizedFn`，不引入新的 `useCallback`。
- Agent 修改非 active Tab 时更新对应 snapshot；切换后菜单显示真实百分比。
- IPC/CDP 失败进入现有错误路径，不污染其它 Tab。

验证：

- TBZ-001 与 TBZ-002 的桌面菜单观察。
- frontend harness 只作为静态接线检查，不替代真实 Electron 行为。

### 5. 测试合同与发布门禁

测试计划：

- `docs/testing/terminal/terminal-browser-display-scale.testplan.yaml`

格式验证：

```bash
pnpm testplan:validate docs/testing/terminal/terminal-browser-display-scale.testplan.yaml
```

静态门禁：

```bash
pnpm typecheck
pnpm lint
pnpm build
git diff --check
```

真实验收：

1. 使用 `$toolkit:runweave-dev-session` 从当前 patch 边界解析并启动 Dev Session。
2. 从 `dev:open` 分别取得 desktop 与 terminal-browser scoped surface。
3. 使用 `$toolkit:playwright-cli attach --cdp=<endpoint>` 处理页面行为。
4. 使用同一 scoped WebSocket 的独立 raw CDP connection 获取 primary target session 并调用 Runweave custom domain。
5. 使用 `$toolkit:run-test-cases` 按 YAML 顺序执行；首个失败即停。
6. 验收后关闭本轮 Tab、detach 两类连接、停止 Dev Session 并确认 fixture 清理。

## 完成标准

- TBZ-001 至 TBZ-009 全部 required case 通过。
- Agent displayScale 证据来自 scoped primary target session，而不是 nested Playwright CDPSession。
- 同一 connection 对同 target 重复 attach 返回同一个 sessionId；A/B target 各自映射正确。
- root/browser session、跨 group target、非法参数均失败且无状态副作用。
- 人工菜单、Agent command、Playwright viewport/坐标/截图与生命周期规则一致。
- typecheck、lint、build、testplan validate 与 diff check 通过。

## 风险与控制

| 风险                                    | 控制                                                                                          |
| --------------------------------------- | --------------------------------------------------------------------------------------------- |
| 验收再次隐式使用 `newCDPSession(page)`  | YAML 明确 raw root attach 流程，计划把 nested CDPSession 列为非目标                           |
| raw control connection 选错 target      | 先记录 scoped `Target.getTargets` 的 groupId/targetId，再 attach；command 本身不接受 targetId |
| 同 group A/B 状态串扰                   | A/B 分别取得 primary session，逐次读取菜单、page 与 factor                                    |
| Playwright 与 raw CDP 同时占用 debugger | 复用现有 shared attachment/ref-count；验收后分别 detach 并确认资源归零                        |
| displayScale 污染 viewport 或截图       | TBZ-003 至 TBZ-005 将 raw control 结果与 Playwright 页面结果交叉取证                          |
| 并发请求响应与最终状态不一致            | 所有 mutation 进入 per-entry queue，成功后提交并广播                                          |
| 旧持久化数据受影响                      | displayScale 不写入 tabs store，不新增 schema 字段                                            |

## 回滚

- Agent 命令回滚：移除 `Runweave.*DisplayScale` session handler，不改变 root attach 与其它受限 CDP 行为。
- UI 回滚：移除 Zoom submenu 与 setter，保留其它工具菜单项。
- Runtime 回滚：entry 固定为 1，停止 displayScale metrics composition；磁盘无迁移数据需要清理。
- 不以增加 nested CDPSession 支持作为回滚或临时兼容方案。
