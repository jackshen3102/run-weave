# Terminal Browser 存活 Tab 最小视口宽度实施计划

> 状态：需求已完成 grilling，待实现
> 粒度：L3（跨 shared、Electron 原生 View、renderer、CDP metrics 与真实桌面验收）
> 代码基线：`feat/terminal-worktree-reliability@44d217b0`
> 配套测试计划：`docs/testing/terminal/browser/minimum-viewport-width.testplan.yaml`

## 结论

本轮为右侧 Terminal Browser 增加桌面网页的 **CSS 逻辑最小视口宽度**。固定档位为
`Auto / 768px / 1024px / 1440px`；设置只属于当前存活的 Browser Tab，与 Zoom 一样跨导航、
隐藏和 Tab 切换保留，但不写入 `terminal-browser-tabs.json`，关闭 Tab 或完整应用重启后回到
`Auto`。

该能力不是调整 Sidecar 自身宽度，也不是给任意网页注入 `min-width` CSS。Sidecar 继续按现有
`320px～窗口宽度 60%` 规则拖拽；当网页画布的可见宽度小于所选最小宽度时，Runweave 用原生
`View` 裁剪一个更宽的 `WebContentsView`，并在 Browser 画布底部提供横向滚动。Tab、地址栏、
Browser 工具栏以及 Comments、Headers、Device 等工具面板不参与横向滚动。

最小宽度以 CSS 逻辑像素计量，与 Zoom 独立。页面的 `window.innerWidth`、媒体查询、CDP 布局
指标和 Agent 截图看到同一份不低于所选档位的逻辑视口；人类横向滚动只改变 Electron 面板中
当前可见的切片，不改变 Agent 坐标系。

## 实现前工作区边界

当前工作区已有用户改动，至少涉及：

- `docs/architecture/terminal-code-preview.md`
- `electron/src/preload.ts`
- `electron/src/browser/handlers.ts`
- `electron/src/browser/security/network.ts`
- `electron/src/browser/profile/runtime.ts`
- `frontend/src/components/terminal/browser/header/profile-status.tsx`
- `packages/shared/src/desktop/bridge.ts`
- `packages/shared/src/browser/profile.ts`

实现者必须保留这些改动。修改重叠文件前重新读取 `git diff`，只做语义合并；不得 restore、覆盖、
格式化整文件或把无关 Profile/Whistle 代码纳入本功能提交。

## 当前代码事实

| 领域         | 当前实现                                                                                              | 本计划判断                                                                                |
| ------------ | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Sidecar 宽度 | `preview-store.ts` 与 `panel-actions.ts` 将面板限制在 `320px～60vw`，并单独持久化面板宽度             | 保持不变；本功能设置网页逻辑宽度，不设置 Sidecar 最小宽度                                 |
| 原生页面     | 每个 Tab 是直接挂到 `BrowserWindow.contentView` 的 `WebContentsView`，renderer DOM 只提供 bounds 锚点 | 增加原生 `View` 裁剪父容器；不能让超宽子 View 覆盖左侧 Terminal                           |
| Bounds       | renderer 发送 `{x,y,width,height,emulationScale}`，主进程将其直接设为 `WebContentsView` bounds        | 外层 bounds 表示可见裁剪区；主进程根据 Tab 状态计算子 View 宽度并应用 `horizontalOffsetX` |
| Zoom         | `displayScale` 是存活 Tab 级 runtime 状态；普通桌面通过 CDP metrics 组合，关闭或重启回到 `1`          | 最小宽度复用同一 metrics mutation queue 和生命周期，不新增持久化 schema                   |
| Device       | Desktop 无固定 viewport；三个移动预设固定宽高并由 renderer 计算 fit scale                             | 手机模式暂时忽略最小宽度，切回 Desktop 后恢复原选择                                       |
| 自动化       | CDP Proxy 拦截 automation metrics、截图和 layout metrics，与 displayScale 在主进程统一组合            | 最小宽度进入同一组合函数；不注入页面 CSS，不改写 Agent 输入坐标                           |
| Tool menu    | Electron 原生 More 菜单已有 Zoom 子菜单与 Device Mode                                                 | 在 Zoom 相邻位置增加 `Minimum Width · …` 单选子菜单，不增加常驻按钮                       |
| Workspace    | Electron live snapshot/update 携带 Device 与 Zoom；持久化文件只保存 Tab/Group 页面元数据              | live payload 增加最小宽度；持久化 record 不增加字段                                       |

关键入口：

- `packages/shared/src/browser/workspace.ts`
- `packages/shared/src/browser/display-scale.ts`
- `packages/shared/src/browser/tool-menu.ts`
- `packages/shared/src/desktop/bridge.ts`
- `electron/src/browser/runtime.ts`
- `electron/src/browser/view/lifecycle.ts`
- `electron/src/browser/view/attachment.ts`
- `electron/src/browser/view/helpers.ts`
- `electron/src/browser/device/display-scale.ts`
- `electron/src/browser/device/emulation.ts`
- `electron/src/browser/view/updates.ts`
- `electron/src/browser/handlers.ts`
- `frontend/src/features/terminal/preview/store-types.ts`
- `frontend/src/features/terminal/preview/browser-slice.ts`
- `frontend/src/components/terminal/browser/controller/use-controller.ts`
- `frontend/src/components/terminal/browser/controller/use-bounds.ts`
- `frontend/src/components/terminal/browser/controller/surface.tsx`
- `frontend/src/components/terminal/browser/header/navigation.tsx`

## 目标

1. 用户可在当前 Browser Tab 上选择 `Auto / 768 / 1024 / 1440px`，新 Tab 固定从 `Auto` 开始。
2. 面板不足时页面仍按至少所选 CSS 宽度布局，并可通过 Browser 画布横向滚动查看全部区域。
3. 超宽原生页面严格裁剪在 Browser 画布内，不能覆盖或截获左侧 Terminal 与 Browser 工具栏输入。
4. 最小宽度、Zoom、Device Mode、Comments/Headers 工具面板和 Sidecar resize 使用一套确定的组合规则。
5. 页面、Agent/CDP、媒体查询、截图和输入坐标使用同一个逻辑视口事实。
6. 状态严格属于存活 Tab，不进入磁盘持久化，不产生 schema 迁移或历史数据清理。

## 非目标

- 不改变 Sidecar 的最小值、最大值、默认值、拖拽方式或 `runweave.terminal.sidecar.width.v1`。
- 不提供任意数字输入、拖拽式网页宽度、`1280px`、`1920px` 或高度档位。
- 不给网页注入 `html/body { min-width: ... }`，不使用 CSS `zoom`、`transform` 或截图后处理。
- 不把最小宽度写入 `terminal-browser-tabs.json`，不升级持久化 schema，不恢复已关闭 Tab 的值。
- 不新增 `Runweave.get/set/resetMinimumWidth` CDP 自定义命令；Agent 能观察该视口，但本轮只允许人从原生菜单修改。
- 不改变页面自身的纵向/横向滚动状态；Browser 画布横移是宿主裁剪偏移，不写入 `window.scrollX`。
- 不拦截任意网页内部的横向滚动手势；首版通过 Browser 画布底部滚动轨道控制宿主横移。
- 不改变移动设备预设的宽、高、User-Agent、touch emulation 或 fit-scale 规则。
- 不新增单元测试、Vitest、Node test、`*.spec.*` 或 `*.test.*` 文件。
- 不生成 Windows 安装包；真实验收只覆盖当前 macOS Electron 客户端。

## 用户可见行为合同

### 1. 菜单与档位

1. More 菜单中在 Zoom 相邻位置显示 `Minimum Width · Auto` 或当前像素值。
2. 子菜单固定四个单选项：`Auto`、`768 px`、`1024 px`、`1440 px`；当前项 checked。
3. 选择同一项是幂等操作；选择成功后菜单关闭，重新打开时立即显示真实 Tab 状态。
4. A Tab 的选择不能传播到 B Tab、其它 Profile、其它 Browser Group 或其它 Electron 窗口。
5. 手工新建、page-open、scoped/unscoped CDP 创建和恢复 materialize 的新 `WebContentsView` 都从 `Auto` 开始。
6. 非 Electron Web/PWA 不伪造可用状态；保持现有 Local browser unavailable 降级。

### 2. 桌面布局与横向滚动

1. `Auto` 完全保留当前行为：逻辑宽度跟随 Browser 画布可见宽度，不显示宿主横向滚动轨道。
2. 选中固定档位后，逻辑宽度为 `max(当前 Auto 逻辑宽度, 所选最小宽度)`。
3. Browser 画布物理可见宽度足够时不显示横向滚动轨道，页面继续填满可见区域。
4. 可见宽度不足时，只在 Browser 页面画布底部显示横向滚动轨道；Tab、地址栏和外层工具栏固定。
5. 横向滚动只改变原生子 View 相对裁剪父 View 的负 `x` 偏移；页面 `window.scrollX` 不随之变化。
6. 切换到另一个 Tab 再回来保留该 Tab 的宿主横向位置。
7. 切换最小宽度档位、地址栏导航或观察到当前 Tab URL 变更时回到最左侧。
8. 使用现有 Reload 刷新同一页面时保留宿主横向位置。
9. Sidecar resize、窗口 resize、展开/还原和工具面板开关后，滚动上限立即重算；旧 offset 超限时 clamp，不留空白区。
10. 当不再存在 overflow 时隐藏滚动轨道并把 offset 归零。

### 3. Zoom 组合

最小宽度的单位是 CSS 逻辑像素；Zoom 只改变显示比例。普通 Desktop、无 automation metrics 时：

```text
visibleWidthDip = Browser 画布可见宽度
factor = 当前 displayScale
minimum = Auto 时为 null，否则为 768 / 1024 / 1440

contentWidthDip = mobile
  ? visibleWidthDip
  : max(visibleWidthDip, (minimum ?? 0) * factor)

logicalWidthCss = contentWidthDip / factor
```

约束：

- `logicalWidthCss >= minimum`，且 `minimum` 不随 50%～200% Zoom 改变。
- 80% Zoom 可能让 `contentWidthDip` 小于可见宽度，因此无需 overflow；150% Zoom 会扩大物理滚动范围。
- 计算统一使用 shared helper 并在最终 Electron bounds 处取整、clamp；renderer 和主进程不得复制不同公式。
- 高度始终来自当前 Browser 画布可用高度；没有 minimum height，也不从宽度档位推导高度。

### 4. 工具面板与 Device Mode

1. Comments、Request Headers、Device 面板占用的 `320px` 不计入网页可视宽度。
2. 工具面板固定在右侧，不随 Browser 画布横向移动；开关时只重算页面 overflow 和 offset 上限。
3. 进入 iPhone SE、iPhone 14 或 Pixel 7 后，保存当前 Desktop 最小宽度选择但暂时不应用，不显示宿主横向滚动轨道。
4. 移动模式继续使用完整宽高、device scale factor、UA、touch 与既有 fit scale。
5. 切回 Desktop 后重新应用原选择并按当前可见宽度决定是否 overflow；若产生 overflow，从最左侧开始。

### 5. Agent/CDP 语义

1. Desktop 下页面 `window.innerWidth`、媒体查询和 `Page.getLayoutMetrics` 不得低于所选最小宽度。
2. 外部 automation `Emulation.setDeviceMetricsOverride` 请求的 width 小于所选 minimum 时，发送给 Chromium 的有效 width 被 clamp 到 minimum；大于 minimum 时保留原 width。
3. `Emulation.clearDeviceMetricsOverride` 后恢复当前 minimum + displayScale 的 Desktop metrics，而不是错误回到窄 Auto viewport。
4. `Page.captureScreenshot` 在暂时去除 displayScale 时仍保留 minimum；viewport screenshot 覆盖完整逻辑视口，不按人类当前横向 offset 裁切。
5. Agent 的 locator、mouse、touch 和 `Input.*` 保持 CSS 坐标语义；不加减宿主 `horizontalOffsetX`。
6. 人类在被裁剪 View 上点击时，由原生父子 View 坐标转换命中当前可见内容，不允许 renderer 手工注入页面点击。

## 状态与共享合同

### 1. Shared 最小宽度模块

新增 `packages/shared/src/browser/minimum-width.ts`，并在 `package.json#exports` 与
`src/index.ts` 导出。建议合同：

```ts
export const TERMINAL_BROWSER_MINIMUM_VIEWPORT_WIDTHS = [
  768, 1024, 1440,
] as const;

export type TerminalBrowserMinimumViewportWidth =
  | (typeof TERMINAL_BROWSER_MINIMUM_VIEWPORT_WIDTHS)[number]
  | null;

export interface TerminalBrowserMinimumViewportWidthState {
  width: TerminalBrowserMinimumViewportWidth;
}

export function isTerminalBrowserMinimumViewportWidth(
  value: unknown,
): value is TerminalBrowserMinimumViewportWidth;

export function getTerminalBrowserContentWidth(
  visibleWidth: number,
  minimumWidth: TerminalBrowserMinimumViewportWidth,
  displayScale: number,
  mobile: boolean,
): number;
```

`null` 是唯一的 Auto 表示；不使用 `0`、`undefined`、字符串或 magic number。helper 对非有限值不做
宽松转换，最终返回至少 `1` 的整数 DIP。

### 2. Live workspace 与 renderer 状态

`TerminalBrowserUpdate`、`TerminalBrowserTabSnapshot` 和 `TerminalBrowserTabState` 增加：

```ts
minimumViewportWidth: TerminalBrowserMinimumViewportWidth;
```

规则：

- Electron `TerminalBrowserEntry` 是该字段的权威；frontend 只乐观展示 IPC 成功返回的状态。
- Electron 旧/缺失 live payload 在 frontend normalize 为 `null`，避免热更新期间崩溃。
- dormant tab snapshot、fallback tab 和任意新 entry 都返回 `null`。
- `getTerminalBrowserUpdateKey()` 包含该字段，成功修改必须产生有 revision 的 tab event。
- `scrollLeftByTabId` 只属于 renderer 的存活 UI 状态，不进入 shared snapshot、Electron workspace 或磁盘。

### 3. Bridge 与 IPC

扩展 `packages/shared/src/desktop/bridge.ts`：

```ts
export interface TerminalBrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  emulationScale?: number;
  horizontalOffsetX?: number;
}

terminalBrowserSetMinimumViewportWidth(
  tabId: string,
  width: TerminalBrowserMinimumViewportWidth,
): Promise<TerminalBrowserMinimumViewportWidthState>;
```

IPC channel 为 `terminal-browser:set-minimum-viewport-width`。主进程必须：

- 从 `event.sender` 解析所属 `BrowserWindow`，按窗口和 tabId 查找 entry；
- 仅接受 `null / 768 / 1024 / 1440`，拒绝 `1280`、负数、字符串、NaN 与额外结构；
- 在统一 metrics queue 内应用，失败时恢复旧值，不发送假成功 snapshot；
- 成功后发送 tab update；不调用 `scheduleTerminalBrowserTabsSave()` 以外的 schema 写入逻辑，persisted record 仍不含该字段。

`horizontalOffsetX` 由主进程按 `0..contentWidth-visibleWidth` clamp。renderer 不发送 `contentWidth`，
主进程使用 shared helper 和 entry 的 minimum/device/displayScale 自行计算，避免不可信 renderer 创建任意
尺寸的原生子 View。

### 4. 原生 View 层级

每个 `TerminalBrowserEntry` 增加一个普通 Electron `View` 作为裁剪容器：

```text
BrowserWindow.contentView
  └─ entry.viewportView            // bounds = Browser 画布可见矩形
       └─ entry.view: WebContentsView
            // bounds = {-horizontalOffsetX, 0, contentWidth, visibleHeight}
```

生命周期规则：

- 创建 entry 时先把 `WebContentsView` 加到 `viewportView`，但仍保持隐藏。
- attach/detach、z-order、visible 与 root `contentView` 操作针对 `viewportView`；页面加载、CDP、DevTools、
  annotation 与网络继续针对 `entry.view.webContents`。
- close 时从 root 移除 `viewportView`，终止 metrics queue，再关闭 `entry.view.webContents`；不能留下空父 View
  截获点击。
- `clampTerminalBrowserBounds()` 只 clamp 外层可见矩形到主窗口 content bounds；子 View 允许宽于父 View，
  但宽度只能由受校验的 minimum 和 displayScale 公式产生。
- 真实 Electron 33 验收必须证明父 View 会裁剪子 View。若出现页面覆盖 Terminal、工具栏或相邻面板，立即停止；
  不得以超宽 direct child、页面 CSS 注入或透明遮罩作为降级发布。

### 5. Metrics 组合

在 `electron/src/browser/device/display-scale.ts` 中把 minimum 作为与 automation/mobile/displayScale 同级的
输入，继续由一个 mutation queue 串行化：

1. UI mobile preset：保持既有 fixed viewport，不应用 minimum。
2. automation metrics：保留原 height、deviceScaleFactor、mobile、screen、orientation 等字段，只把有效 width
   设为 `max(raw width, minimum ?? raw width)`，并继续组合 raw scale × displayScale。
3. 普通 Desktop：Auto + 100% 时仍可 clear metrics；存在 minimum 时即使 Zoom 为 100% 也必须保留 metrics override。
4. `canReleaseMetricsDebugger()` 只有在 Zoom=100%、Desktop、无 automation metrics 且 minimum=Auto 时才能释放。
5. 选择 minimum、更新 bounds、切换 Device、改变 Zoom、automation set/clear、截图和 layout metrics 都通过同一
   queue，任何命令失败都恢复最后一次成功状态。
6. screenshot/layout 临时使用 100% displayScale 时不能清除 minimum；finally 必须恢复完整有效 metrics。

不修改 CDP `Input.dispatchMouseEvent` 现有 displayScale 坐标转换；minimum 和宿主 offset 不进入 Agent CSS 坐标。

## Renderer 设计

### 1. 菜单接线

- `TerminalBrowserToolMenuRequest` 携带当前 `minimumViewportWidth`。
- Electron 原生菜单增加 radio submenu；action 使用封闭 union 映射四个合法值，不返回任意 number。
- `navigation-bar.tsx` 处理 action 后调用新的 `use-minimum-viewport-width.ts` 稳定 handler。
- hook 使用 `useMemoizedFn`；IPC 成功后更新目标 Tab，失败写入现有 `tab.error`，不能影响其它 Tab。
- 成功切档后通知 viewport hook 将该 Tab offset 归零并立即同步 bounds。

### 2. 横向画布

在 `surface.tsx` 与 `use-bounds.ts` 之间增加明确的 desktop viewport 模型；可新建
`frontend/src/components/terminal/browser/use-horizontal-viewport.ts` 承载：

- `scrollLeftByTabId` 与上一 URL 映射；
- 根据 shared helper 派生 `contentWidth`、`maxScrollLeft` 和 `overflowing`；
- 处理 Tab 切换保留、切档/导航归零、reload 保留、resize clamp；
- 把可见 bounds 与 `horizontalOffsetX` 交给 `use-bounds.ts`；
- 对已关闭 Tab 删除 ref 状态。

`surface.tsx` 在 desktop overflow 时渲染一个有可访问名称的底部横向滚动容器和等宽 spacer；滚动事件只更新
宿主 offset。滚动轨道占用 Browser 页面画布底部的固定小高度，不能覆盖工具栏；无 overflow 或 mobile 时不渲染。
不得在整个网页区域铺透明 renderer overlay，否则会阻断原生页面点击、选择和输入。

`use-bounds.ts` 的 bounds key 必须包含 outer bounds、`horizontalOffsetX`、minimum、displayScale 和 mobile 状态，
确保仅 Zoom/切档/滚动而 DOM rect 不变时也会发出更新；继续使用 requestAnimationFrame 合并高频滚动，不为每个
pointer pixel 无限制调用 IPC。

## 文件范围与执行步骤

### 任务 0：保护现有工作区

- [ ] 记录 `git status --short` 与重叠文件 diff；确认当前 Profile proxy 改动仍在。
- [ ] 实现期间只 stage 本功能文件；不恢复、重写或提交用户的既有改动。
- [ ] 若 shared bridge、preload、handlers、架构文档发生重叠，按语义合并后再次对比原 diff。

### 任务 1：建立 shared 合同与 live 状态

新增：

- `packages/shared/src/browser/minimum-width.ts`
- `frontend/src/components/terminal/browser/device/use-minimum-width.ts`

修改：

- `packages/shared/package.json`
- `packages/shared/src/index.ts`
- `packages/shared/src/browser/workspace.ts`
- `packages/shared/src/browser/tool-menu.ts`
- `packages/shared/src/desktop/bridge.ts`
- `frontend/src/features/terminal/preview/store-types.ts`
- `frontend/src/features/terminal/preview/browser-slice.ts`
- `frontend/src/components/terminal/browser/controller/model.ts`

完成条件：所有新/缺失 snapshot 都有确定的 `null` 默认值，invalid width 无法穿过 shared/IPC 校验；
`terminal-browser-tabs-state.ts` 与持久化 record 无变化。

### 任务 2：把 WebContentsView 放入原生裁剪容器

修改：

- `electron/src/browser/runtime.ts`
- `electron/src/browser/view/lifecycle.ts`
- `electron/src/browser/view/attachment.ts`
- `electron/src/browser/view/helpers.ts`
- `electron/src/browser/handlers.ts`

可新增：

- `electron/src/browser/device/viewport-layout.ts`

完成条件：outer viewport 永远在 Browser 画布内；子 View 可按公式变宽和负向移动；attach、hide、close、fallback、
profile 切换与窗口关闭无空 View、无跨区域点击拦截。

### 任务 3：组合 minimum、Zoom、Device 与 CDP metrics

修改：

- `electron/src/browser/device/display-scale.ts`
- `electron/src/browser/device/emulation.ts`
- `electron/src/browser/view/updates.ts`
- `electron/src/browser/workspace/index.ts`
- `electron/src/browser/view/lifecycle.ts`
- 必要的 `electron/src/terminal-browser-cdp-proxy-*.ts` 受控 metrics 出口

完成条件：Desktop logical width floor、mobile 暂停、automation clamp、clear fallback、screenshot/layout 临时 metrics
和 debugger release 条件全部走一个 queue；失败不提交错误状态。

### 任务 4：接入菜单和横向滚动画布

修改：

- `electron/src/preload.ts`
- `electron/src/browser/tools/menu.ts`
- `frontend/src/components/terminal/browser/header/navigation.tsx`
- `frontend/src/components/terminal/browser/controller/tool.tsx`
- `frontend/src/components/terminal/browser/controller/use-controller.ts`
- `frontend/src/components/terminal/browser/controller/use-bounds.ts`
- `frontend/src/components/terminal/browser/controller/surface.tsx`

可新增：

- `frontend/src/components/terminal/browser/use-horizontal-viewport.ts`

完成条件：原生菜单、live Tab 状态、滚动轨道和 bounds offset 同步；工具栏固定、页面可交互、offset 生命周期符合合同。

### 任务 5：更新活文档与验收合同

修改：

- `docs/architecture/terminal-code-preview.md`
- `docs/testing/terminal/browser/minimum-viewport-width.testplan.yaml`

工作：

- 在 Terminal Browser 当前边界中记录最小宽度、原生裁剪、Zoom/Device/CDP 组合和非持久化语义。
- 语义合并当前未提交的 Profile proxy 文档改动，不复制实现细节到其它入口。
- 不保留已完成计划中的过程细节；功能完成后按文档治理规则删除本计划，长期事实留在架构文档与 YAML。

## 错误处理、安全、兼容与回滚

### 错误与并发

- 菜单选择和 CDP/Device/Zoom metrics 共用 entry queue；最后一个成功请求生效，失败请求回滚自身变化。
- Tab 在异步 setter 返回前关闭时，IPC 返回明确 closed-tab 错误；renderer 不重新创建本地 Tab。
- bounds 滚动更新只接受所属窗口的存活 tabId；非法 offset 被 clamp，非法 bounds 继续 fail closed。
- 高频滚动和 resize 由 renderer RAF 合并；主进程不启动独立无界队列。

### 安全边界

- 不执行目标网页脚本注入，不读取页面正文，不扩大 Node integration 或 preload 暴露面。
- 原生子 View 尺寸由主进程依据 sealed preset 计算；renderer 不能请求任意超宽 View。
- CDP target/profile/group 权限不变，不新增 browser/root session 修改入口。
- 日志只记录 tabId、档位、可见/内容宽度和 offset；不记录 URL query、Cookie、Header、页面文本或截图数据。

### 兼容与迁移

- 同版本 Electron/renderer 通过 shared bridge 协议一起发布；frontend 对缺失 live 字段回退 Auto，支持热更新过渡。
- `terminal-browser-tabs.json` schema 与内容不变；无需迁移、备份或回滚脚本。
- Auto 路径必须与当前 bounds/metrics 行为等价，是功能开关式回滚路径。

### 回滚

- 回滚代码时删除 minimum live 字段、setter、菜单和滚动轨道，恢复 direct `WebContentsView` attachment。
- 因没有磁盘字段，回滚不需要清理 userData；现有 Tab/Group/Profile、Cookie、Whistle 与 Header 数据保持可读。
- 若原生父 View 裁剪在 Electron 33 真实运行中不成立，本功能不得发布；回到 Auto 现状并另行评估 offscreen rendering，
  不以 CSS 注入或覆盖 Terminal 的方案替代。

## 验证计划

配套行为合同：

- `docs/testing/terminal/browser/minimum-viewport-width.testplan.yaml`

### 文档与静态门禁

```bash
pnpm testplan:validate docs/testing/terminal/browser/minimum-viewport-width.testplan.yaml
pnpm testplan:verify
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/electron typecheck
pnpm --filter @runweave/electron lint
pnpm --filter @runweave/frontend typecheck
pnpm --filter @runweave/frontend lint
pnpm architecture:check
pnpm docs:check
git diff --check
```

不运行 `pnpm --filter @runweave/frontend test:e2e`：当前仓库没有 tracked Playwright spec，该命令的
`No tests found` 不是通过证据。静态门禁也不能替代真实桌面验收。

### 真实桌面验收

1. 使用 `$toolkit:runweave-dev-session` 从当前 patch 边界启动受管 macOS Dev Session。
2. 使用 `$computer-use` 打开目标 Electron 窗口、Sidecar 和原生 More 菜单。
3. 从该 Session 重新取得 fresh desktop surface 与 scoped terminal-browser endpoint；不使用 ambient/global endpoint。
4. 使用 desktop surface 的 `$toolkit:playwright-cli` 检查 renderer 滚动轨道、Sidecar resize、工具面板与可访问状态。
5. 使用 terminal-browser surface 的 `$toolkit:playwright-cli` 检查 `window.innerWidth`、媒体查询、DOM 几何、输入与截图。
6. 需要验证 raw automation metrics 时，使用同一 scoped endpoint 的受控 primary target session；不创建不受支持的 nested session。
7. 使用 `$toolkit:run-test-cases` 按配套 YAML 执行，遇到首个 required case 失败即停并保留现场。
8. 验收后关闭 owned Tab、detach 所有连接、停止 Dev Session，并确认没有 owned fixture、View 或 CDP attachment 残留。

## 完成标准

- `TBMW-001` 至 `TBMW-013` 全部 required case 通过。
- 四个菜单档位、per-live-tab 生命周期、导航/刷新滚动规则与 mobile 暂停规则和本文一致。
- 真实 Electron 证明超宽子 View 被父 View 裁剪，左侧 Terminal、工具栏和工具面板可见且可点击。
- 页面、媒体查询、layout metrics 和 Agent screenshot 都观察到相同的 minimum floor；Agent 输入无需 offset 补偿。
- `terminal-browser-tabs.json` 不含 minimum 字段，关闭 Tab 与完整应用重启后均回到 Auto。
- shared、Electron、frontend typecheck/lint、架构、文档、YAML 与 diff 门禁通过。
- 当前工作区既有 Profile proxy 改动完整保留，本功能没有夹带提交或清理无关文件。
