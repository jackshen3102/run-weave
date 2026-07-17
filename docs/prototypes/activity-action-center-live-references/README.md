# Activity Action Center + Live References

面向 Runweave Activity 的可运行 HTML 交互原型，把两个 P0 方向放进同一条真实人工介入流程：

1. `Needs Attention` 聚合现有 Agent Team 人工门禁，并提供原有控制动作。
2. `Live Reference` 让恢复 note 引用现有 Terminal、Agent Team Run、验收 Case 和 pane outbox，引用在消费时解析，而不是把现场复制进 note。

> 状态：待用户评审，尚未冻结。这个目录只表达产品意图，不连接真实 API，也不证明 Live Reference 协议已经存在。

## 启动

```bash
python3 -m http.server 6188 --directory docs/prototypes/activity-action-center-live-references
```

打开：

```text
http://127.0.0.1:6188/
```

## 文件

- `index.html`：Activity 页面壳层、当前设计 token 的静态映射和响应式布局。
- `app.js`：Action Center 筛选、门禁动作、恢复 note 和 Reference Picker 交互。
- `mock-state.json`：由当前 Agent Team、Work History、Terminal 和 outbox 合约整理出的模拟领域对象。
- `prototype-preview.png`：浏览器验收后保存的首屏截图。

## 原型简报

- 用户目标：不用在 Terminal、Agent Team sidecar 和 Activity 历史页之间来回查找，集中看到所有真正需要人工处理的事项，并能带着可追溯上下文完成处理。
- 用户动作：筛选待处理事项、选择一项查看上下文、聚焦 pane、确认/驳回 split、恢复熔断 Run、在恢复 note 中添加或移除 live references、复制对象引用。
- 主要用户：同时运行多个 Terminal 或 Agent Team Run，需要低频介入的开发者。
- 影响界面：`/activity` 左侧导航、Work History 三栏布局、Agent Team 人工门禁动作；不修改 Terminal 主工作区布局。
- 关键流程：进入 Needs Attention → 选择熔断 Run → Resume run → 填写 note → 添加 Run/Case/Evidence 引用 → 提交恢复。
- 重要状态：待处理、处理中、已解决；split gate、`need_human`/熔断、pending finding disposition；Reference Picker 空查询、选择、已添加和移除。
- 非目标：不拦截或解析 Provider TUI 权限弹窗；不做新的任务系统；不把 Terminal History 变成可编辑存储；不实现真实引用解析器。

## 当前代码事实与扩展边界

| 原型能力          | 当前已有能力                                                                | 原型表达的扩展                                                                        |
| ----------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Activity 页面壳层 | `activity-page.tsx` 已有 220px 左侧导航、64px Header、搜索/Runtime 筛选     | 在 Work history 组首位新增 `Needs Attention`                                          |
| 三栏工作区        | `work-history-layout.tsx` 已有 300px 列表、Journal、380px Inspector         | 列表展示 actionable projection，中栏处理事项，右栏展示引用上下文                      |
| Split 审批        | `submitAgentTeamSplitGate()` 已支持 confirmed/rejected                      | 从 Terminal sidecar 之外增加统一入口，复用同一 API                                    |
| 聚焦 pane         | `focusAgentTeamPane()` 已存在                                               | Action Center 直接深链聚焦目标 panel                                                  |
| 熔断恢复          | backend `/resume` 与 `resumeAgentTeamRun()` 已支持必填 note；当前前端未接线 | 在 Action Center 接线，并允许 note 携带 reference handle                              |
| Finding 裁决      | `decideAgentTeamFinding()` 与当前 sidecar 卡片已存在                        | Action Center 只聚合并复用，不发明新的 disposition                                    |
| Run/Terminal 读取 | Work History、`rw terminal handoff`、`rw agent-team export` 已存在          | 定义稳定 handle 与按需解析入口；不提前复制 tail/outbox 内容                           |
| Live Reference    | 当前没有统一协议或 `rw reference resolve`                                   | 新增 `runweave://terminal`、`agent-team`、`acceptance`、`artifact` handle 及 resolver |

## 产品核心功能

| 元素 / 行为                           | 最终产品是否需要 | 产品价值                           | 能力来源                    |
| ------------------------------------- | ---------------- | ---------------------------------- | --------------------------- |
| `Needs Attention` Activity 导航       | 是               | 一个入口看到所有结构化人工门禁     | Activity 导航扩展           |
| All / Needs attention / Resolved 筛选 | 是               | 区分待办和审计记录                 | actionable projection       |
| Agent Team gate 卡片与状态优先级      | 是               | 聚合 split、熔断和 finding         | `AgentTeamRun` 当前字段     |
| Focus pane                            | 是               | 回到真实终端现场                   | 现有 focus-pane API         |
| Confirm / Reject split                | 是               | 集中处理现有 split gate            | 现有 split-gate API         |
| Resume run + 必填 note                | 是               | 恢复熔断并把人工结论注入主 Agent   | 现有 resume API，前端接线   |
| Copy live reference                   | 是               | 在其它 Agent/终端中复用当前对象    | Reference 协议扩展          |
| `+ Add reference` Picker              | 是               | 从现有对象中选择上下文，不复制正文 | Reference 协议扩展          |
| Reference chip 与实时解析状态         | 是               | 让用户知道引用的是 live handle     | Reference resolver 扩展     |
| 右侧 Context Inspector                | 是               | 查看引用身份、作用域和当前摘要     | Work History Inspector 扩展 |

## 原型辅助功能

| 元素 / 行为            | 辅助验证什么                         | 为什么不进入产品                            | 备注               |
| ---------------------- | ------------------------------------ | ------------------------------------------- | ------------------ |
| `?item=<id>`           | 直接打开指定 mock gate               | 真实产品使用 URL 中的 run/event identity    | 默认不显示辅助 UI  |
| `?picker=1`            | 直接打开 Reference Picker            | 真实入口是 Resume dialog 的 `Add reference` | 默认不显示辅助 UI  |
| 内存中直接改变事项状态 | 验证确认、驳回和恢复后的列表反馈     | 产品必须等待真实 API 返回并重新投影         | 刷新即恢复 mock    |
| Clipboard fallback     | 在浏览器权限不可用时仍可验收复制反馈 | 产品使用真实 Clipboard API                  | 无可见 helper 控件 |

## 验证点

- 首屏保持当前 Activity 左侧导航、Header 和三栏 Work History 密度，不出现独立桌面工作台或新窗口系统。
- Needs Attention 只展示已有结构化门禁：split gate、`need_human`/熔断和 finding disposition。
- 熔断项能聚焦 Code pane，也能打开 Resume dialog；note 为空时不能提交。
- Reference Picker 只列出现有 Terminal、Agent Team Run、Acceptance Case 和 pane outbox/evidence 对象。
- 选中引用后，Resume dialog 只保存 handle chip，不把 terminal tail 或 outbox 正文塞进 note。
- 提交恢复后事项进入 Resolved，页面反馈 action 已完成。
- Split gate 能确认或驳回，并进入 Resolved。
- 所有原型可见控件都属于最终产品入口；不存在“模拟下一步”或状态切换 helper。

## 调整记录

| 轮次 | 调整内容                                                                | 原因                                   | 结果                            |
| ---- | ----------------------------------------------------------------------- | -------------------------------------- | ------------------------------- |
| 1    | 把 Action Center 放入 `/activity`，并把 Live Reference 接到 Resume note | 两个 P0 需要复用当前门禁与人工介入链路 | Playwright 验证通过，待用户评审 |

## 浏览器验收记录

2026-07-16 使用 `$toolkit:playwright-cli` 验证：

- 启动命令：`python3 -m http.server 6188 --bind 127.0.0.1 --directory docs/prototypes/activity-action-center-live-references`。
- 桌面视口：`1440 × 960`；Activity 左侧导航、Header 和 `300px + main + 360px` 三栏布局均可见。
- 熔断流程：打开 `Resume Agent Team`，填写必填 note，进入 Reference Picker，选择 `atr_4ef1c0a8` 与 `AGT-WH-015` 两个 live handles，返回后 note 和 chips 均保留，提交后 open count 从 3 变为 2。
- Split gate：确认 3 个 worker 的提案后，事项进入 Resolved，open count 从 2 变为 1。
- Finding disposition：填写原因并选择“继续修复”后，事项进入 Resolved，open count 从 1 变为 0。
- Resolved 筛选展示上述 3 项和原有 Terminal completion，共 4 项。
- 窄屏视口：`390 × 844`；导航可横向滚动，Queue 与 Detail 纵向排列，Resume dialog 完整落在视口内。
- 浏览器控制台：0 error，0 warning。
- 首屏截图：`prototype-preview.png`，不包含 helper 或模拟状态控件。

## 冻结记录

- 最终采用的交互：待评审。
- 放弃的方向：独立 Tutti 式桌面工作台；通用 Provider 权限收件箱；新的任务系统。
- 产品核心功能清单是否已确认：否。
- 原型辅助功能清单是否已确认：否。
- 最终截图：当前候选截图为 `prototype-preview.png`，待用户评审后确认是否冻结。
- 冻结时间：未冻结。

## 边界

- 原型不连接真实后端 API，不导入生产源码。
- 原型不能证明 `AttentionItem` projection、Reference handle、resolver 或跨页面深链已经存在。
- 当前 `/resume` 只接收 `{ note: string }`；原型假设 reference handle 可以先序列化进 note，正式实现仍需定义解析和权限边界。
- 原型中的实时引用是被动、只读上下文，不授权执行 split、resume、finding disposition 或文件写入。

## 实施计划衔接

原型尚未冻结，本轮不生成实施计划。冻结后必须把以下工作分开：

- 前端：Activity 导航、actionable projection UI、dialog/picker/inspector、URL identity。
- 后端/共享协议：`AttentionItem` DTO、幂等 action identity、Reference handle/resolver 和权限边界。
- 现有接线：split gate、focus pane、resume、finding disposition。
- 验收：静态检查之外，使用真实 Dev Session 与 Playwright 验证门禁动作和引用解析。
