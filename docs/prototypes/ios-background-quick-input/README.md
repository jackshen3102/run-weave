# 手机快捷回复后台运行原型

本版按当前 iOS 使用方式重画：终端输入区打开「全部」后仍进入原有「快捷回复」列表；搜索、排序、新增、点整行填入输入框、右侧 `···` 管理保持原位。只对符合资格的已保存 `$toolkit:github-pr` 条目，在原行下增加「后台运行」；启动后同一行显示运行中和「查看运行」。结果沿用已有运行详情的列表式结构，不另起一套卡片界面。

与上一版相比，**全部快捷回复/指令统一取自当前 Backend 的全局已保存列表**（`projectId:null`、pinned），与手机当前项目无关。项目绑定项和自动记录的最近输入都不进入手机快捷回复；界面不分「当前项目」和「本机」两组。旧本机归档的当前处理方式见[iOS 架构](../../architecture/app-mobile.md#全局快捷回复输入策略)。本原型的资格限制与导入设想是历史设计，不代表当前实现。

[三态图片](prototype-preview.png)。在仓库根目录运行 `python3 -m http.server 6194 --directory docs/prototypes/ios-background-quick-input`，打开 `http://127.0.0.1:6194/` 可点击原行验证填入输入框，也可点「后台运行 → 查看运行」。`?state=ready`、`?state=running`、`?state=detail-running`、`?state=result` 用于直接查看状态；`?gallery=1` 是总览图专用辅助视图，图外的阶段标题不进入产品。

## 代码现状与落点

- `QuickReplyLibraryView` 是原生 `List`，标题为「快捷回复」，从 `ComposerView` 以 sheet 打开。点行只填入输入框；右侧菜单提供编辑和删除。本原型保留这个操作语义。
- Backend 的 `TerminalQuickInputService` 已有读取、搜索、创建、删除接口，并对快捷来源运行提供 `/api/terminal/quick-inputs/:id/run`；当前 iOS `APIClient` 尚未接这些接口。省略 `projectId` 会读到所有作用域，实施时必须增加显式全局筛选。现有更新接口只支持标题和固定状态，尚不能原位编辑正文；Backend 也没有与本机 `move` 对应的排序接口。统一数据时需补齐这两项，否则不能声称保留手机现有编辑/排序方式。
- 后台执行仍需以手机当前终端的实际 project/worktree 启动。执行详情复用 iOS 已有 `ScheduledRunView` 及 runId/thread 恢复路径；手机离开页面不取消任务。

## 功能分类账

| 元素                                                            | 分类           |
| --------------------------------------------------------------- | -------------- |
| 原有列表、搜索、点行填入、管理菜单、新增和排序                  | 保留的产品交互 |
| 单一 Backend 数据源、符合资格条目的后台运行、原行状态与详情入口 | 新增的产品功能 |
| 总览阶段标题、URL 状态参数、PR #634 与模拟日志                  | 原型辅助内容   |

图片与交互只用于评审；尚未修改 Swift 产品代码，按钮没有调用真实 Backend。
