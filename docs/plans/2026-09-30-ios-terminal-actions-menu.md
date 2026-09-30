# iOS 终端输入框加号菜单实施计划

状态：待实施。本轮仅编写计划，不修改产品代码。粒度：L1，两个 UI 文件的入口调整。

## 目标与最终边界

将手机原生 iOS 终端输入框的次要入口收进左侧加号菜单，保留外部的终端快捷键按钮。

**「快捷指令」直接打开用户截图中的现有「快捷回复」页面，内部完全沿用当前产品。** 该页面已经在每个条目下提供后台运行和查看运行，因此不再增加独立后台入口，也不新增填入 / 后台运行模式切换。

设计依据按优先级排列：

1. 用户最新确认：快捷键留在外面；快捷指令只要一个入口；内部交互暂不优化。
2. [用户提供的现有快捷回复页面截图](../prototypes/mobile-terminal-actions/existing-quick-replies-reference.png)。截图中的条目仅用于识别页面，不作为运行指令或验收数据。
3. [外部输入框原型](../prototypes/mobile-terminal-actions/README.md)：只参考加号菜单、快捷键位置及输入框外部布局。

原型先前画出的新列表、顶部模式切换、「填入」按钮和内部布局均不进入实施范围；原型中的通用文件选择也不进入本次实现。此处纠正此前「沿用上一版原型内部交互」的表述：**实施应沿用真实产品的内部交互。**

## 用户可见行为

| 位置 | 最终行为 |
| --- | --- |
| 输入框左侧加号 | 点击打开原生纵向菜单；再次关闭或点击外部不修改草稿、不发送内容 |
| 菜单「添加图片」 | 复用当前图片选择器及上传草稿流程；对应原记录的文件/附件入口，本轮按真实能力明确标为图片 |
| 菜单「快捷指令」 | 打开现有 `QuickReplyLibraryView`；页面标题仍是「快捷回复」 |
| 菜单「排队」 | 原位置迁入菜单，调用原来的 `submit(queue: true)`；仍按当前 Agent 的原生队列能力决定是否出现 |
| 菜单「一键回复」 | 迁移现有一键回复开关，保留原先展开时关闭输入面板的行为 |
| 输入框底部键盘图标 | 留在模型摘要与发送/停止按钮之间，独立展开/收起现有 `ShortcutBar` |
| 输入框上方 | 保留最多前三条常用回复；原来的「全部 / 快捷回复」列表入口迁入菜单，不重复保留；无可显示条目时不留下空白行 |
| 模型摘要、发送/停止 | 继续沿用当前行为，不改变模型设置或发送语义 |

「快捷回复」页保留：搜索、排序、新增、条目标题/正文、整行点击填入、右侧管理菜单（编辑/删除）、原行后台运行、状态及查看运行、返回。后台运行使用当前终端实际项目/worktree，已有数据和鉴权均不变。

## 代码现状与修改范围

产品修改原则上仅涉及以下两个文件：

| 文件 | 本次职责 |
| --- | --- |
| [ComposerView.swift](../../packages/app-ios/Sources/RunweaveIOS/Features/Terminal/Input/ComposerView.swift) | 在 `inputCard` 的工具行添加原生 `Menu`；迁移快捷库、排队、一键回复入口；保留外部快捷键、常用前三条、模型摘要和发送/停止 |
| [MediaControls.swift](../../packages/app-ios/Sources/RunweaveIOS/Features/Media/MediaControls.swift) | 让已有图片按钮以明确的图片图标和文字作为菜单项，保留选择器、上传、错误处理和生命周期所有权 |

以下文件只读核对，不重写：

- [QuickReplyLibraryView.swift](../../packages/app-ios/Sources/RunweaveIOS/Features/Terminal/Input/QuickReplyLibraryView.swift)：与截图对应的真实页面。保留整个布局、查询、编辑及后台按钮行为，不新增模式参数。
- [BackendQuickInputModel.swift](../../packages/app-ios/Sources/RunweaveIOS/State/BackendQuickInputModel.swift)：沿用全局已保存列表和 `start` / `refreshRuns`。
- [ShortcutBar.swift](../../packages/app-ios/Sources/RunweaveIOS/Features/Terminal/Input/ShortcutBar.swift)：沿用 Ctrl-C、Tab、Esc、方向键、Enter 及原始按键通道。
- [AppSession+Input.swift](../../packages/app-ios/Sources/RunweaveIOS/State/AppSession+Input.swift)：沿用原生排队按键、图片路径组合、草稿版本保护和错误语义。
- [TerminalComposerPresentation.swift](../../packages/app-ios/Sources/RunweaveIOS/Features/Terminal/Input/TerminalComposerPresentation.swift)：保留键盘避让及输入面板呈现生命周期。

不修改 Backend、Shared DTO、存储、Web/Electron、定时任务服务或后台执行队列；不创建可扩展菜单注册系统，不增加依赖。

## 实施步骤

### 1. 组合菜单并保留外部快捷键

- 在现有 `MediaControls` 的 content 闭包中组合菜单，使用现有图片按钮，再加入快捷指令、排队和一键回复操作。
- `MediaControls` 本体必须持续挂载在输入卡片中，不能整个塞进菜单后随菜单关闭销毁，否则图片 picker、上传和状态生命周期会改变。
- 将图片按钮 label 改为适合菜单显示的「添加图片」及图片图标。维持已有 `picking`、`pickerGeneration`、连接 scope、`active`、`canWrite` 和媒体 busy 检查。
- 快捷键按钮继续驱动 `showingShortcuts`，按键条继续使用原有 `ShortcutBar`，不新建按键状态或重新实现键值。
- 使用既有 44pt 点击区域和主题色；窄屏、横屏与长模型名称不得挤掉快捷键或发送按钮。

完成条件：菜单中无重复后台入口、无终端快捷键入口；输入框底部可独立切换快捷键；图片功能保持原能力。

### 2. 迁移入口，原有动作直接复用

- 把「全部 / 快捷回复」按钮原有的 `editing = false`、清空 `pendingReply`、置 `showingReplies = true` 的动作迁到「快捷指令」菜单项。保留 `quick-reply-open` 可访问性标识。
- 保持现有 `.sheet(isPresented: $showingReplies)` 和 `QuickReplyLibraryView(session:projectId:onSelect:onOpenRun:)` 装配；不得换一个新列表或导航流程。
- 保持返回后的焦点恢复和 `pendingReply → insertReply` 调用，仍经 `CommandTextEditor.insert` 在光标/选区插入，不把草稿替换成整条指令，不自动发送。
- 排队菜单项保持 `queueKey` 的出现条件，继续使用 `sendDisabled || !hasContent || state.snapshot.inputBusy` 禁用规则，动作只调用 `submit(queue: true)`。不支持的 Agent 继续隐藏该操作，避免虚假排队。
- 一键回复迁入菜单后继续执行原开关动作，保持 `closeDisabled`、`inputBusy` 约束。
- 快捷库的 `preventsDismissal`、`inputBusy`、保存中不可退出等限制不减弱。根据各项原有条件分别控制菜单项，不用一个新的总开关误禁用其他操作。

完成条件：用户截图中的页面及其内部操作未改；常用前三条仍直接插入；列表与图片 picker 不发生重叠呈现，取消任一入口后草稿和附件保留。

## 接口、状态与兼容

- API、DTO、持久化、鉴权和幂等键合同均无变化；没有数据迁移，也不重写已保存指令。
- 选择指令仍只插入草稿并标记使用，保留 `suppressQuickInputHistory`；后台操作仍由现有列表调用 `BackendQuickInputModel.start`。
- 排队继续提交当前 Agent 支持的原生按键，保留中文输入法组合提交、终端/控制器身份检查、并发发送保护和草稿版本比较。
- 图片只加入当前终端的草稿；上传未完成时沿用发送限制。禁止因为菜单关闭丢失附件或放宽连接代次检查。
- 沿用现有错误展示和未知结果处理；不新增自动重试或离线补发。只读、断线、保存中和发送中不可绕过原来的禁用条件。
- 回滚只需撤回本次两个 UI 文件的入口调整，无服务端回滚和数据迁移。

## 不做什么

- 不优化截图中的「快捷回复」页，不改标题、搜索、排序、新增、编辑、删除、填入或运行详情。
- 不增加后台任务一级入口，不增加列表模式切换，不把任意当前草稿直接送入后台。
- 不新增 Markdown、PDF 等通用文件上传；原型中的「选取文件」不代表本轮已有产品能力。
- 不改 iOS 连接、登录、模型设置、Swift DTO，不扩展到手机 Web。
- 不写单元测试、不新增测试框架、不做发布、提交/合并 PR 或更新用户真机。实现与验收另按用户后续授权推进。

## 验收与验证方式

本计划只写验收标准，本轮不构建或执行 UI 验收。入口调整采用下列手动检查，已有业务回归引用仓库 YAML；不重复新建 YAML。

| 场景 | 操作与通过条件 |
| --- | --- |
| 菜单和外部布局 | 原生终端打开输入框，点加号；只见图片、快捷指令、可用时的排队及一键回复，无独立后台入口；键盘图标在菜单外；关闭菜单不改变草稿 |
| 原页面复用 | 点「快捷指令」进入与参考截图相同的 `QuickReplyLibraryView`；有返回、排序、新增、搜索、管理菜单和原行后台按钮；没有新分段模式或专门填入按钮 |
| 草稿和焦点 | 准备带光标/选区的草稿及测试图片；从列表点行返回后只在光标或选区插入，附件保留且未发送；直接返回也不丢草稿，输入焦点恢复 |
| 快捷键 | 不打开菜单即可展开/收起按键条；在隔离终端验证 Esc、Tab 等按键进入正确终端；只读/断线时不能发送按键 |
| 原生排队 | 在支持的 Agent 中提交安全测试草稿，核对只提交一次且使用原生队列；空草稿无附件、正在发送或图片未就绪时不可提交；不支持的 Agent 没有排队项 |
| 图片入口 | 菜单选图片、取消选择、上传成功/失败与移除附件保持现有行为；菜单关闭不销毁图片选择器；连接切换后的迟到结果不能加入另一个终端 |
| 一键回复 | 从菜单切换一键回复，展开时保持原有关闭输入框并显示终端底部回复的行为，不消耗当前草稿 |
| 尺寸和模态 | 小屏、横屏、系统键盘弹出及模型摘要较长时按钮不重叠；菜单关闭后再呈现快捷库/图片选择器，无重叠 sheet 或丢失焦点 |
| 后台操作回归 | 从新入口进入原页，使用隔离 Backend 中的安全指令运行；项目/worktree 正确，原终端与草稿不变，状态和查看运行正常 |

业务回归复用 [iOS Backend 快捷回复与后台运行验收](../testing/app/ios-backend-quick-inputs.testplan.yaml)：重点覆盖 IOSQUICK-003（排序与前三条）、004（光标/选区插入）、007（离线）、010（实际 worktree 后台运行）、011（未知结果不重复）、012（同一运行/对话）。不为检查 UI 运行截图里的 update、PR 或 rebase 命令；编辑和排序检查在独占测试库执行。

实施后的构建及设备步骤遵循 [iOS 包入口](../../packages/app-ios/README.md) 和 [共享模拟器](../cli/ios-simulators.md)：

```bash
# 先申请独占设备；task-dir 每次使用唯一名称
node scripts/ios-simulators/cli.mjs start --app runweave --task-dir .runweave/mobile-qa/ios-terminal-actions-<本次唯一标识> --json
# 按本次 lease 构建、安装并启动当前源码
node packages/app-ios/scripts/ios.mjs run --task-dir <上述 task-dir 的绝对路径> --configuration Debug
# 用 toolkit:agent-device 的同一 task-dir 操作原生页面并取证，结束后释放设备
node scripts/ios-simulators/cli.mjs finish --task-dir <上述 task-dir> --json
```

成功标准分开记录：构建/安装成功、原生 UI 场景通过、后台业务回归通过。环境缺失或未执行项记录为阻塞/未执行，不能用 HTML 原型截图或编译结果代替。

## 风险与完成条件

本次不更改业务存储和服务端，主要回归风险是菜单与 sheet 的呈现顺序、编辑焦点、中文组合输入、附件生命周期以及小屏按钮拥挤。必须通过上述真实原生操作排除；不得通过重写快捷库或 Backend 来扩大解决范围。

实现完成须同时满足：仅入口相关产品差异、原快捷回复页面未变、现有草稿/图片/排队/运行语义未变、构建和相关真实 UI 验收有证据。未授权前不标记随记完成。
