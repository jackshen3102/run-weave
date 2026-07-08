# 状态查询原型

面向 Runweave Terminal 右上角 `More actions -> 状态查询` 的轻量查询原型。它只回答一个问题：给定一个 `threadId` 或 `terminalSessionId`，当前 App Server 投影出的 ThreadRef 是什么状态，以及要把哪些最小上下文复制给 Agent 继续查。

## 启动

```bash
python3 -m http.server 6188 --directory docs/prototypes/thread-state-lookup
```

打开：

```text
http://127.0.0.1:6188/
```

## 文件

- `index.html`：静态页面壳层、Terminal 顶栏、更多菜单和弹窗样式。
- `app.js`：更多菜单、Thread / Terminal 查询、候选 ThreadRef 选择、复制给 Agent 等交互。
- `mock-state.json`：模拟 App Server ThreadRef 当前视图。

## 原型简报

- 目标：把 App Server 的轻量状态查询做成右上角更多菜单里的入口，而不是完整诊断中心。
- 用户动作：打开更多菜单、选择 `状态查询`、选择 `Thread ID` 或 `Terminal ID`、输入 ID、查看状态摘要或候选 ThreadRef、复制上下文给 Agent。
- 主要流程：Terminal 顶栏 -> 更多菜单 -> 状态查询弹窗 -> 查询 ThreadRef；若按 terminal 查询命中多条，则先选候选 ThreadRef -> 查看最小状态 -> 复制给 Agent。
- 关键状态：弹窗打开/关闭、查询模式、查询值、命中、未命中、多候选、候选选中、复制反馈。
- 非目标：不展示完整事件链，不做多维资源图，不查询 Slot/Port，不连接真实 App Server，不保存完整 thread 对话正文。
- 影响的产品界面或模块：`TerminalWorkspaceShell` 的 `More actions` 菜单、后续 ThreadRef 查询 API、App Server projection/latest thread 状态。

## 当前代码依据

- `frontend/src/components/terminal/terminal-workspace-shell.tsx`：Web Terminal 右上角已有 `More actions`，菜单里已有 `Preview`、`Terminal History`、`日志上报`。
- `packages/shared/src/app-server-events.ts`：已有 `AppServerThreadRef`、`AppServerThreadListResponse`、`AppServerThreadResponse` 类型。
- `docs/architecture/terminal-state.md`：ThreadRef 只保存轻量状态，不保存完整 thread 详情；查询 API 方向是 `/threads` 与 `/threads/:threadId`。

## 验证点

- 点击右上角 `...` 后出现菜单。
- 菜单中有 `状态查询`。
- 点击后弹出居中 dialog。
- `Thread ID` 模式下输入 `thread-state-sync-001` 显示 `running`、terminal、project、run、last event、updatedAt。
- `Terminal ID` 模式下输入 `term-feature-main` 显示 3 条候选 ThreadRef，默认选中 active 优先的候选。
- 点击 terminal 候选行能切换下方状态详情。
- 输入不存在的 ID 显示未找到。
- 点击最近 thread / terminal chip 能切换结果。
- `复制给 Agent` 只复制最小上下文和排查指令，不复制完整诊断长文。
- 在 terminal 多候选场景下，`复制给 Agent` 会带上同 terminal 下的候选列表，方便 Agent 继续判断。

## 功能分类

### 产品核心功能

| 元素 / 行为            | 最终产品是否需要 | 产品价值                                | 备注                                  |
| ---------------------- | ---------------- | --------------------------------------- | ------------------------------------- |
| More actions 入口      | 是               | 保持入口轻，不占常驻界面                | 菜单名可再收敛                        |
| 状态查询弹窗           | 是               | 快速确认 thread 是否活着和归属哪里      | 不做完整诊断中心                      |
| threadId 查询          | 是               | 排障时最常见的起点                      | 首版只支持精确或轻量包含匹配          |
| terminalSessionId 查询 | 是               | 没有 threadId 时仍可从终端入口收敛候选  | 多候选时先列表再选详情                |
| 候选排序               | 是               | 避免多个结果时让用户猜                  | running/starting 优先，其次按更新时间 |
| 状态摘要               | 是               | 直接回答 running/idle/failed 等核心问题 | 字段来自 ThreadRef                    |
| 复制给 Agent           | 是               | 把深度排障交给 Agent                    | 复制内容应克制、可执行                |

### 原型辅助功能

| 元素 / 行为                 | 辅助验证什么     | 为什么不进入产品                           | 备注           |
| --------------------------- | ---------------- | ------------------------------------------ | -------------- |
| 模拟 Terminal 屏幕          | 帮助判断入口位置 | 产品已有真实 Terminal                      | 原型专用       |
| 最近 thread / terminal chip | 方便演示命中状态 | 产品里可来自当前 terminal/thread，也可没有 | 需产品阶段再定 |
| Mock ThreadRef 数据         | 演示不同状态     | 真实数据来自 App Server projection/API     | 原型专用       |
| Toast 文案                  | 演示复制反馈     | 产品可复用现有 toast 体系                  | 原型专用       |

## 边界

- 这个原型不连接真实 App Server API。
- 这个原型不能证明 `/threads/:threadId` 已在当前运行时可用。
- 这个原型不保存、不展示完整 Codex/Trae thread 内容。
- 这个原型代码不能直接照搬进生产代码；产品实现必须回到当前 React/Tailwind/Radix 组件和 App Server API。

## 调整记录

| 轮次 | 调整内容                                     | 原因                                         | 结果                                                           |
| ---- | -------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------- |
| 1    | 创建右上角更多菜单里的 Thread 状态速查原型   | 用户收敛为只查某个 thread 当前状态和少量信息 | 原型聚焦轻量状态和复制给 Agent                                 |
| 2    | 增加 Terminal ID 查询和多候选 ThreadRef 列表 | 用户指出可能没有 threadId，只能从终端 ID 查  | 同一 terminal 下多结果按 active/更新时间排序，用户选择后看详情 |

## 冻结记录

- 最终采用的交互：尚未冻结。
- 放弃的方向：完整诊断中心、资源关系图、多维 Slot/Port 查询、长篇事件链展示。
- 产品核心功能清单是否已确认：未确认。
- 原型辅助功能清单是否已确认：未确认。
- 最终截图：`prototype-preview.png`
- 冻结时间：未冻结。
