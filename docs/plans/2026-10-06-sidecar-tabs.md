# 右侧面板 Tab 自定义方案

状态：已获用户确认并实施；原生合成窗口浮层验收尚待可用的 Computer Use 环境。

来源：随记 `e91bb65f-3ea8-4846-8294-37d648519143`，2026-10-06 读取 version 1；全部跟进 0 条、附件 0 个。

## 目标与推荐方向

右侧一级工具栏支持显示/隐藏、横向拖拽排序；默认只显示 Browser 1，需要时再显示 Browser 2/3。沿用现有三个独立 Browser Profile，改变入口呈现，不改变浏览器数据和运行生命周期。

本方案把“拖拽”解释为一级 Tab 排序，不包含拖出独立窗口、跨面板停靠或分屏。范围是共用 React Sidecar 的 Web/Electron；不改原生 iOS。Web 继续保留现有 Browser 能力边界。

## 当前代码事实

- `frontend/src/components/terminal/preview/panel/shell.tsx` 固定拼装 Preview、Automation、Browser 1/2/3、Agent Team、Race、任务交接、会话阅读；Automation 仅 Electron 可用，Agent Team 受现有条件控制。当前没有入口显隐和排序偏好。
- `frontend/src/features/terminal/preview/store.ts` 管理 activeTool、activeBrowserProfileId 和各 Profile 的页面快照；目前只持久化预览项目状态，宽度单独保存，没有持久化 Tab 布局。
- `packages/shared/src/browser/profile.ts` 为三个 Profile 定义独立持久化 partition 与代理存储。它们不是同一个浏览器中的三个网页标签，不能通过合并 Profile 简化入口。
- `frontend/src/components/ui/sortable-tabs.tsx` 已有横向排序组件，拖动阈值为 8px，可复用。
- `frontend/src/features/terminal/navigation/open-browser.ts` 根据显式 Profile、Worktree 偏好、全局默认解析目标；随记和 Worktree 等入口会触发 Browser 激活。布局偏好不能改变这条选择规则。

以上结论来自当前源码，未做运行态或 UI 验收。收起两个入口不等于减少两个浏览器进程，本方案不承诺 CPU/内存收益。

## 用户可见行为

### 显示与隐藏

1. 工具栏右端增加始终可见的“管理标签”按钮，不随工具栏横向滚动消失。菜单列出当前宿主可用的一级工具，勾选控制显示，并提供“恢复默认布局”。Browser 2/3 在同一菜单中唤起，不增加第二套设置入口。
2. 取消勾选只隐藏入口；不关闭 Browser 页面、不清登录态、不停止 Agent Team/Race/自动化任务。具体工具仍沿用既有非激活生命周期。
3. 隐藏当前项时，优先选排序中右侧可见可用项，没有则选左侧；通过现有激活动作切换，保证会话阅读目标和 Browser Profile 一起正确更新。
4. 至少保留一个可见且可用项；最后一项的隐藏操作禁用并说明原因。能力变化或损坏配置导致可见列表为空时，恢复 Preview 为兜底。
5. 菜单里的勾选只改变显隐；另外提供隐藏项的“打开”动作，显示并激活该项。恢复默认布局时保留当前项（如仍可见），否则按上述规则回退。

### 拖拽排序

1. 拖动一级 Tab 横向排序，Browser 1/2/3 各自是一个可排序项；普通点击仍只切换工具。
2. 复用现有 8px 拖拽阈值；完成拖动不额外触发点击，取消拖动或落在列表外不保存变化。
3. 只重排当前可见项：把重排结果填回完整顺序中原来可见项的位置，隐藏项保留自己的槽位。再次显示时位置可预测。
4. 管理菜单提供“前移/后移”作为键盘操作替代；两端按钮禁用。窄面板保持工具栏横向滚动，管理按钮始终可达。

### Browser 按需出现

1. 无布局偏好时，按当前顺序保留所有原有非 Browser 工具，只默认隐藏 Browser 2/3，Browser 1 保留明确编号，避免显示数量变化造成身份误认。
2. “管理标签 → Browser 2/3 → 打开”恢复对应入口并进入原 Profile；已存在页面、Cookie、代理和 Worktree 绑定保持不变。
3. 文件预览、会话阅读、随记链接或 Worktree Browser 等显式导航命中隐藏工具时，原子地显示并激活目标，保存该项可见偏好；用户随后仍可手动隐藏。
4. 只有实际导航/激活才恢复显示。后台状态订阅、计数变化、普通快照同步不主动重开隐藏 Tab；后台 CDP 工作继续遵守原有显示合同。
5. 不扫描历史 Browser 页面来自动展开所有 Profile，不新增 Profile，不改 Profile 默认值和解析优先级，不自动启用代理。

## 状态与接口

这是 renderer 本机布局偏好，不新增 Backend API 或 Electron IPC，不迁移共享 Browser DTO。

新增前端本地类型：`SidecarTabId = Exclude<TerminalSidecarTool, "browser"> | TerminalBrowserProfileId`。Profile ID 可直接复用 `profile-1/2/3`，不使用标签文字或数组下标作为身份。

布局格式：`{ version: 1, order: SidecarTabId[], hidden: SidecarTabId[] }`。存储键建议 `runweave.terminal.sidecar.tabs.v1`，通过 `deviceStorage` 白名单注册。作用域沿用设备本地 storage：同一 origin/Electron userData 内跨项目共用，不做云同步，不跨 Stable/Beta 或浏览器 origin 强行共享。

- 纯布局模块提供 `normalizeLayout`、`reorderVisibleTabs`、可见项计算及当前项回退计算；不保存页面、URL、token 或任务状态。
- Preview store 增加布局状态与 `setTabVisible`、`reorderTabs`、`resetTabLayout`；激活动作内部统一确保目标可见。覆盖 `openPreview/openFile/openConversation/openAutomation/openAgentTeam/openRace/openBrowser/activateBrowser/setActiveTool`；`selectChange` 同时用于后台 Diff 同步，保持纯状态更新，避免只改工具栏点击。
- 当前 Browser 对应 Tab 由 `activeTool === browser` 加 `activeBrowserProfileId` 推导，不再保存一份独立 activeTab。
- 能力可用性与用户偏好分开：Web 不显示 Automation，但不能在归一化时删掉其顺序和偏好；同理处理暂不可用的 Agent Team。
- 读取时验证版本、类型、ID，去重、过滤未知 ID、补全缺失项。缺失新项采用其注册默认显隐；非法 JSON/版本回退默认布局。首次升级不改现有预览持久化数据。
- 存储失败时保持本轮内存操作有效，提示“布局未能保存，重启后可能恢复”；不清理其他 storage 数据，不循环重试。
- 回滚只需旧 renderer 忽略新增布局键，恢复固定工具栏；无服务端数据迁移，无浏览器数据清除。

## 实施拆分与文件职责

1. 新增 `frontend/src/features/terminal/preview/sidecar-layout.ts`：Tab 注册、默认值、布局归一化、排序与回退规则；在 `store-types.ts` 声明相关状态/动作，在 `store.ts` 接入激活及持久化。同步注册 `frontend/src/features/device-storage/index.ts` 的键。
2. 新增 `frontend/src/components/terminal/preview/panel/tool-tabs.tsx`：提取工具栏渲染、管理菜单与拖拽。在 `shell.tsx` 接入，在 `index.tsx` 的 Agent Team 不可用回退处统一走新规则。复用 `useConversationTool`，不绕过会话目标初始化。
3. 复用 `frontend/src/components/ui/sortable-tabs.tsx`，仅在现有行为不足时作必要兼容增强；如改公共组件，要回归现有网页 Tab 排序。菜单使用公共 DropdownMenu/Popover。DragOverlay 如可能进入网页区域，按 `frontend/docs/overlay-coordination.md` 登记实际浮层；业务禁止直接调用 Browser hide/show。
4. 审计 Browser controller 的 Profile 解析完成后状态更新和所有 store 激活调用方，确保最终解析出的 Profile 可见；不把后台状态同步当成导航。重点复核 `frontend/src/features/suiji/browser-navigation.ts` 和 `frontend/src/components/terminal/workspace/worktree-rail.tsx`。
5. 实施获确认后，更新已有 `docs/testing/terminal/browser/multi-profile-whistle.testplan.yaml` 的 TBMP-001：将“始终展示三个入口”改为默认一个、按需显现，但保留固定 ID、代理映射和 Worktree 切换不重建 Profile 的断言。本轮保留旧文件，避免方案被误认为已实现。

## 验收与验证方式

配套目标行为：[sidecar-tabs.testplan.yaml](../testing/terminal/sidecar-tabs.testplan.yaml)。这是待实施后的验收合同，本轮只校验格式。

实施后先运行 `pnpm --filter @runweave/frontend typecheck`、`pnpm --filter @runweave/frontend lint`；若新增键触及配置治理，再运行 `pnpm configuration:check`，修复与本改动相关的问题。文档变更运行 `pnpm docs:check`。

通过 `$toolkit:runweave-dev-session` 获取受管环境，用 `$toolkit:playwright-cli` 在真实 Web/Electron 工具栏执行配套用例。Electron 菜单和拖拽覆盖到原生网页时，还需观察合成窗口与真实输入命中；DOM 截图不能证明原生层未挡住菜单。

现有 Browser Profile 隔离回归引用 multi-profile-whistle 的 TBMP-002/003/004；浮层回归引用 [overlay-coordination.testplan.yaml](../testing/terminal/browser/overlay-coordination.testplan.yaml)，随记导航引用 [desktop-browser-reuse.testplan.yaml](../testing/suiji/desktop-browser-reuse.testplan.yaml)。不新增单元测试。

通过标准：隐藏和拖拽不丢业务状态；刷新后布局一致；Browser 2/3 可达且身份不变；显式导航无不可见 active Tab；不可用工具无死入口；菜单与拖拽不被原生网页挡住。任一不满足即不能宣称功能验收通过。

## 风险和建议取舍

主要风险是把入口隐藏误接成 Browser 销毁，以及只接点击、漏掉外部导航。通过独立布局状态、统一激活和既有 Profile 合同限制改动范围。

另一个可选方向是永远只保留一个 Browser Tab，在内部切 Profile。它能进一步压缩工具栏，但会让多 Profile 用户多一层切换，也不能把 Browser 2 单独拖到喜欢的位置。当前需求更适合“默认一个，另外两个按需显示”；建议先确认并实施本方案，不引入第二套 Profile 导航。
