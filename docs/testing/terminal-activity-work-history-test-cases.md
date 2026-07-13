# Terminal Activity Work History 测试用例

> 日期：2026-07-13
> 原型基线：[`docs/prototypes/terminal-activity-archives/`](../prototypes/terminal-activity-archives/)
> 状态：待实现后执行

## 1. 验收目标

验证 `/activity` 从“原始 Activity 数据查看器”扩展为可回看的 Work History，同时满足以下不可妥协条件：

1. 普通 Terminal 与 Multi-Agent Run 分开组织。
2. 同一个 Terminal 内退出并重新进入 Codex 后仍只有一条 Terminal 档案，多个 Thread 在档案内分段。
3. 关联只使用明确 ID，不靠时间接近度猜测。
4. Thread 消息由 Codex App Server 按需实时读取，不复制进 Activity 数据库。
5. 数据源缺失时明确降级，不使用占位数据伪装完整。
6. 现有 Events、Timeline、Sources、Data Policy 无功能回归。

## 2. 范围

### 2.1 本轮覆盖

- Work History 共享 DTO。
- App Server Codex Thread detail 读取及 Backend 代理。
- `/api/work-history/terminals` 列表与详情。
- `/api/work-history/runs` 列表与详情。
- Terminal History 列表、Journal、Inspector。
- Multi-Agent Run 列表、Round Journal、Inspector。
- 响应式内嵌面板/抽屉。
- 鉴权、分页、部分数据源不可用、历史字段缺失和请求竞态。
- 原有 Activity 子页面回归。

### 2.2 本轮不覆盖

- 模型生成的复盘、经验总结或生产力评价。
- 从 Scrollback 解析对话。
- 非 Codex Provider 的详情读取实现；只验证显式 unsupported 状态。
- Windows 打包。
- 单元测试/TDD。

## 3. 测试环境与证据要求

### 3.1 环境

- 使用 `$toolkit:runweave-change-validation` 生成的独立 Dev Session。
- UI 验收目标只能通过 `pnpm dev:open --session <id> --surface desktop --json` 解析。
- 浏览器操作必须使用 `$toolkit:playwright-cli` 的 `attach --cdp=<endpoint>` 显式附着本次实例。
- API 验证使用同一 Dev Session 的 Backend/App Server 地址和当前登录态。
- 如工作区有无关改动，在独立 worktree 只应用本次 patch。

### 3.2 基础命令

```bash
pnpm work-history:verify
pnpm activity:verify
pnpm typecheck
pnpm lint
pnpm build
git diff --check
```

### 3.3 每条用例至少保存

- Dev Session ID、profile 与目标 URL/CDP endpoint。
- 使用的 `terminalSessionId`、`threadId` 或 `runId`。
- API 请求与关键结构化响应，敏感消息正文可脱敏。
- UI 用例的 Playwright 命令、DOM 断言和必要截图。
- 失败时保存控制台、请求失败原因和相关服务日志。

静态原型截图只能作为视觉对照，不能作为产品行为验收证据。

## 4. 必跑矩阵

| 编号   | 场景                               | 层级                  | 必跑 |
| ------ | ---------------------------------- | --------------------- | ---- |
| AGT-WH-001 | Activity 新导航与默认视图          | UI                    | 是   |
| AGT-WH-002 | 同一 Terminal 关联两个 Thread      | API + UI              | 是   |
| AGT-WH-003 | 退出/重进 Codex 不拆 Terminal 档案 | 实际行为 + UI         | 是   |
| AGT-WH-004 | Terminal Journal 异构事件稳定排序  | API + UI              | 是   |
| AGT-WH-005 | Codex Thread Turn/消息按需读取     | App Server + API + UI | 是   |
| AGT-WH-006 | Codex Provider 不可用时降级        | API + UI              | 是   |
| AGT-WH-007 | Activity 数据源不可用时降级        | API + UI              | 是   |
| AGT-WH-008 | Facts 快照分页无重复/跳项          | API + UI              | 是   |
| AGT-WH-009 | Activity Fact/Content 详情语义     | UI                    | 是   |
| AGT-WH-010 | Inspector 宽屏内嵌、窄屏抽屉       | UI                    | 是   |
| AGT-WH-011 | Terminal 搜索、排序和稳定游标      | API + UI              | 是   |
| AGT-WH-012 | Multi-Agent Run 独立列表           | API + UI              | 是   |
| AGT-WH-013 | nextRoundIndex 与已呈现轮次区分    | API + UI              | 是   |
| AGT-WH-014 | 多轮、补充 Worker 与重试结构       | UI                    | 是   |
| AGT-WH-015 | 历史 Round 缺失与归属来源          | API + UI              | 是   |
| AGT-WH-016 | Acceptance Evidence 真实下钻       | API + UI              | 是   |
| AGT-WH-017 | 无事实字段不展示假数据             | UI                    | 是   |
| AGT-WH-018 | 非 Codex/未知 Thread Provider      | API + UI              | 是   |
| AGT-WH-019 | Work History 与 Thread detail 鉴权 | API                   | 是   |
| AGT-WH-020 | 禁止按时间建立跨对象关联           | 脚本 + API            | 是   |
| AGT-WH-021 | 原 Activity 子页面回归             | UI                    | 是   |
| AGT-WH-022 | 切换对象时旧请求不可覆盖新选择     | UI                    | 是   |
| AGT-WH-023 | Thread 上限与部分加载状态          | API + UI              | 是   |
| AGT-WH-024 | 对象删除/不存在后的恢复            | API + UI              | 是   |

## 5. 详细用例

### AGT-WH-001 Activity 新导航与默认视图

前置条件：

- 用户已登录 Runweave。
- 至少存在一个 Terminal Session。

步骤：

1. 打开 `/activity`，不携带 query 参数。
2. 依次检查左侧导航。

期望：

- 默认选中 Terminal History。
- 导航同时存在 Terminal History、Multi-Agent Runs、Events、Timeline、Sources、Data Policy。
- 当前全局页面壳层、左侧导航样式和路由行为未被破坏。
- 刷新页面后默认视图稳定。

失败判定：

- 默认落到旧 Question/Response Activity。
- 现有任一 Raw data/Data 入口消失。
- 页面出现空白、未捕获异常或无限加载。

**验证与证据**

- Playwright DOM 断言导航文本与选中状态。
- 保存 `/activity` 初始页面截图。

### AGT-WH-002 同一 Terminal 关联两个 Thread

前置条件：

- 一个固定 `terminalSessionId=T1`。
- App Server 中存在 `threadId=A`、`threadId=B`，两个 ThreadRef 的 `terminalSessionId` 都为 T1。

步骤：

1. 请求 Terminal archive 列表。
2. 请求 T1 详情。
3. 在 UI 选择 T1。

期望：

- 列表只存在一条主键为 T1 的档案。
- `knownThreadCount=2`。
- 详情包含 A、B 两个 ThreadRef。
- 中间 Journal 以两个 Thread 分段呈现，不生成第二条 Terminal 档案。

失败判定：

- 每个 Thread 生成一条 Terminal 记录。
- A/B 中任一 Thread 被错误关联到其他 Terminal。
- Thread 数通过 N+1 detail 请求才得到。

**验证与证据**

- `pnpm work-history:verify` 对应断言。
- 列表/详情 API 响应。
- UI 中 T1 列表项与两个 Thread 分段截图。

### AGT-WH-003 退出/重进 Codex 不拆 Terminal 档案

前置条件：

- 新建一个真实 Terminal Session T1。

步骤：

1. 在 T1 内进入 Codex，提交一轮请求并记下 Thread A。
2. `Ctrl+C` 退出 Codex TUI，回到同一 Shell。
3. 在同一个 T1 再次进入 Codex，创建新 Thread B 并提交请求。
4. 打开 Terminal History。

期望：

- 仍只有一条 T1 档案。
- T1 的 Terminal 创建时间保持不变，最后活动时间更新。
- A、B 作为两个 Thread 段按实际时间出现。
- 退出 TUI 可以表现为 Thread interrupted/completed 或后续 Terminal 活动，但不能表现为 Terminal 被删除并重建。

失败判定：

- 出现两条不同 Terminal 档案。
- Thread B 覆盖 A，导致 A 无法回看。
- UI 使用命令名或 Thread ID 作为 Terminal 主键。

**验证与证据**

- 实际 Terminal 操作记录。
- T1、A、B 的明确 ID。
- API 和 UI 前后对照。

### AGT-WH-004 Terminal Journal 异构事件稳定排序

前置条件：

- T1 同时具有 Terminal 生命周期、Activity Facts、两个 Thread 的 Turn。
- 至少两条事件时间相同。

步骤：

1. 请求 T1 详情。
2. 连续两次打开 T1 Journal。

期望：

- Journal 按 `occurredAt asc` 排序。
- 同一时间使用固定类型优先级和 `sourceId` 得到稳定顺序。
- Terminal、Thread、Activity 等不同事件使用可区分的标题/图标/属性。
- 排序不改变原始 `sourceId`，也不创建新的隐式关联。

失败判定：

- 相同数据刷新后顺序随机变化。
- 某类事件因字段不同导致组件崩溃。
- 为排序而修改事实时间。

**验证与证据**

- 两次 DOM 顺序快照。
- 选取事件的 sourceType/sourceId/occurredAt 对照。

### AGT-WH-005 Codex Thread Turn/消息按需读取

前置条件：

- 存在一个真实 Codex Thread，至少包含一条用户消息和一条助手消息。
- ThreadRef 已关联到 T1。

步骤：

1. 只请求 Terminal 列表。
2. 请求 `/api/app-server/threads/:threadId/detail`。
3. 在 T1 Journal 选择对应 Thread 事件。

期望：

- Terminal 列表阶段不调用 `thread/read(includeTurns=true)`。
- detail 接口返回 `availability=available`、Turn status/itemsView/itemCount，以及用户/助手文本消息。
- Inspector 展示相同 Turn 和消息顺序。
- 默认 DTO 不暴露 reasoning、命令 stdout、文件 Diff 或工具内部参数。
- Activity 数据库中没有新增完整对话副本。

失败判定：

- 列表产生 N+1 Thread detail 请求。
- 消息由 Scrollback 解析而来。
- Thread 内容写入 Activity Fact payload/content 作为长期副本。

**验证与证据**

- App Server 请求日志中的 `includeTurns: true` 仅在详情读取出现。
- detail API 结构化响应与 Inspector DOM。
- Activity query 中无新增消息正文事实。

### AGT-WH-006 Codex Provider 不可用时降级

前置条件：

- T1、ThreadRef 和 Activity Facts 已存在。
- Codex Provider 被停止或 detail reader 被可控地置为不可用。

步骤：

1. 请求 T1 详情。
2. 选择 Thread 事件。

期望：

- T1 Terminal 信息与 Activity Journal 仍显示。
- Thread detail 返回 `provider_unavailable`，页面显示明确不可用原因。
- App Server `/health` 与 Backend 其他 API 不因该请求退出。
- UI 提供可重试动作或重新选择对象的路径。

失败判定：

- 整个页面空白或持续 loading。
- 500 文本直接泄漏到用户界面。
- 用缓存占位消息伪装为实时读取结果。

**验证与证据**

- Provider 停止前后 API 对照。
- 页面 source status 和 Inspector 截图。

### AGT-WH-007 Activity 数据源不可用时降级

前置条件：

- T1 与 Codex Thread detail 可用。
- Activity Query 暂时失败或返回 unavailable。

步骤：

1. 打开 T1。
2. 读取 Terminal/Thread 部分。

期望：

- Terminal 身份、状态和 Thread 内容仍显示。
- Activity source status 为 unavailable/partial，并给出事实层错误原因。
- 不把“Activity 不可用”误报为“Terminal 不存在”。

失败判定：

- 任一来源失败导致整份 archive 404。
- 页面隐藏错误并显示虚构事件。

**验证与证据**

- Work History detail 响应中的 sourceStatus。
- UI 降级截图。

### AGT-WH-008 Facts 快照分页无重复/跳项

前置条件：

- T1 至少有 205 条 Activity Facts。

步骤：

1. 读取首屏 200 条并记录 `asOfActivityOffset`、`nextCursor`。
2. 在数据源中新增一条 Fact。
3. 使用相同 offset/cursor 读取下一页。
4. 刷新 archive 后重新读取。

期望：

- 当前快照翻页不出现重复或遗漏。
- 新增 Fact 不插入旧快照中。
- 刷新后新快照可看到新增 Fact。
- UI 显示“加载更多”或完整数量状态，不静默截断为 200。

失败判定：

- 新数据导致游标漂移。
- UI 误称已展示全部事件。

**验证与证据**

- 两页 factId 集合与 offset/cursor。
- 新旧快照差异。

### AGT-WH-009 Activity Fact/Content 详情语义

前置条件：

- 一条带可用 `contentId` 的 Fact。
- 一条 Content 已过期或已删除的 Fact。

步骤：

1. 分别选择两个 Fact 事件。

期望：

- 可用 Content 按现有 Activity policy 读取。
- 过期/删除 Content 明确显示 unavailable/expired，不显示空字符串冒充正文。
- Inspector 保留事实类型、时间、terminal/thread/run 等可用字段。

失败判定：

- Work History 绕过现有 Content policy。
- Content 不可用导致整个 Journal 崩溃。

**验证与证据**

- 两种状态的 API 响应和 Inspector 截图。

### AGT-WH-010 Inspector 宽屏内嵌、窄屏抽屉

前置条件：

- T1 Journal 至少有一个可查看详情的事件。

步骤：

1. 浏览器宽度设为 1440，选择事件。
2. 浏览器宽度设为 1100，再次选择事件。
3. 使用 Escape/关闭按钮关闭详情。

期望：

- 1440 宽度下 Inspector 内嵌在右侧，不遮挡列表和 Journal 的关键操作。
- 1100 宽度下使用抽屉。
- 关闭后焦点回到触发事件，Journal 恢复可用宽度。
- 抽屉具备可访问名称、焦点约束和键盘关闭能力。

失败判定：

- 两种宽度都永久占据第三栏。
- 抽屉关闭后焦点丢失或页面不可滚动。

**验证与证据**

- Playwright 两种 viewport 截图。
- 键盘交互与焦点断言。

### AGT-WH-011 Terminal 搜索、排序和稳定游标

前置条件：

- 至少 105 个 Terminal，包含相同 `lastActivityAt`、不同 ID、不同 cwd/command/project。

步骤：

1. 使用 `limit=100` 请求两页。
2. 以 Terminal ID、项目名、cwd 或可支持的文本字段搜索。
3. 输入 257 字符搜索串和非法 limit。

期望：

- 排序为 `lastActivityAt desc + terminalSessionId`，无重复/遗漏。
- 搜索结果只基于合约声明字段。
- 过长 search、越界 limit 返回明确 400 或被按合约安全归一化。
- UI 输入防抖且清空后恢复完整列表。

失败判定：

- 相同时间记录跨页漂移。
- 模糊搜索偷偷读取 Thread 消息正文。

**验证与证据**

- 两页 ID 集合、排序断言、非法参数响应。
- UI 搜索前后 DOM。

### AGT-WH-012 Multi-Agent Run 独立列表

前置条件：

- 至少两个项目各存在一个 Agent Team Run。
- 每个 Run 都关联某个 Terminal。

步骤：

1. 打开 Multi-Agent Runs。
2. 切回 Terminal History。

期望：

- Run 列表跨当前可见项目汇总，以 `runId` 为主键。
- Run 不作为普通 Terminal 卡片类型混入 Terminal History。
- Terminal History 仍可在事件详情中显示明确的 `runId` 关联，但不复制一份 Run Journal。
- 切换视图保持各自选择或按 query 合约恢复。

失败判定：

- Run 列表仅显示当前选中 Project 而无明确产品限制。
- 一个 Run 因多个 Worker 产生多条列表记录。

**验证与证据**

- 两项目 Run API 响应。
- 两个导航视图截图。

### AGT-WH-013 nextRoundIndex 与已呈现轮次区分

前置条件：

- 一个 Run 已完成 Round 1，`run.loop.round=2`。

步骤：

1. 请求 Run archive 详情。
2. 打开 Round Journal。

期望：

- DTO 可返回 `nextRoundIndex=2`。
- UI 只呈现有事实来源的 Round 1。
- UI 不显示“已完成 2 轮”。

失败判定：

- 直接把 `loop.round` 当成 completed round count。
- 无事件的 Round 2 被伪造成已完成阶段。

**验证与证据**

- Run 原始 JSON 与派生 UI 对照。

### AGT-WH-014 多轮、补充 Worker 与重试结构

前置条件：

- 一个真实或受控 fixture Run，包含 Setup、Round 1、Round 2、Acceptance。
- Round 2 有补充 Worker 或重试。

步骤：

1. 打开 Run Journal。
2. 展开两个 Round。

期望：

- Setup、Round 1、Round 2、Acceptance 分节顺序正确。
- 每轮的 dispatch、worker/pane、结果、重试只出现在正确 Round。
- 同一 Worker 的重试有独立事件 ID，不覆盖之前结果。
- 简单信息卡没有原型占位数字。

失败判定：

- 所有 Worker 被铺成普通连续时间线且看不出轮次。
- Round 2 事件错误归入 Round 1。

**验证与证据**

- Run/Activity 原始事实与 UI 各节事件 ID 清单。

### AGT-WH-015 历史 Round 缺失与归属来源

前置条件：

- 事件 E1 payload 明确 `round=1`。
- 事件 E2 payload 缺少 round，但 dispatch snapshot 明确 `round=2`。
- 事件 E3 缺少两者，Run 日志只出现一个无矛盾 Round。
- 事件 E4 缺少两者且 Run 有多个可能 Round。

步骤：

1. 打开 Run Journal 并查看四个事件详情。

期望：

- E1 来源为 `activity_payload`。
- E2 来源为 `dispatch_snapshot`。
- E3 允许来源为 `run_log_single_round`。
- E4 来源为 `unavailable`，出现在未归属事件。
- Inspector 可查看归属来源。

失败判定：

- E4 按时间戳或数组顺序被强行归轮。
- UI 隐藏归属来源，无法区分事实与兼容推导。

**验证与证据**

- `work-history:verify` 四种来源断言。
- UI 对应 provenance 文本。

### AGT-WH-016 Acceptance Evidence 真实下钻

前置条件：

- Run 已有 `AgentTeamAcceptanceEvidence`，包含 type、label、summary、ref，部分可含 detail。
- 另一个 Run 没有 Evidence。

步骤：

1. 选择有 Evidence 的 Acceptance 事件。
2. 选择无 Evidence 的 Run。

期望：

- Inspector 只展示 Store 中真实存在的字段。
- ref 按现有安全规则显示或跳转。
- 无 Evidence 显示“未记录”，不生成 `18/18 checks`、测试路径或成功结论。

失败判定：

- 使用原型图片中的占位结果。
- 缺失 detail 导致 Evidence 卡片崩溃。

**验证与证据**

- Run JSON、API DTO 与 UI 三方对照。

### AGT-WH-017 无事实字段不展示假数据

前置条件：

- Terminal/Run 数据缺少 token、代码改动量、测试数量、模型总结等字段。

步骤：

1. 浏览列表、Journal、Inspector 的所有可见区域。

期望：

- 页面不出现无法由事实源证明的指标。
- 必需槽位缺数据时显示“未记录/不可用”，可省略的槽位直接不渲染。
- 不用随机数、mock 文本或根据消息长度推导指标。

失败判定：

- 页面出现原型中的占位计数或总结。
- 使用“预计”“大约”掩盖未采集数据。

**验证与证据**

- UI 全页文本扫描。
- 字段到 DTO 来源对照表。

### AGT-WH-018 非 Codex/未知 Thread Provider

前置条件：

- 一个 Provider 不是 Codex 的 ThreadRef，或一个旧 ThreadRef 的 provider 无法识别。

步骤：

1. 请求 Thread detail。
2. 在 Terminal Journal 选择该 Thread。

期望：

- 接口返回 `provider_unsupported`。
- Terminal 和 ThreadRef 元数据仍可见。
- UI 不尝试调用 Codex `thread/read`，也不伪造消息。

失败判定：

- 返回误导性的 `thread_not_found`。
- 调用错误 Provider 并泄漏内部错误。

**验证与证据**

- App Server 请求日志和结构化响应。
- Inspector 状态截图。

### AGT-WH-019 Work History 与 Thread detail 鉴权

前置条件：

- 有效登录态和一组真实 Terminal/Thread/Run 数据。

步骤：

1. 无登录态请求四个 Work History 接口和 Backend Thread detail。
2. 使用有效登录态重复请求。
3. 检查服务日志。

期望：

- 无登录态请求返回 401，不包含 Terminal、消息或 Evidence 数据。
- 登录后返回合约数据。
- 消息正文不写入普通 request/error 日志。

失败判定：

- 列表接口匿名可读。
- 错误日志输出完整对话正文。

**验证与证据**

- 401/200 请求对照。
- 脱敏日志片段。

### AGT-WH-020 禁止按时间建立跨对象关联

前置条件：

- T1 与 T2 在相近时间产生事件。
- Thread A 时间更接近 T2，但 ThreadRef 明确 `terminalSessionId=T1`。
- Run R1 时间接近 T1，但明确关联 T2。

步骤：

1. 执行 read-model 验证脚本。
2. 分别请求 T1、T2 详情。

期望：

- A 只出现在 T1。
- R1 的明确关联只指向 T2。
- 任一未带明确 ID 的事件保持未关联或仅存在于原始 Events。

失败判定：

- 任何对象因时间最近被错误吸附。

**验证与证据**

- fixture ID/时间设计与 API 结果。
- `work-history:verify` 对应断言。

### AGT-WH-021 原 Activity 子页面回归

前置条件：

- 已有 Activity Facts、Timeline、Sources 与 Data Policy 数据。

步骤：

1. 依次打开 Events、Timeline、Sources、Data Policy。
2. 执行已有查询、详情、导出/删除前置确认等只读可验证流程。

期望：

- Events 仍能查询和选择 Fact。
- Timeline 仍按显式 interaction/correlation/thread/run ID 查询。
- Sources 仍能展示来源。
- Data Policy 仍保留原有项目/Thread 导出删除能力及确认保护。
- Work History query 参数不污染这些视图。

失败判定：

- 为做新导航删除了旧能力。
- Data Policy 误操作或确认逻辑变化。

**验证与证据**

- Playwright 每个入口的关键 DOM 断言。
- `pnpm activity:verify` 结果。

### AGT-WH-022 切换对象时旧请求不可覆盖新选择

前置条件：

- T1 detail 人为延迟，T2 detail 快速返回。

步骤：

1. 点击 T1。
2. 在 T1 返回前立即点击 T2。
3. 等待两个请求都结束。

期望：

- 最终列表选中、Journal、Inspector 与 URL 都是 T2。
- T1 晚到响应被取消或忽略。
- 不出现 T2 标题配 T1 内容的混合状态。

失败判定：

- 晚到响应覆盖当前选择。
- loading 状态永久不结束。

**验证与证据**

- Playwright 路由拦截/受控延迟与最终 DOM 断言。

### AGT-WH-023 Thread 上限与部分加载状态

前置条件：

- T1 关联 55 个 ThreadRef。

步骤：

1. 请求 T1 初始详情。
2. 观察 App Server 并发与 UI source status。
3. 使用“加载更多 Thread”读取剩余 5 个。

期望：

- 初次最多读取 50 个 Thread detail。
- 同时 detail 请求数不超过 4。
- DTO/UI 明确 `partial`，不声称全部已加载。
- 加载剩余 Thread 后去重并恢复 available/completed 状态。

失败判定：

- 一次并发 55 个 Provider 请求。
- 静默丢弃剩余 5 个。
- 重复加载造成 Thread 段重复。

**验证与证据**

- App Server 请求并发日志。
- 加载前后 Thread 数和 source status。

### AGT-WH-024 对象删除/不存在后的恢复

前置条件：

- UI 当前选中 T1 或 R1。

步骤：

1. 在另一路径显式删除 T1，或使 R1 不再存在。
2. 刷新详情或从带选中 ID 的 URL 直接进入。

期望：

- Backend 返回明确 404/对象不存在响应。
- UI 清除失效选中项，保留列表并提示对象不存在。
- 用户可以选择其他对象，页面不陷入循环重试。
- 不因为对象不存在删除 Activity Facts 或其他档案。

失败判定：

- 页面白屏或无限请求。
- 自动选择错误的同名对象冒充原 ID。

**验证与证据**

- 删除前后 API 响应。
- 带失效 query 的 UI 恢复过程。

## 6. 需求覆盖映射

| 计划能力                       | 覆盖用例                               |
| ------------------------------ | -------------------------------------- |
| Terminal 以 session 为唯一档案 | AGT-WH-002、AGT-WH-003、AGT-WH-020                 |
| 多 Thread 分段与按需详情       | AGT-WH-002、AGT-WH-004、AGT-WH-005、AGT-WH-018、AGT-WH-023 |
| Work History 聚合与分页        | AGT-WH-007、AGT-WH-008、AGT-WH-011、AGT-WH-019、AGT-WH-024 |
| Multi-Agent 独立路线           | AGT-WH-012、AGT-WH-013、AGT-WH-014                 |
| Round 真实归属和历史兼容       | AGT-WH-013、AGT-WH-015                         |
| Acceptance 真实 Evidence       | AGT-WH-016、AGT-WH-017                         |
| Inspector/Drawer               | AGT-WH-009、AGT-WH-010、AGT-WH-022                 |
| 不过度设计/不伪造字段          | AGT-WH-005、AGT-WH-015、AGT-WH-016、AGT-WH-017、AGT-WH-020 |
| 原 Activity 能力回归           | AGT-WH-001、AGT-WH-021                         |
| 鉴权和数据保护                 | AGT-WH-005、AGT-WH-019                         |

## 7. 执行规则

1. 先执行 `work-history:verify` 和 `activity:verify`，失败则停止 UI 验收并修复事实层。
2. 再执行 typecheck、lint、build、diff check。
3. 使用 Dev Session planner 生成目标环境，不手工启动 Backend/App Server/Electron 绕过 planner。
4. 按必跑矩阵顺序执行；任一必跑用例真实失败，记录证据并停止宣称完成。
5. 修复后只重跑失败、未执行、依赖该失败项及受改动影响的用例；最终汇总必须说明实际执行范围。
6. 验收结束关闭本次新建 Browser tab、detach、`dev:stop` 并确认 dedicated 资源已清理。

## 8. 完成判定

只有同时满足以下条件才能标记计划完成：

- 基础命令全部通过。
- AGT-WH-001 至 AGT-WH-024 必跑项均有真实执行结果和证据。
- 同一 Terminal 两次进入 Codex 的实际场景通过。
- App Server/Activity 单源失败降级场景通过。
- Multi-Agent 多轮与历史 Round 缺失场景通过。
- 原 Activity 子页面回归通过。
- Dev Session 已停止并完成资源清理。
