# Terminal Activity Work History 落地计划

> 日期：2026-07-13
> 状态：待实施
> 原型基线：[`docs/prototypes/terminal-activity-archives/`](../prototypes/terminal-activity-archives/)
> 配套用例：[`docs/testing/terminal-activity-work-history-test-cases.md`](../testing/terminal-activity-work-history-test-cases.md)

## 1. 结论

本次不把 `/activity` 继续做成“原始事件列表”，而是在保留现有 Events、Timeline、Sources、Data Policy 能力的前提下，新增两个彼此独立的工作历史入口：

1. **Terminal History**：以 `terminalSessionId` 为档案主键。一个终端从创建到删除只有一条档案；在同一终端内退出 Codex TUI、再次进入并新建 Thread，只会在档案内增加新的 Thread 片段，不会拆成两个终端记录。
2. **Multi-Agent Runs**：以 `runId` 为档案主键，使用 `Setup → Round N → Acceptance` 的 Round Journal。它与普通终端分开展示，不把 Worker、Round、Acceptance 强行塞进普通终端时间线。

页面采用原型已确认的三栏结构：全局导航、对象列表、按时间展开的日志；事件详情在宽屏内嵌，窄屏使用抽屉。数据由现有 Terminal Session、Activity Facts、App Server ThreadRef/Codex Thread、Agent Team Run 在读取时聚合，不新增一套重复的历史数据库。

第一阶段只展示能够由当前系统或本次明确扩展的接口稳定获得的事实，不生成“工作总结”“效率评分”“模型复盘”等推断内容。

## 2. 已冻结的产品语义

### 2.1 Terminal 档案边界

- 档案主键：`terminalSessionId`。
- Terminal Session 创建时开始，显式删除时结束；命令退出、Codex TUI 退出、Shell 回到提示符都不创建新档案。
- 同一 Terminal 下可以关联 0 到多个 ThreadRef。
- Thread 的开始、进行中、完成或中断是 Terminal 档案内的事件/片段，不是 Terminal 档案本身。
- 不按时间接近度猜测 Thread 与 Terminal 的关系，只接受 ThreadRef 中明确记录的 `terminalSessionId`。
- Scrollback 仅表示当前还能否读取终端历史输出，不承担 Thread 消息正文的来源职责。

### 2.2 Multi-Agent 档案边界

- 档案主键：`runId`。
- Run 可以关联 Terminal，但独立出现在 Multi-Agent Runs 导航中。
- Run 详情固定按 `Setup → Round N → Acceptance` 组织。
- `run.loop.round` 表示“下一轮索引”，不能直接显示为“已完成轮数”。已完成轮数从带 Round 来源的事件和日志中确定。
- 新产生的 Worker/Case Activity 事件使用 payload 中的 `round`。
- 历史事件缺少 Round 时允许显示“未归属”，禁止仅凭时间接近度强行归轮。

### 2.3 详情面板

- 每种事件可以有不同详情结构，Inspector 根据事件类型选择内容。
- 带 `threadId` 的事件允许按需加载该 Thread 的 Turn 与用户/助手消息。
- 带 Activity Fact 的事件展示事实字段和 Content 可用状态。
- 带 Run、Worker、Case、Evidence 的事件展示相应真实字段。
- 宽度 `>= 1380px` 时右侧内嵌；更窄时使用抽屉，关闭后恢复中间日志宽度。

### 2.4 明确不做

- 不在 Activity 数据库复制保存完整 Codex 对话。
- 不从终端 Scrollback 解析或猜测 Thread 消息。
- 不把普通 Terminal 与 Multi-Agent Run 混成一种卡片。
- 不展示当前接口无法证明的 token 数、代码改动量、测试通过数、生产力评分、模型复盘结论。
- 不为非 Codex Provider 伪造 Thread 详情；Provider 不支持时明确显示不可用。
- 不删除现有 Activity 数据底座或 Agent Team 计划。当前仓库没有与本计划同范围的旧 Work History 落地计划，因此无需删除文件。

## 3. 当前代码事实

### 3.1 已有能力

| 能力                                               | 当前事实来源                                         | 当前入口                                                                        |
| -------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| Terminal 身份、状态、时间、命令、目录、最后 Thread | `TerminalSessionManager` / `TerminalSessionListItem` | `GET /api/terminal/session`、`GET /api/terminal/session/:id`                    |
| Terminal Scrollback                                | Terminal Session 持久化历史                          | `GET /api/terminal/session/:id/history`                                         |
| Activity Facts                                     | `ActivityQueryService`                               | `GET /api/activity/facts`，支持 `terminalSessionId`、`threadId`、`runId` 等过滤 |
| Activity Content                                   | 短生命周期 Content Store                             | `GET /api/activity/content/:contentId`                                          |
| Thread 关联                                        | App Server `ThreadRef`                               | `GET /api/app-server/threads`、`GET /api/app-server/threads/:threadId`          |
| Codex Thread 状态                                  | Codex App Server `thread/read`                       | 当前仅由状态补偿器以 `includeTurns: false` 调用                                 |
| Agent Team Run                                     | Run Store / `AgentTeamService`                       | `GET /api/agent-team/runs?projectId=...`、`GET /api/agent-team/runs/:runId`     |
| Worker/Case Round                                  | Agent Team Activity payload                          | 本工作区已经为新事件补充可选 `round` 字段；旧事件可能缺失                       |

### 3.2 当前缺口

1. `/activity` 只按 interaction/thread 分组 Question/Response，未形成 Terminal 档案。
2. 前端需要分别请求 Terminal、Activity、ThreadRef、Run，缺少稳定的 Work History 读取合约。
3. App Server HTTP API 只提供 ThreadRef，不提供按需 Turn/消息详情。
4. Agent Team `/runs` 以 `projectId` 查询，页面缺少跨项目 Run 列表读取模型。
5. 当前详情是单个 Activity Fact 的内嵌展示，不能承载不同类型的详情。
6. 列表统计若直接逐 Thread 调用 `thread/read` 会形成 N+1，且在 Codex App Server 不可用时拖垮整个页面。

## 4. 目标架构

```text
/activity
  ├─ Terminal History ──┐
  ├─ Multi-Agent Runs ──┼─ frontend Work History views
  ├─ Events             │
  ├─ Timeline           │
  ├─ Sources            │
  └─ Data Policy        │
                        ▼
              /api/work-history (Backend read model)
                 ├─ TerminalSessionManager
                 ├─ ActivityQueryService
                 ├─ App Server ThreadRef/detail gateway
                 └─ AgentTeamService / Run Store
                                      │
                                      ▼
                    Codex App Server thread/read(includeTurns=true)
```

Work History 是**只读聚合层**，不成为新的事实源：

- Terminal/Run 身份仍由各自 Store 决定。
- Activity 事件仍由 Activity Facts 决定。
- Thread 内容仍由 Codex App Server 按需决定。
- 聚合层只做鉴权、分页、可用性描述和确定性归一化。

## 5. 数据合约

### 5.1 新增共享包入口

新增 `packages/shared/src/work-history.ts`，并在 `packages/shared/package.json` 增加子路径 `@runweave/shared/work-history`。不放入 `packages/common`，因为该合约同时由 Backend 和 Web 使用，不是 Web/App 共享组件。

核心类型：

```ts
type WorkHistorySourceStatus =
  | { status: "available" }
  | { status: "partial"; reason: string }
  | { status: "unavailable"; reason: string };

interface TerminalArchiveSummary {
  terminalSessionId: string;
  projectId: string;
  title: string;
  cwd?: string;
  command?: string;
  status: TerminalSessionStatus;
  createdAt: string;
  lastActivityAt: string;
  lastThread?: TerminalThreadMetadata;
  knownThreadCount: number;
}

interface TerminalArchiveDetail {
  terminal: TerminalSessionListItem;
  threadRefs: AppServerThreadRef[];
  threadDetails: AppServerThreadDetailResponse[];
  facts: ActivityFactsPage;
  asOfActivityOffset: number;
  sourceStatus: {
    terminal: WorkHistorySourceStatus;
    activity: WorkHistorySourceStatus;
    appServer: WorkHistorySourceStatus;
    scrollback: WorkHistorySourceStatus;
  };
}

interface AgentTeamArchiveSummary {
  runId: string;
  projectId: string;
  terminalSessionId: string;
  status: AgentTeamRunStatus;
  mode: AgentTeamMode;
  createdAt: string;
  updatedAt: string;
  workerCount: number;
  nextRoundIndex: number;
}

interface AgentTeamArchiveDetail {
  run: AgentTeamRun;
  facts: ActivityFactsPage;
  asOfActivityOffset: number;
  sourceStatus: {
    run: WorkHistorySourceStatus;
    activity: WorkHistorySourceStatus;
  };
}
```

说明：

- 列表中的 `knownThreadCount` 只由 ThreadRef 计算，不为了统计 Turn 数读取每个 Thread。
- 精确 Turn 数只在用户选中 Terminal 后，从已加载的 Thread 详情计算。
- `asOfActivityOffset` 在第一次详情读取时固定，后续 Activity Facts 翻页沿用该值，避免新事件插入导致重复/跳项。
- 列表排序使用稳定复合键：Terminal 为 `lastActivityAt desc + terminalSessionId`；Run 为 `updatedAt desc + runId`。
- `search` 最大 256 字符，`limit` 范围 1–100，游标为不透明字符串。

### 5.2 Codex Thread 详情合约

扩展 `packages/shared/src/app-server-events.ts`：

```ts
type AppServerThreadDetailAvailability =
  | "available"
  | "provider_unsupported"
  | "thread_not_found"
  | "provider_unavailable";

interface AppServerThreadDetailResponse {
  thread: AppServerThreadRef;
  availability: AppServerThreadDetailAvailability;
  detail?: {
    provider: "codex";
    threadId: string;
    preview: string;
    status: AppServerThreadStatus;
    createdAt: string;
    updatedAt: string;
    turns: Array<{
      id: string;
      status: "completed" | "interrupted" | "failed" | "inProgress";
      startedAt?: string;
      completedAt?: string;
      durationMs?: number;
      itemsView: "notLoaded" | "summary" | "full";
      itemCount: number;
      messages: Array<{
        id: string;
        role: "user" | "assistant";
        text: string;
      }>;
    }>;
  };
}
```

归一化规则：

- Codex 调用 `thread/read({ threadId, includeTurns: true })`。
- 默认只暴露 `userMessage` 的文本输入与 `agentMessage.text`，不在首版暴露 reasoning、命令输出、文件 Diff 或工具内部参数。
- 图片、Skill、Mention 等非文本输入计入 `itemCount`，首版不伪装成文本消息。
- 非 Codex ThreadRef 返回 `provider_unsupported`。
- Codex 进程不可用返回 `provider_unavailable`，Terminal 档案其余部分仍可用。
- 不将返回的 Turn/消息写回 Activity 数据库或 ThreadRef Store。

### 5.3 Round 归属规则

前端/Backend 共享以下来源优先级，展示时保留来源：

```ts
type AgentTeamRoundAttributionSource =
  | "activity_payload"
  | "dispatch_snapshot"
  | "run_log_single_round"
  | "unavailable";
```

1. Activity payload 明确带 `round`：`activity_payload`。
2. Run 的 Worker dispatch snapshot 明确带 `round`：`dispatch_snapshot`。
3. 历史事件两者都缺失，且该 Run 日志中只出现一个无矛盾的 Round：允许标记 `run_log_single_round`。
4. 其他情况为 `unavailable`，放入“未归属事件”。

禁止以时间戳临近、数组位置或 `run.loop.round - 1` 推断某一事件的 Round。

## 6. Backend 与 App Server 实施

### 6.1 App Server 按需读取 Thread 详情

涉及文件：

- `app-server/src/codex-app-server-client.ts`
- `app-server/src/http-server.ts`
- `app-server/src/index.ts`
- `packages/shared/src/app-server-events.ts`

任务：

- [ ] 在现有 Codex Client 增加 `readThreadDetail(threadId)`，使用当前 Codex App Server v2 `thread/read` + `includeTurns: true`。
- [ ] 将 Codex 返回值在 App Server 内归一化为 Provider-neutral DTO。
- [ ] `createHttpApp` 接收 Thread Detail Reader，新增认证接口 `GET /threads/:threadId/detail`。
- [ ] `app-server/src/index.ts` 只创建一个 Codex Client，由状态补偿器与 HTTP 详情读取共享，退出时只关闭一次。
- [ ] 明确处理 Thread 不存在、Provider 不支持、Codex 不可用；不可用不导致 App Server 退出。

验证：使用真实 Codex Thread 调用 detail 接口，确认包含 Turn/用户/助手消息；停止 Codex Provider 后接口返回明确 availability，`/health` 仍正常。

### 6.2 Backend 代理 Thread 详情

涉及文件：

- `backend/src/routes/app-server-state.ts`
- `backend/src/app-server/client.ts`
- 必要时新增 `backend/src/work-history/app-server-history-gateway.ts`

任务：

- [ ] 新增登录态保护的 `GET /api/app-server/threads/:threadId/detail`。
- [ ] 复用 App Server discovery/auth，不硬编码本地端口。
- [ ] 保留结构化 availability；网络错误转换为可展示的 Provider unavailable，而不是 500 空白页。
- [ ] 设置有界超时，避免一个失联 Provider 阻塞 Terminal 档案。

验证：未登录返回 401；登录后与 App Server 原始 detail 结果一致；App Server 下线时 Backend 仍返回可判定状态。

### 6.3 Work History 只读聚合服务

新增文件：

- `backend/src/work-history/work-history-service.ts`
- `backend/src/routes/work-history.ts`
- `packages/shared/src/work-history.ts`

修改文件：

- `backend/src/bootstrap/runtime-services.ts`
- `backend/src/index.ts`
- `packages/shared/package.json`

接口：

- [ ] `GET /api/work-history/terminals?search=&cursor=&limit=`
- [ ] `GET /api/work-history/terminals/:terminalSessionId`
- [ ] `GET /api/work-history/runs?search=&cursor=&limit=`
- [ ] `GET /api/work-history/runs/:runId`

聚合规则：

- [ ] Terminal 列表以 TerminalSessionManager 为全集，只用 ThreadRef 补充已知 Thread 数。
- [ ] Terminal 详情按明确 `terminalSessionId` 查询 ThreadRef 与 Activity Facts。
- [ ] Thread 详情只为被选中的 Terminal 加载，默认最多 50 个，最大并发 4；超出时返回 partial 状态并允许后续加载。
- [ ] Activity Facts 首屏最多 200 条，并返回 `nextCursor` 和固定 `asOfActivityOffset`；UI 必须显示并支持继续加载，禁止静默截断。
- [ ] Run 列表遍历当前 TerminalSessionManager 可见项目，再通过 `AgentTeamService.listRuns(projectId)` 汇总，不增加第二份 Run 索引。
- [ ] Run 详情直接复用 `AgentTeamRun`、Acceptance Evidence 与 Activity Facts，不伪造测试结果。
- [ ] 所有接口使用现有登录鉴权、请求日志与错误处理约定。

验证：同一 Terminal 关联两个 Thread 时列表只有一个 Terminal；Run 列表不依赖当前选中的 Project；同名/同时间对象仍由 ID 区分。

## 7. Frontend 实施

### 7.1 Activity 页面信息架构

涉及文件：

- `frontend/src/pages/activity-page.tsx`
- `frontend/src/services/work-history.ts`
- 可选的 Activity 局部组件文件

导航调整为：

```text
Work history
  Terminal history   (默认)
  Multi-Agent runs

Raw data
  Events
  Timeline
  Sources

Data
  Data Policy
```

任务：

- [ ] 将 `activity-page.tsx` 收敛为页面壳层和导航状态，避免继续堆叠业务渲染。
- [ ] 保留现有 Events、Timeline、Sources、Data Policy 行为与入口。
- [ ] 新增 `frontend/src/services/work-history.ts`，只依赖共享 DTO。
- [ ] 默认打开 Terminal History，路由仍为 `/activity`；通过 query 参数保存子导航和选中 ID，刷新后可恢复。
- [ ] 所有事件处理函数优先使用 `ahooks` 的 `useMemoizedFn`。

建议 query：`?view=terminals&terminal=<id>&event=<id>`、`?view=runs&run=<id>&event=<id>`。参数只承载 UI 选择，不成为对象关系来源。

### 7.2 Terminal History

新增建议文件：

- `frontend/src/pages/activity/terminal-history-view.tsx`
- `frontend/src/pages/activity/terminal-history-list.tsx`
- `frontend/src/pages/activity/terminal-journal.tsx`
- `frontend/src/pages/activity/terminal-history-model.ts`

任务：

- [ ] 左栏按 `terminalSessionId` 列表展示终端、状态、项目、最后活动时间和已知 Thread 数。
- [ ] 中栏将 Terminal 生命周期、Activity Facts、Thread Turn 确定性合成为按时间排序的异构 Journal。
- [ ] 同一 Terminal 的多个 Thread 显示为多个 Thread 分段，明确 started/completed/interrupted。
- [ ] 每条 Journal entry 保留 `sourceType`、`sourceId`、`occurredAt` 和可用详情能力。
- [ ] Activity 与 App Server 某一来源不可用时保留其他来源内容，并在顶部显示 source status。
- [ ] 支持 Facts 加载更多；新事实不打乱已冻结的当前翻页，用户刷新时再创建新快照。

Journal 排序：`occurredAt asc`，相同时间按稳定类型优先级和 `sourceId` 排序。排序只用于呈现，不用于创建对象关联。

### 7.3 Multi-Agent Round Journal

新增建议文件：

- `frontend/src/pages/activity/multi-agent-history-view.tsx`
- `frontend/src/pages/activity/multi-agent-history-list.tsx`
- `frontend/src/pages/activity/multi-agent-round-journal.tsx`
- `frontend/src/pages/activity/agent-team-history-model.ts`

任务：

- [ ] 左栏以 `runId` 为核心显示 Run、状态、模式、Worker 数、更新时间。
- [ ] 中栏分为 Setup、各 Round、Acceptance 和可选“未归属事件”。
- [ ] Round 内展示 dispatch、pane/worker、结果、重试、case/evidence 等现有事实。
- [ ] 明确区分 `nextRoundIndex` 与已呈现 Round 数。
- [ ] 历史事件的归属来源可在 Inspector 查看；无法归属就保留为 unavailable。
- [ ] Acceptance 只展示真实 `AgentTeamAcceptanceEvidence`，无 Evidence 时显示“未记录”。

### 7.4 通用 Inspector 与响应式布局

新增建议文件：

- `frontend/src/pages/activity/work-history-inspector.tsx`
- `frontend/src/pages/activity/work-history-layout.tsx`

任务：

- [ ] 使用 discriminated union 渲染 Thread、Activity Fact、Terminal、Run、Worker、Case、Evidence 等详情，不做巨型可选字段对象。
- [ ] Thread Inspector 展示 Turn、用户/助手消息与 Provider availability。
- [ ] Activity Fact Inspector 复用 Content 加载与过期语义。
- [ ] 宽屏内嵌、窄屏抽屉；支持关闭、Escape、焦点恢复与键盘访问。
- [ ] loading、empty、error、partial、not recorded 均有明确状态，不用占位假数据填空。
- [ ] 列表切换时取消或忽略旧请求，避免晚到响应覆盖新选择。

## 8. 确定性模型与验证脚本

新增：

- `scripts/verify-work-history-read-model.ts`
- `package.json` 脚本 `work-history:verify`

这是一次性可执行的合约/行为验证脚本，不新增单元测试文件。脚本使用隔离临时目录构造最小真实数据并调用实际服务：

- [ ] 一个 Terminal + 两个 Codex ThreadRef，验证只生成一条 Terminal 档案。
- [ ] 两个 Thread 的 Turn/消息按明确 ThreadRef 关联，不按时间猜测。
- [ ] Activity Facts 翻页固定 `asOfActivityOffset`。
- [ ] App Server 不可用时返回 partial/unavailable，Terminal 数据仍存在。
- [ ] Run 的 `loop.round` 作为 nextRoundIndex，Round 归属遵循来源优先级。
- [ ] 历史缺少 Round 且存在多轮时进入未归属事件。

## 9. 实施顺序与提交边界

### 阶段 A：共享合约与 App Server 详情

1. 落 `AppServerThreadDetailResponse` 与 Work History DTO。
2. 实现 Codex `thread/read(includeTurns=true)` 的按需读取和归一化。
3. 暴露 App Server/Backend detail 路由。

完成标准：真实 Thread 可读，Provider 不可用可降级；尚不修改 `/activity` UI。

### 阶段 B：Backend Work History read model

1. 实现 Terminal/Run 列表与详情聚合。
2. 完成鉴权、分页、快照 offset、并发上限与 source status。
3. 落 `work-history:verify`。

完成标准：通过 API 可以回答“这个 Terminal 发生了什么”和“这个 Run 各轮发生了什么”，且不依赖前端猜关联。

### 阶段 C：Terminal History UI

1. 重构 Activity 页面导航但保留旧入口。
2. 实现 Terminal 列表、Journal、Inspector、响应式抽屉。
3. 覆盖两次进入 Codex/两个 Thread 的核心场景。

完成标准：普通 Terminal 路线按原型可用。

### 阶段 D：Multi-Agent Round Journal UI

1. 实现独立 Run 列表。
2. 实现 Setup/Round/Acceptance 分节和未归属事件。
3. 接入真实 Evidence 与 Round provenance。

完成标准：复杂 Run 能解释每轮派发、结果、重试与验收；简单 Run 不显示空的伪阶段内容。

### 阶段 E：回归与真实环境验收

1. 执行静态检查与验证脚本。
2. 依据变更影响用 Dev Session planner 选择环境。
3. 在真实 `/activity` 上使用 Playwright 验收，不以静态原型截图代替。

## 10. 验证门禁

实现完成后的最小命令：

```bash
pnpm work-history:verify
pnpm activity:verify
pnpm typecheck
pnpm lint
pnpm build
git diff --check
```

运行行为/UI 变更必须执行 `$toolkit:runweave-change-validation`：

1. 固定本次 patch 边界；若工作区仍有无关改动，在独立 worktree 只应用本次 patch。
2. 首次在该 source root 执行无显式 profile 的 `pnpm dev:session --dry-run --json`。
3. 检查 planner 影响闭包，不显式向下降级。
4. 启动 Dev Session，用 `dev:status`、`dev:open` 解析目标。
5. 从 `pnpm dev:open --session <id> --surface desktop --json` 取得 CDP endpoint。
6. 使用 `$toolkit:playwright-cli` 的 `attach --cdp=<endpoint>` 验收 `/activity`。
7. 关闭本次新建 tab、detach、`dev:stop`，确认 dedicated 资源清理。

必验场景见配套文档，核心成功标准：

- 同一 Terminal 两次进入 Codex：1 条 Terminal 档案、2 个 Thread 分段。
- Multi-Agent Run 与普通 Terminal 分开；Round/Acceptance 基于真实字段。
- App Server 或 Activity 单一来源失效时页面降级而非整体空白。
- 宽屏 Inspector 内嵌，窄屏为可关闭抽屉。
- Events、Timeline、Sources、Data Policy 无回归。
- 页面不出现当前事实源无法证明的指标或总结。

## 11. 性能、安全与兼容性约束

- Terminal/Run 列表不得触发每条记录一次 Codex `thread/read`。
- 选中详情后 Thread detail 最大并发 4，默认最多加载 50 条 ThreadRef。
- 搜索、分页与 detail 请求必须可中止或忽略过期响应。
- 所有 Work History/App Server detail 接口沿用登录鉴权；Thread 正文不得出现在未鉴权列表接口、日志或错误文本中。
- Activity Content 的过期/删除语义保持不变，详情不可用时显示原因。
- 旧 Activity Fact 缺少 `round`、旧 ThreadRef 缺少 detail、非 Codex Provider 都必须兼容。
- 新共享类型以可选字段/新子路径增量引入，不改变现有 Activity/Agent Team API 响应。

## 12. 回滚策略

- Frontend 新视图作为 `/activity` 内部导航增量加入；出现问题时可将默认视图切回 Events，不影响 Activity Facts 写入。
- `/api/work-history` 是只读新路由，可独立撤回，不迁移或破坏数据。
- Codex detail 是 App Server 新增按需接口；状态补偿器仍保留原有 `includeTurns: false` 路径。
- Round payload 为可选字段，回滚 UI 不影响现有 Agent Team 执行。
- 不新增数据表，因此不需要数据库回滚或历史数据回填。

## 13. 最终交付物

- Work History 共享 DTO 与 App Server Thread Detail DTO。
- App Server/Backend Thread detail 接口。
- Backend `/api/work-history` 四个只读接口。
- `/activity` 的 Terminal History、Multi-Agent Runs、Inspector/Drawer。
- `work-history:verify` 验证脚本。
- 配套 Playwright/E2E 验收证据和 Dev Session manifest。
- 本计划与 [`terminal-activity-work-history-test-cases.md`](../testing/terminal-activity-work-history-test-cases.md) 的逐项完成记录。
