# Activity & Insights Hub Prototype

> **状态：已被系统级方案取代，不作为实施依据。** 本原型的“从现有 Facts 通过确定性规则生成 Candidate Learning”不符合最新边界；当前依据改为 `docs/plans/2026-07-11-system-activity-data-foundation.md` 和 `docs/architecture-flows/system-activity-data-foundation-flow/`。本目录仅保留为此前产品方向的历史对照。

一次性产品原型，用于验证 Runweave 第一阶段的「事实与经验」页面：先集中展示可追溯的事实记录，再从多条事实中生成待人工确认的 Learning。

> 本目录只表达产品意图。页面数据和证据均为 mock，不代表当前产品已经具备对应查询页面或聚合协议。

## 当前阶段

- 用户目标：集中查看 Stable、Beta、Dev、CLI、Hook 和 Agent Team 产生的事实，并从事实中沉淀可复用经验。
- 用户动作：按时间、Runtime 和关键词筛选事实；打开事实查看原始上下文；打开候选 Learning 查看关联事实；确认后保存 Learning；检查 Source 覆盖率。
- 主要流程：Source 写入事实 → Activity Hub 保存事实和引用 → 确定性规则关联事实 → 生成 Candidate Learning → 用户核对后保存。
- 关键状态：事实已记录、Source 延迟、Candidate Learning、Saved Learning。
- 非目标：当前阶段不创建 Task/Requirement/Work Episode，不做任务状态与任务完成判断，不做生产力、返工、节省时间或置信度评分。
- 影响界面：建议在 Desktop/Web 新增顶层 `/activity` 页面，第一阶段只包含 Overview、Facts、Learnings、Sources。

## 当前代码事实

仓库已经具备以下可复用基础：

- `app-server/src/event-store.ts`：本机 append-only JSONL 事件存储，默认保留最近 7 天。
- `packages/shared/src/app-server-events.ts`：事件已有 `id`、`kind`、`source`、`scope`、`correlationId`、`payload`、`createdAt`。
- `app-server/src/state-store.ts`：保存从事件投影出的轻量 `ThreadRef`，包含 Thread、Project、Terminal、Panel、Run、cwd、状态和时间。
- `packages/shared/src/terminal/completion.ts`：Completion 已有 source、reason、commandName、cwd、summary、Panel 与创建时间。
- `packages/shared/src/terminal/events.ts`：已有 Project、Terminal Session、Panel、状态、通知、输入与 Completion 等事件类型。
- `app-server/src/http-server.ts`：提供 `/events`、`/events/stream`、`/threads` 与 `/sync/status`。

当前缺口：backend 内的 Terminal Event 只在内存保留最近 500 条；前端还没有 App Server Event 查询代理；Runtime channel 没有统一字段；Agent Team、Playwright verification 与 Source heartbeat 还没有统一的事实事件协议。

## 第一阶段事实目录

| 事实                             | 当前来源                                         | 需要补充                                                         |
| -------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------- |
| Agent hook / completion          | App Server `agent.hook`、`agent.completion`      | 前端只读查询代理                                                 |
| Thread 状态变化                  | `ThreadRef`、`thread.state.changed`              | 前端只读查询代理                                                 |
| Project / Terminal / Panel / cwd | Event scope、Terminal Event                      | 将需要保留的 Terminal Event 桥接到全局事实层                     |
| Completion summary               | `TerminalCompletionEventPayload.summary`         | 保存内容引用与脱敏策略                                           |
| Agent Team run 和 case source    | `.runweave/agent-team/<runId>.json`、case loader | 生成稳定 run fact event                                          |
| Verification result              | Playwright、更新器、runtime status 的实际结果    | 统一 `verification.result` 事件，显式写 target/observed identity |
| Source cursor / coverage         | Event cursor、sync status                        | 注册 producer heartbeat 与延迟阈值                               |
| Runtime                          | Stable/Beta home 与运行环境                      | Producer 显式写 `runtimeChannel=stable/beta/dev`                 |

事实必须保留 `eventId/kind/source/runtime/project/threadId/terminalSessionId/panelId/runId/createdAt` 中当前可用的字段，并提供原始 evidence reference。缺失字段保持缺失，不通过文本或时间邻近关系猜测。

## Learning 生成边界

Learning 不是直接从聊天文本自由总结，而是从已保存的事实引用生成：

```text
Facts
  -> deterministic rule
  -> Candidate Learning + factRefs
  -> human review
  -> Saved Learning
```

第一版允许模型润色标题和描述，但以下内容必须由事实决定：触发规则、事实数量、时间范围、Runtime、Project、Thread/Run 关联和 Evidence 列表。

原型中的两个例子：

- Runtime identity Learning：引用三条 `verification.result` 事实。
- Case-source Learning：引用两条 Agent Team source-gate 事实。

## 已删除范围

- Work Episodes / Tasks / Requirements 页面与导航。
- Qualified episode、Goal + outcome、Completed episode 等任务指标。
- Task ID、Activity ID、任务时间线和任务准入门槛。
- Attention Signal 中间层；第一阶段由 Facts 直接支撑 Learning。
- Rework、节省时间、生产力、专注度、百分比置信度和隐式任务分组。

## 启动

```bash
python3 -m http.server 6188 --directory docs/prototypes/activity-insights-hub
```

打开：

```text
http://127.0.0.1:6188/
```

## 采用的交互

- Overview 首屏展示事实量、关联 Thread、Completion 数量和 Source 健康度。
- Facts 页面按 `Fact / Kind / Runtime / Project / Source / Time` 展示原始事实，不做任务归并。
- 点击事实后，详情显示 Event ID、Kind、Project、Runtime、Source、Thread 和记录结果。
- Learning 卡片只显示已关联事实数量；详情列出每个事实 ID 和内容。
- 保存 Learning 时保留 fact references。
- Sources 页面显式展示 Stable、Beta、Dev、CLI 的 cursor、覆盖率与延迟。

## 功能分类账

### 产品核心功能

| 功能                | 原型中的入口或反馈                     |
| ------------------- | -------------------------------------- |
| 事实优先的 Overview | 事实指标、Recent facts、Learning inbox |
| Facts 列表          | 左侧 Facts 导航                        |
| 事实详情            | 统一右侧详情抽屉                       |
| Learning inbox      | Learnings 页面与保存动作               |
| Evidence 关联       | Learning 详情中的 linked facts         |
| Thread 外联         | 详情抽屉的 Open Thread                 |
| Source 完整性       | Sources 页面                           |

### 原型辅助功能

无可见辅助控件。数据加载来自本目录 `mock-state.json`，不作为生产数据已经存在的证明。

## 验证点

- 页面和 mock 数据中不存在 Work Episodes、Tasks 或 task grouping。
- Overview 只展示事实与 Learning。
- Facts 页面展示事实原始字段，并能按 Runtime 与关键词筛选。
- 点击事实后能看到 Event ID、Kind、Source、Thread 与 evidence。
- Learning 详情能追溯到具体 fact IDs，保存后状态变为 Saved。
- Sources 页面能暴露 Beta 延迟，而不是默认为数据完整。

## 浏览器验收记录

2026-07-11 使用 `playwright-cli` 在 `1440 × 960` 视口验证：

- 导航为 Overview、Facts、Learnings、Sources；页面无 Work Episodes、Tasks 或 Attention Signals。
- Overview 指标为 Facts retained、Linked Threads、Completion facts、Sources current。
- Facts 页面显示 10 条记录，列为 Fact、Kind、Runtime、Project、Source、Time。
- Fact 详情包含 Event ID、Kind、Project、Runtime、Source、Thread ID；存在 Thread 时显示 Open Thread。
- Beta Runtime 筛选显示 3 条事实；继续搜索 `verification` 后显示 2 条。
- Runtime identity Learning 关联 3 个具体 fact IDs，保存后提示 fact references 已保留。
- Sources 页面显示 4 个来源，其中 1 个 delayed。
- 浏览器控制台：0 error，0 warning。
- 首屏截图：`prototype-preview.png`。
