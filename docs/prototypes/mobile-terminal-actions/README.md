# 手机终端加号菜单原型

2026-09-30 设计评审产物，不代表当前产品实现。仅新增静态原型，未修改 Swift、Backend 或 Web 产品代码。

**最新范围纠正：** 用户确认快捷指令必须打开[截图中的现有「快捷回复」页](existing-quick-replies-reference.png)。本 HTML 的内部列表、分段模式和填入按钮不作为实施依据；本目录仅用于参考输入框外部入口。实施范围以[加号菜单计划](../../plans/2026-09-30-ios-terminal-actions-menu.md)为准。

## 查看

优先从 Runweave 的 Prototypes 浏览器打开本目录。单目录预览：

```bash
python3 -m http.server 6198 --bind 127.0.0.1 --directory docs/prototypes/mobile-terminal-actions
```

打开 `http://127.0.0.1:6198/`。三态总览为 `?gallery=1`，截图见 [prototype-preview.png](prototype-preview.png)。

## 原型简报

- 目标：将原生 iOS 终端输入框的扩展操作集中到左侧加号菜单，直接露出快捷指令后台运行入口。
- 主要操作：加号 → 文件 / 快捷指令 / 排队；一键回复置于下组；终端快捷键在输入框底部保持独立按钮。
- 加号中只保留一个「快捷指令」入口。按用户要求，列表内部保留首版原型的填入 / 后台模式，本轮暂不优化内部交互；不能据此要求改造当前产品的列表。
- 填入保留已有草稿，不自动发送。后台运行只消费已保存的指令，保留输入框草稿，并明确显示当前项目 / worktree。
- 排队仍是将当前草稿提交给当前 Agent 的原生队列；草稿为空且无附件，或不支持原生队列时禁用。
- 保留输入框上方的常用指令，输入框下方保留模型摘要、终端快捷键和发送；一键回复与排队收进菜单。快捷键按钮位于模型摘要与发送之间，点击展开或收起快捷键条。
- 后台运行后在原行显示排队状态、隐藏重复运行按钮，可进入运行详情。
- 非目标：本次不做产品实现、发布、真机安装、真实任务执行或完整指令库管理改造。

## 真实代码与边界

- 当前 iOS 输入框：[ComposerView.swift](../../../packages/app-ios/Sources/RunweaveIOS/Features/Terminal/Input/ComposerView.swift)。左侧加号当前由 [MediaControls.swift](../../../packages/app-ios/Sources/RunweaveIOS/Features/Media/MediaControls.swift) 提供，仅选择图片。
- 指令库与后台执行入口：[QuickReplyLibraryView.swift](../../../packages/app-ios/Sources/RunweaveIOS/Features/Terminal/Input/QuickReplyLibraryView.swift)、[BackendQuickInputModel.swift](../../../packages/app-ios/Sources/RunweaveIOS/State/BackendQuickInputModel.swift)。原型中的两种模式拟复用同一库及现有运行链路。
- 原型“文件 → 选取文件”表达原记录中的文件入口，包含 Markdown 示例；当前媒体链路仅支持图片。通用文件选择、上传及 Agent 消费尚需另行确认实现范围，不能据此声称已经支持。照片入口也只模拟附件草稿，不会打开系统相册或读取本机文件。
- 列表搜索、草稿、附件、排队与运行状态均为内存 mock；刷新即重置，不接真实 API，不执行命令。
- 模型摘要为静态背景，本次不演示模型切换；真实产品的模型切换应保留。
- 原有快捷指令新增、编辑、删除和排序未在本次原型演示，实施时应保留，不能由本原型推断为删除需求。
- 页面是 HTML 视觉参考，系统键盘只是无交互背景；浏览器验收不等于原生 iOS 或后台业务验收。

## 功能分类

| 元素或行为 | 分类 |
| --- | --- |
| 加号菜单、文件入口、快捷指令、后台运行、排队 | 产品核心功能 |
| 填入与后台两种模式、运行位置、排队反馈、运行详情 | 产品核心功能 |
| 保留草稿、禁用不可执行的排队、避免重复启动入口 | 产品核心行为 |
| `mock-state.json` 样例、即时模拟附件和排队、装饰键盘 | 原型辅助内容，不是系统实现 |
| `?gallery=1` 三态总览及图外标题 | 原型辅助视图，标记 data-prototype-helper，不进入产品 |
| URL 参数 | 原型辅助状态，不进入产品 |

## 辅助状态

- 默认：加号菜单打开；`?state=closed` 查看收起态。
- `?state=quick` / `?state=background`：分别直接打开填入 / 后台模式，仅用于查看首版列表交互。
- `?empty=1`：空草稿；`?queue=unsupported`：不支持原生排队。
- `?state=quick&emptyCommands=1`：空指令库。

## 验证与评审

使用仓库 Playwright CLI 附着当前 worktree 的 Profile，在真实浏览器中检查菜单、搜索、填入、后台运行反馈、详情返回、草稿保留、排队、附件和小屏布局。首版 16 项交互与布局检查通过（包括 375 × 667 小屏），`node --check app.js` 与 `pnpm docs:check` 通过。截图已通过浏览器实际查看。原型不新增单元测试。

当前方案待用户评审，未冻结。仅保留“已保存的快捷指令后台运行”方向；不将当前输入框草稿直接作为后台任务，不新建独立后台任务管理体系。后续用户明确推进实现时，再回到真实代码整理实施范围。

## 本轮调整

按用户反馈将终端快捷键移出加号菜单，在输入框底部保留独立键盘图标；其展开、收起及按键反馈保持原有交互。本轮 10 项浏览器检查通过，覆盖菜单去重、独立按钮展开/收起、快捷键反馈、原列表入口和小屏布局。加号菜单仅保留文件、快捷指令、排队和一键回复，共 4 项。去掉重复的一级后台入口；列表内部保留首版原型，不做额外优化，后续产品实现也应沿用现有列表交互。
