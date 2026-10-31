# 浮层与桌面 Browser 的呈现协调

右侧 Browser 是 Electron 原生视图。应用 DOM 的 z-index 和 Portal 无法跨原生视图决定层级；浮层必须通过公共协调能力使网页临时让位。

## 新功能接入

优先使用 `src/components/ui` 的 Dialog、AlertDialog、Sheet、Popover、Select、DropdownMenu、ContextMenu、Tooltip。其实际 Content 和遮罩已经登记，业务无需调用 Browser hide/show，也无需把业务 open 状态传给 Browser。菜单子层独立登记；退出动画结束后释放。

手写浮层只在实际浮层 DOM 上使用 `useOverlayRef`：

```tsx
const ref = useOverlayRef<HTMLDivElement>(undefined, "window");
return open ? (
  <div ref={ref} className="fixed inset-0">
    ...
  </div>
) : null;
```

- `window` 用于遮罩覆盖全窗的模态层。
- 默认 `intersection` 用于非模态菜单、提示、通知；仅覆盖当前 Browser viewport 时避让。
- 始终挂载的浮层必须用 `hidden`、CSS 可见性、HTML dialog 的 `open` 或 Radix `data-state` 表达视觉生命周期。`aria-hidden` 只表达无障碍语义，Radix 会将可见遮罩和嵌套外层标为 `aria-hidden`，不能用它判定是否遮挡。`data-state=closed` 的退出动画完成后不再占用。
- ref 必须落到实际可见区域；普通布局 Portal 不登记。已有布局侧栏继续通过 bounds 预留空间。
- 图片预览通过 `@runweave/common/terminal` 的 `ImageLightboxLifecycleProvider` 接收宿主适配，Common 不依赖 Electron 或前端业务。

公共组件导入有 ESLint 门禁；手写 Portal/fixed 浮层仍须在评审中检查接入。

应用内浮动通知统一使用 `components/status-notice.tsx` 的 `StatusNotice`，由根
`StatusNoticeProvider` 放入左下角堆叠区域。业务不得自行设置通知的 fixed/right/bottom
定位。必须提供 `onDismiss`；组件统一提供独立关闭按钮及默认 8 秒自动关闭。
同一入口替换通知内容时传入 `noticeKey` 重置计时，普通重渲染不延长停留时间。
包含需要手动复制的快照链接时使用 `duration={0}` 保留到手动关闭；关闭只隐藏提示，
不删除任务结果或改变任务状态。正文操作与关闭按钮必须分开，避免关闭触发跳转。

## 运行时合同

`features/overlay/registry.ts` 保存窗口内的浮层集合，观察登记元素、Popper 父容器和视口变化；同一帧内的登记、释放和观察回调合并到绘制前测量，避免 React ref 重新绑定时按不完整集合恢复原生网页。仅有限动画期间逐帧测量，没有有效遮挡时不做持续轮询。Browser bounds 来自同一套 CSS 视口坐标。

根 `package.json` 统一 `@radix-ui/react-dismissable-layer` 版本。Dialog、Sheet、Select 和菜单必须共享同一份层级上下文，避免嵌套时 Escape 或外部点击被多套独立层级同时处理。

`features/terminal/browser-presentation/coordinator.ts` 合并工具激活与覆盖状态，通过窄 bridge 发送单调 revision。等待原生让位确认时浮层保持布局与焦点能力，内容透明且不可点击；超时或错误有限重试并显示重试入口，不能永久卡住弹窗。普通 Web 不等待 Electron。

`electron/src/browser/view/presentation.ts` 决定主窗口最终可见性，所有 attach 入口必须遵守 active、suppressed、当前目标、有效 bounds 和捕获归属。只改变可见性，不关闭 WebContents、不写 Tab 持久化。renderer 重载/崩溃清空该 document 的状态并隐藏网页；新的初始化才放行。自动化捕获宿主借用视图时保持独立显示，归还时重新应用主窗口规则。

恢复使用当前目标和最新 bounds，不回放浮层打开时的旧 Tab，不主动抢焦点。新 renderer 在旧桌面使用集中式 hide/show 回退，但旧主进程不能保证阻止后续 page-open/CDP attach；完整约束需要前后端配套更新。

## 验证入口

[验收计划](../../docs/testing/terminal/browser/overlay-coordination.testplan.yaml) 覆盖公共组件、自定义入口、嵌套、退出、Tab/Profile、renderer、捕获与故障恢复。类型检查和 DOM 截图不能证明原生层没有遮挡，必须观察真实 Electron 合成窗口并检查原生输入命中。

开发或 Beta 的显式 `?browser-overlay-harness` 入口装载 `src/e2e/browser-overlay-harness.tsx`；正常导航和 Stable 不装载。fixture 使用真实公共组件、IPC 和 WebContents；受控网页内容在 `src/e2e/browser-overlay-fixture.html`，由验收者在专属 Browser target 中装载。fixture 的窗口级 `browserOverlayHarness` 仅在该入口提供新建 Tab、工具开关、故障注入和清理；清理只关闭本 fixture 创建的 Tab。
