# Agent Self-Evolution V1

Runweave Evolution 把本机 Activity、Work History、Agent Team 与仓库基线冻结成可审计证据，
由隔离的 Codex/Trae Analyst 形成 Claim、Insight revision 和 Candidate。它不是日报生成器：
只有通过证据、隔离、Novelty 和治理门禁的 Memory Candidate，才可能在 scope owner 显式授权后
以 advisory context 进入后续 Agent Team `code` worker。

产品入口是 `/evolution`，持久化状态位于用户级 Evolution SQLite。Web、CLI 和 Agent 都通过
Backend API 访问，不直接打开数据库。

## 人类成果收件箱

`/evolution` 默认进入「成果」，原运行、候选、策略和计划在「分析管理」中保留。
手机首页在关注区下、项目列表前展示最新四条待处理成果，没有关注终端也保留入口。
两端通过带正常访问令牌的 `/api/knowledge-inbox` 消费已登记仓库的 Evolution 与 Experience，
不接受客户端路径、namespace 或自报用户。共享 DTO 见
[`knowledge-inbox.ts`](../../packages/shared/src/knowledge-inbox.ts)，发布与消费边界见
[`knowledge-inbox/`](../../backend/src/knowledge-inbox/)。

iOS 完整列表提供「自进化 / 经验 / 全部」来源筛选，首次默认自进化（洞察与建议），
与项目、处理状态组合使用。列表 API 的可选 `source` 在分页前过滤；省略仍返回两种来源，
分页游标绑定来源、项目与处理状态，切换筛选须从第一页读取。此筛选需 Backend 同时支持
`source` 参数；首页四条预览保持全部来源。

只有归属明确、已提交且仍有可用支持的 Insight 和当前有效的已保存 Experience 可发布。
关联 Candidate 作为建议补充，不额外产生卡片；待验证建议带明确标签。无效、争议、归属未决
与内部候选不进入默认列表。详情只包含脱敏正文，不暴露证据、日志、绝对路径或运行 artifact；
客户端按纯文本渲染，不执行 HTML、不加载远程图片。

处理状态独立存于 `~/.runweave/knowledge-inbox/<Experience namespace>/store.sqlite`，
按经认证的 username、条目、正文版本隔离。打开详情不自动处理；处理/恢复只写消费库，
不改知识生命周期、Canary、检索或采用回执。同名账号仅在同一 Backend 存储范围内共享。
状态写入携带正文版本与状态版本；旧正文或并发旧状态返回 409，已完成请求可幂等重放。
已处理历史保留当时的脱敏正文；失效后保留历史但禁止恢复，旧版本恢复不覆盖当前新正文。

正文版本是结论、适用条件、建议、步骤、避坑和验证说明经 NFKC/空白规范化后的确定性哈希。
标题、维护时间和证据引用不触发重新待处理；这不等于识别语义等价改写。首次导入保留源正文
时间，已有版本不因刷新重新排序。多个 Backend 以投影代数 CAS 拒绝迟到旧读取；来源读取前后
核对一致性，源故障不撤回缓存投影。单源失败标记 partial，双源失败返回 503。

客户端可见时每 15 秒刷新，回到前台或操作后立即刷新；不是即时推送。离线内容只作缓存展示，
禁用写入，不排队操作。旧 Backend 的 404 显示版本不支持。验收合同见
[统一成果收件箱](../testing/evolution/results-inbox.testplan.yaml)。

成果详情支持「复制给 Agent」：持久化独立于处理状态的正文及来源材料快照，
通过正常鉴权的 `rw knowledge read` 读取，并另行返回当前版本/可用性。
Activity 原文仍按实时保留期读取和摘要校验，不因分享永久保存。
命令、身份隔离与证据边界见 [成果引用](../cli/knowledge-cli.md)。

## 运行闭环

```text
manual / schedule
  -> queued EvolutionRun
  -> frozen ContextPack
  -> TraceSegment + Episode
  -> isolated Analyst A / B
  -> cross examination
  -> Claim ledger
  -> Novelty Gate
  -> append-only InsightRevision + ContributionEdge
  -> Candidate (draft/shadow)
  -> explicit scope policy + per-Memory authorization
  -> control/canary assignment
  -> Agent Team code worker advisory injection
  -> RuntimeTrace + objective outcome
  -> revalidation / retirement / rollback
```

`quick`、`standard`、`deep` 只改变预算、Agent 数量和可选 Judge/Replays，不改变安全边界。
V1 的长期知识提交只发生在同一个 fenced 事务的
`validating -> completed | no_material_novelty` 转换中。`partial`、`failed`、`cancelled`
只保留审计 artifact，不提交 Insight、Candidate 或 watermark。

## 学习范围与冻结边界

Evolution 与 Experience 共用 `SHA256(realpath(git-common-dir))` 作为仓库身份。
同仓库的主工作区、linked worktree、子目录和重复 Project 登记共享知识；独立 clone 与
submodule 分开。Project 只承担入口和来源，非 Git 目录不回退到 Project 或全局范围。
公共解析器见 `backend/src/repository/identity.ts`。仓库移动导致身份改变，迁移不猜测重绑定。

页面的“全部仓库”创建持久 reflection batch：冻结当时可用仓库集合与取材上界，每仓库
一个 Run，沿用全机 lease 顺序运行。幂等键防止重复创建，最多 100 个仓库，页面显示总预算。
`global:runweave` 仅保留历史审计，新客户端不能创建旧全局 Run。

仓库登记、历史归属和 topic lineage 位于 Evolution 附加表；旧冻结 artifact 不改写。
归属不完整或跨仓库的历史保留可读，不能作为新仓库的可注入知识。同 topic 的旧 Insight
保留原 revision 与支持/反证，冲突标记 contested，Candidate 等待重新验证。

Context Pack 保存：

- 每个 source 的 `afterWatermark`、冻结的 `snapshotBoundary` 和实际处理到的
  `processedThrough`；
- Evidence ID、digest、来源身份、关系索引、Activity 事件/结果/结构化 payload 和内容可用性；
- DataQualityIssue；
- profile、deadline 和 Knowledge Baseline digest。

Activity 以事件仓库归属索引的单调 `binding_offset` 冻结，原始事实保留 `activityOffset`。
新事件使用可信 cwd；旧事件须有可核验的会话或已有仓库绑定，不按 Project 前缀归属。
工具回调优先使用经过会话归属校验的面板 cwd，Worker 分发使用对应角色的 cwd。
完整 Agent Team Run 的仓库入口不明确或跨仓库时，不把它作为单仓库补充证据。
晚到的归属补录取得新 cursor，因此不会漏在旧 watermark 之前；冻结中途补录不改变当前 Pack。
未归属统计进入 DataQuality，不能声称覆盖全部历史。一次手动或定时反思先读取该范围上次成功
watermark，再固定 `snapshotBoundary`，并自动分页读取到该边界；Context Pack 只有在全部分页
合并完成后才进入分析，因此成功事务的 `processedThrough = snapshotBoundary`。新事件不会进入
已建立的 Pack，而会由下一次增量反思处理。

证据删除会检查当前 Insight 以及最新 Candidate 引用的历史 revision；已归档的失效修订按
稳定 ID 复用原文和时间戳，重复维护不会重写不可变记录，也不会让旧 revision 抢占当前 head。

## 分析隔离与 Provider

每个 Provider attempt 使用独立 `0700` 临时目录、`0600` schema/config 和随机 run-scoped
MCP bearer token。Prompt 通过 stdin 传递。允许工具限定为冻结证据的只读查询：

- `context.describe`
- `activity.summarize_facts`
- `activity.search_facts`
- `activity.get_content`
- `evidence.batch_get_metadata`
- `history.get_thread`
- `history.get_agent_team_run`
- `source.search`
- `source.read`

`context.describe` 只返回按 code 聚合的 DataQuality 摘要，不能把逐条问题放大成无界
Provider 输出。`activity.summarize_facts` 确定性扫描冻结范围内的每条 Activity Fact，返回
有界的事件、结果、失败码、工作区和代表性 Evidence ID 聚合；Analyst 必须先确认
`coverage.fullyCovered`，再按代表性 Evidence ID 深挖，禁止用有限工具调用逐页遍历十万级
原始事实。

首轮 Analyst 看同一 Context Pack，但看不到对方 report。首轮 artifact 持久化后，
cross examiner 才能同时读取两份 report。每个 attempt 记录实际 Provider、
`selectionReason`、状态、report 链接和脱敏错误码。

`auto` 在 Codex 与 Trae 都可用时使用跨 Provider 首轮；只有一方可用时记录
`fallback_single_provider`。显式 Provider 不可用不会静默换模型；`mixed` 缺少一方时产生明确
blocked/partial 语义。

Backend 恢复时，未知外部调用标记为 `abandoned`。严格匹配
`<run UUID>-<analyst role>-<mkdtemp suffix>` 且没有活动 attempt 的私有目录才会被清理；
其他目录不在清理范围。

## Claim、Insight 与删除传播

Observed Fact、Assessment 和 Claim 分开持久化。Claim 可以是 `corroborated`、
`contested`、`insufficient_evidence` 或 `rejected`；分歧不会用多数票抹平。
Novelty 分为 `known`、`reinforced`、`novel`、`contradiction` 和 `drift`。全部为已知时，
Run 合法返回 `no_material_novelty`，不生成占位报告。

Insight、InsightRevision、ContributionEdge 和 RuntimeTraceEvent 是 append-only：

- 同 topic 的新证据生成新 revision，不覆盖旧 statement；
- ContributionEdge 记录支持/反例 Evidence ID 与当前 availability；
- Activity scoped delete 或原始内容到期后，reconciler 只做单向降级；
- 支持证据减少会降低 confidence，并使 Candidate 进入 `needs_revalidation`；
- 唯一支持证据消失时 Candidate 自动 `retired`，停止新的注入。

`learning.sqlite` 不保存 Activity 正文、用户 prompt、代码片段、完整工具输出或 Provider
stdout。它只保存去敏 statement、结构化 outcome、Evidence ID/hash、revision 与不可逆统计。

## Candidate 与真实注入

Candidate 类型为 Memory、Prompt、Skill、Routing、Product 和 Code。V1 只有 Memory
存在自动运行时入口；其他类型始终是结构化提案，不安装、不改仓库、不改产品。

Memory 的激活需要两层显式授权：

1. scope owner 把 `memoryCanaryEnabled` 打开并把 `canaryRate` 从 0 调高；
2. scope owner 对一条 `low` risk、`shadow` Memory 执行“授权进入 Canary”。

检索在 Selector 前硬过滤 scope、worker role、lifecycle、有效期、依赖和排除条件。
最终最多注入 3 条、6000 bytes，并以独立的
`<evolution-context status="canary" advisory="true">` 块追加到原 startup prompt。
原任务、系统 prompt、AGENTS.md 和验收合同保持原样。服务失败时 fail-open，不阻塞 worker。

control/canary 由 scope、run、asset 和 policy revision 确定性分配。每次 eligible task 都写
RuntimeTrace，记录召回、过滤、选择、分桶、实际暴露 revision 和后续客观结果。关闭 policy
会立即停止新注入；“退休 / 回滚”生成新的 Candidate revision，历史 trace 继续保留。

分桶使用稳定 `assetId`，更新 revision 或新增候选不能改变同一 run/asset 的实验身份。
客观结果与 Agent feedback 按 dispatch 精确归因；feedback 缺失或引用未暴露 revision 时记录
`missing`，不静默丢失观察。feedback 始终是 `advisoryOnly`，不能直接作为 promotion 依据。

## 运行时与故障边界

- 全机 lease key 固定为 `global-evolution-runner-v1`，所有 Backend 合计最多一个活动 Run。
- heartbeat 小于 lease TTL 的三分之一；接管会递增 fencing token。
- manual 排在 event、schedule 之前；已运行任务不被抢占。
- 同一 Schedule 错过多个窗口只 materialize 一个最新 catch-up Run。
- Evolution 初始化失败时 Backend 其他能力继续运行，Evolution API 返回 degraded/unavailable。
- Provider、MCP、注入或 outcome observer 失败都不得修改用户 workspace 或阻塞原 Agent Team
  主流程。

## API 与代码入口

用户 API 位于 `/api/evolution`：

- Run：`POST/GET /runs`、`GET /runs/:id`、`POST /runs/:id/cancel|retry`
- artifact：`GET /runs/:id/artifacts`
- Provider：`GET /providers`
- Schedule：`GET/POST /schedules`、`PATCH/DELETE /schedules/:id`
- Insight：`GET /insights`、`GET /insights/:id`
- Candidate：`GET /candidates`、`GET /candidates/:id`、
  `POST /candidates/:id/canary|retire`
- Policy：`GET/PUT /scopes/:learningScopeId/policy`
- RuntimeTrace：`GET /runtime-traces`，可按 `runId` 精确查询，或按
  `learningScopeId`/`limit` 查看近期真实激活轨迹；`/evolution` 使用 scope 查询，不把分析
  Run ID 与 Agent Team Run ID 混用

主要实现位于：

- `packages/shared/src/evolution/index.ts`
- `backend/src/evolution/`
- `backend/src/routes/evolution-*.ts`
- `frontend/src/pages/evolution-page.tsx`
- `packages/runweave-cli/src/commands/evolution.ts`

## 验证入口

```bash
pnpm testplan:validate docs/testing/evolution/agent-self-evolution-core.testplan.yaml
pnpm testplan:validate docs/testing/evolution/agent-self-evolution-activation.testplan.yaml
pnpm evolution:verify-foundation
pnpm evolution:verify-analysis
pnpm evolution:verify-activation
pnpm evolution:verify-provider-smoke
pnpm typecheck
pnpm lint
pnpm build
```

真实页面验收必须在受控 Dev Session 的 Electron/Web surface 中附着 Playwright，不能以静态
构建或 fake Provider 代替。真实 canary 只证明链路可用；单次样本不触发自动 promotion。

## 仓库身份迁移

Backend 在启动 Activity/Evolution worker 前自动审计、备份并迁移旧 learning.sqlite，
成功后才开放服务；已完成的库直接跳过，中断后恢复原清单。自动入口、显式工具、停写与回滚合同见
[仓库身份迁移](../deployment/evolution-repository-migration.md)。新 schemaVersion 为 6，
minimumWriterVersion 为 2；完成标记缺失或迁移中时新 writer 拒绝打开。
Experience 的 hash、namespace 与存储不迁移。

迁移仅追加归属和必要的 Candidate revision：旧 canary/promoted 最多进入 shadow，
新仓库 Policy 默认关闭 Canary。新仓库 watermark 从 0 开始，旧知识参与 Novelty 基线；
有冲突的 lineage 不按更新时间选真相。删除传播检查所有成员和仍被 Candidate 引用的 revision。
