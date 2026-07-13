# Terminal Activity Journal Prototype

面向 `/activity` 重构方向的可运行 HTML 原型。当前采用“活动档案 / 工作日志”视觉语言：以 Terminal ID 作为稳定档案主键，把 Terminal、Codex Thread、Turn 和 Activity facts 编排到同一条时间线上，并按事件类型展示不同详情。

参考方向：普通 Terminal 使用 [Activity Journal 方案](./references/02-activity-journal.png)，Multi-Agent 使用 [Round Journal 方案](./references/06-multi-agent-round-journal.png)。

## 启动

```bash
python3 -m http.server 6188 --directory docs/prototypes/terminal-activity-archives
```

打开：

```text
http://127.0.0.1:6188/
```

## 原型简报

- 用户目标：以可阅读的时间线回看一个 Terminal 中发生的完整过程，并在需要时下钻查看原始事实、Thread 消息或 Turn 结果。
- 主要动作：选择 Terminal、按事件类型筛选、选择事件、查看事件专属详情、从 Turn 或 Fact 跳转到关联 Thread。
- 核心语义：一个 `terminalSessionId` 始终对应一条 Terminal 档案；退出 Codex TUI 后重新进入并创建新 Thread，只在该档案内增加新的 Thread 段落。
- 特殊路线：Multi-Agent Run 继续作为独立产品对象展示，不混入普通 Terminal 时间线。
- 非目标：不生成生产力分数、节省时间、文件变更、未记录命令输出、未记录消息、未发生的 Worker 角色或不存在的关联关系。
- 产品影响界面：`frontend/src/pages/activity-page.tsx` 对应的 `/activity` 页面，或后续新增的 Work History 页面。

## 当前采用的交互

### Terminal 列表

- 左侧列表只以 Terminal 为一条记录，Terminal ID 是稳定标识。
- 列表展示 project、状态、Thread 数和 Turn 数。
- 搜索范围包含 Terminal ID、project、cwd、Agent、Thread ID 和 Thread preview。

### Activity Journal

- 中间区域按记录时间升序排列，并按日期分组。
- 默认 `Journal` 只展示 Session、Thread、Turn 和 Thread 状态，减少底层重复事实对阅读的干扰。
- `All events` 展示该 Terminal 当前快照中的全部编排事件和 Activity facts。
- `Threads`、`Turns`、`Raw facts` 用于按事实类型下钻。
- Thread 起点在时间线上独立出现，因此同一个 Terminal 退出 Codex、重新进入后创建的新 Thread 能被清楚分段。

### Event Inspector

- 宽屏时作为右侧内嵌面板；视口宽度低于 1380px 时改为抽屉。
- 未选择事件时 Inspector 关闭，中间时间线占满可用空间。
- Terminal 事件展示 session 身份与数据源状态。
- Thread 事件展示 Thread 身份和该 Thread 的全部已记录消息。
- Turn 事件展示用户消息、记录结果、耗时、状态、item 数和关联 Thread。
- Activity fact 展示原始 event name、payload、来源、时间和显式可解析的关联 Thread。
- 固定快照没有消息正文时，明确显示“不在快照中”，不根据 item 数补写内容。

### Multi-Agent Round Journal

- Multi-Agent Run 仍是独立路线，左侧列表以 Run ID 为主键，不混入普通 Terminal 列表。
- 中间 Journal 按 `Setup → Round N → Acceptance` 分节；Round 分节由真实 round 归因动态生成，不预设固定轮数。
- 样例只展示 `Round 1`。持久化 Run 中的 `loop.round = 2` 表示下一轮索引，不能证明 Round 2 已执行。
- Worker 派发、Worker 结果和 Acceptance Case 都展示本次发生时的 Round；Worker 身份本身仍跨 Round，不在 Worker 上永久绑定轮次。
- `Workers`、`Acceptance`、`Raw facts` 提供不同索引视图；详情仍统一进入右侧 Inspector。
- Acceptance Inspector 可继续下钻 5 条已有 evidence；不补写测试数、文件改动或不存在的 Worker 结果。

## 数据组织

```text
Terminal session
  ├─ session lifecycle
  ├─ Activity facts by terminalSessionId
  └─ Codex ThreadRefs by terminalSessionId
       └─ thread/read(includeTurns=true)
            └─ Turns and recorded message items

Multi-Agent Run
  ├─ Setup facts and run logs
  ├─ Round history
  │    ├─ Worker dispatch snapshot
  │    ├─ Worker result
  │    └─ Round progress log
  ├─ Acceptance cases and evidence
  └─ Activity facts by runId
```

普通 Terminal 的事件仍是展示层编排。Multi-Agent 为了能够准确按 Round 归档，补充了一个最小的生产字段：`AgentTeamActiveWorkerDispatch.round?`；新产生的 Worker/Case activity payload 会携带 `round`，旧持久化 Run 没有该字段时继续兼容读取。

| 展示事件                 | 当前事实来源                                 | Inspector 内容                                  |
| ------------------------ | -------------------------------------------- | ----------------------------------------------- |
| Terminal session         | Terminal session                             | ID、project、cwd、command、状态、数据源可用性   |
| Codex thread             | ThreadRef + `thread/read`                    | Thread ID、状态、时间、Turns、已记录消息        |
| Codex turn               | `thread/read(includeTurns=true)`             | prompt、result、status、duration、items         |
| Recorded fact            | Activity fact                                | event name、payload、source、occurred time      |
| Thread state             | Thread snapshot                              | status、last activity、completion reason        |
| Worker dispatch / result | Agent Team dispatch snapshot + Activity fact | role、pane、panel、attempt、发生时的 Round      |
| Acceptance case          | Agent Team acceptance + evidence             | case、status、attempt、发生时的 Round、evidence |

时间邻近不建立关联。只有 Terminal ID、Thread ID、Run ID 等显式字段或当前固定快照中保留的关联内容才用于跳转。

## 事实样本

- `d5023252`：1 个 Codex Thread、4 个 Turns、11 条 Activity facts；4 个 Turns 的 prompt/result 文本均在固定快照中，作为默认阅读样本。
- `79c39e47`：同一个 Terminal 下 4 个 Codex Threads、33 个 Turns；用于验证“一个 Terminal，多段 Codex 会话”。该历史快照只有 Turn 元数据，没有消息正文。
- `77596d14`：1 个已关联 Thread、0 个已加载 Turns、6 条 Activity facts；用于展示数据部分可用状态。
- `f4741241`：TraeX Terminal、无 Codex Thread；只展示 Terminal 与 Activity 可得事实。
- `atr_406e9cdd_20260712050528`：独立 Multi-Agent Run，1 个 Worker、完成 1 个 Round、1/1 Acceptance pass、5 条 evidence。Run 日志只明确记录了 Round 1 有进展。

## 产品核心功能

| 功能                                             | 是否进入后续产品范围 |
| ------------------------------------------------ | -------------------- |
| Terminal ID 主列表                               | 是                   |
| 同一 Terminal 内多个 Thread 时间段               | 是                   |
| 异构事件的统一时间轴                             | 是                   |
| Journal / All / Threads / Turns / Raw facts 筛选 | 是                   |
| 事件类型专属 Inspector                           | 是                   |
| Thread 完整消息查看与缺失态                      | 是                   |
| 宽屏内嵌、窄屏抽屉                               | 是                   |
| Multi-Agent Run 独立路线                         | 是                   |
| Setup / Round / Acceptance 动态分节              | 是                   |
| Worker / Case 的 Round 事实归因                  | 是，本轮已补生产字段 |
| Workers / Acceptance / Raw facts 索引视图        | 是                   |

## 原型辅助功能

无可见辅助控件。`mock-state.json` 用于固定页面方向，不代表生产 API 已完成 Terminal、Thread、Turn 与 Fact 的聚合。

## 放弃的方向

- 不再使用 Overview / Threads / Recorded facts 三个 Tab 分割同一个 Terminal。
- 不以监控台表格作为普通用户默认入口。
- 不把所有 Activity facts 做成与用户请求同等视觉权重的卡片。
- 不把 Multi-Agent Run 当作普通 Terminal 的一种事件类型。
- 不因为 Codex TUI 退出或 Thread 变化就拆分 Terminal 档案。
- 不根据时间邻近推断 Thread、命令、文件变更或因果关系。

## 浏览器验证

2026-07-13 使用 `playwright-cli` 在真实浏览器验证：

- 1600 × 1000：Inspector 作为 392px 内嵌右栏，时间线与 Terminal 列表独立滚动。
- 1200 × 800：Inspector 为 430px fixed drawer，存在遮罩；关闭后 Inspector 与遮罩均移除。
- `d5023252` 默认 Journal 显示 7 个编排事件；`All events` 显示 18 个事件；`Raw facts` 恰好显示 11 条 Fact。
- 从一个 Turn 的 Related Thread 进入 Thread Inspector 后，展示 8 条已记录消息。
- `79c39e47` 在 Terminal 列表中只有 1 条记录；Journal 中存在 4 个 Thread 起点和 33 个 Turns。
- `79c39e47` 的历史 Thread Inspector 不生成消息正文，按 Turn 显示 8 条内容缺失状态。
- 搜索 `77596d14` 后只显示该 Terminal。
- Multi-Agent Journal 只显示 `Setup → Round 1 → Acceptance`，没有根据 `loop.round = 2` 虚构 Round 2。
- Multi-Agent 路线显示 1 Worker、1 个已完成 Round、1 Acceptance Case、5 条 evidence 和 6 条 Run Activity facts。
- Worker Inspector 显示 `behavior_verify`、pane `%2` 与 Round 1；Acceptance Inspector 可逐条进入 evidence 详情。
- Raw facts 对旧 Worker/Case payload 显示 `Round absent`，对 `run.completed.round = 2` 显示 `Next index 2`；不把展示归因冒充为旧事件原始字段。
- 1600 × 1000 下 Multi-Agent Inspector 内嵌；1200 × 800 下切换为带遮罩的 fixed drawer，关闭后正确移除。
- 切回 Terminal history 后默认 Journal 仍显示 7 个编排事件。
- 浏览器控制台：0 error、0 warning。

当前截图：[普通 Terminal](./prototype-preview.png)；[Multi-Agent Round Journal](./multi-agent-round-preview.png)。

## 边界

- 本轮原型改动位于 `docs/prototypes/terminal-activity-archives/`；产品代码只补充 Agent Team Round 归因字段及其 Activity payload，不改现有调度策略。
- 原型不连接真实后端，不导入产品源码。
- mock 来自既有只读查询结构和固定快照；历史 Worker/Case 事件的 `round` 保持缺失，Journal 的 Round 1 归因明确标注来自 Run log，新产生的事件才直接读取本轮新增字段。
- Journal 是展示层阅读编排，不证明生产端已存在聚合 API、复盘协议或持久化事件模型。
- 产品实现前仍需核对 `frontend/src/pages/activity-page.tsx`、`frontend/src/services/activity.ts`、Terminal session 合约、Activity timeline API 和 Codex App Server 只读代理链路。
