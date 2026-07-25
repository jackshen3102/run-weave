# Agent Self-Evolution V1

Runweave Evolution 把本机 Activity、Work History、Agent Team 与仓库基线冻结成可审计证据，
由隔离的 Codex/Trae Analyst 形成 Claim、Insight revision 和 Candidate。它不是日报生成器：
只有通过证据、隔离、Novelty 和治理门禁的 Memory Candidate，才可能在 scope owner 显式授权后
以 advisory context 进入后续 Agent Team `code` worker。

产品入口是 `/evolution`，持久化状态位于用户级 Evolution SQLite。Web、CLI 和 Agent 都通过
Backend API 访问，不直接打开数据库。

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

用户只选择“全部工作区”或一个主项目。全局范围使用稳定的 `global:runweave` identity；
项目范围的 `learningScopeId` 由主项目稳定 ID 决定，主项目与其动态 worktree 共用知识，
不同主项目硬隔离。历史 workspace 即使路径已删除，仍按稳定 project ID 归属，不能用路径
相似度猜测身份。

Context Pack 保存：

- 每个 source 的 `afterWatermark`、冻结的 `snapshotBoundary` 和实际处理到的
  `processedThrough`；
- Evidence ID、digest、来源身份、关系索引、Activity 事件/结果/结构化 payload 和内容可用性；
- DataQualityIssue；
- profile、deadline 和 Knowledge Baseline digest。

Activity 查询以单调 `activityOffset` 冻结。一次手动或定时反思先读取该范围上次成功
watermark，再固定 `snapshotBoundary`，并自动分页读取到该边界；Context Pack 只有在全部分页
合并完成后才进入分析，因此成功事务的 `processedThrough = snapshotBoundary`。新事件不会进入
已建立的 Pack，而会由下一次增量反思处理。

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

- `packages/shared/src/evolution.ts`
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
