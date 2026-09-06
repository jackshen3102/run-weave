# Codex 中断状态收敛代码评审

## 结论

当前补丁方向正确，能够修复 `a8fcee31` 这类已有明确 `turn_aborted`、但缺失 `Stop` hook 的假 `agent_running`。没有发现 P0，也没有发现会直接把 `thread/read=active` 的明确活跃 turn 改成 idle 的路径。

当前范围按要求只修复 Codex 最终回答传播问题。候选窗口的 P1 和磁盘扫描的 P2 作为已知后续项保留。

## Findings

### P1 — 三小时窗口与固定 Top 100 使“最终收敛”没有保证

`AgentThreadStatusReconciler.collectCandidates()` 只扫描最近三小时内的 ThreadRef，并在按最近活动时间排序后截取前 100 条。一个已经错误停留在 `running` 的线程只要超过三小时，或持续被更活跃的 100 条线程挤出候选集，就再也不会被读取 rollout，因此仍可能永久显示 `agent_running`。

- 位置：`app-server/src/state/reconciler.ts:13-14,164-182`
- 影响：修复能覆盖当前新鲜现场，但没有满足“定时任务最终一定纠正”的目标；App Server 暂停超过三小时、升级后修复历史脏状态、或高并发用户都可能继续留下僵尸 running。
- 修复方向：将 projection 为 `running` 的线程作为独立高优先级队列，不受三小时窗口限制；若需要限流，使用持久或内存轮转游标分批扫描，而不是每轮固定取最近 100 条。其他 idle/starting 线程仍可保留现有窗口。

### 已修复 — Codex rollout 最终回答不再进入补偿事件

reader 不再读取 `task_complete.last_agent_message`，Codex rollout 补偿固定写入 `preview: null`。状态收敛只传递 lifecycle type、timestamp、cursor 和 turn ID。

- 位置：`app-server/src/codex/lifecycle-reader.ts:151-154,201-207`、`app-server/src/state/reconciler.ts:223-224,327-330`、`app-server/src/events/center.ts:43-59,130-138`
- 验证：fixture 在 `task_complete.last_agent_message` 中写入敏感占位文本，并断言生成的 `agent.lifecycle.observed.payload.preview === null`。

### P2 — 首次或持续未命中的 rollout 查找会递归遍历全部会话，running 候选还会每轮读取最多 1 MiB

首次查找会递归枚举 `~/.codex/sessions` 与 `archived_sessions` 的全部 JSONL。命中路径会缓存，但未命中的 thread 每轮都会重新全量扫描；每个 running Codex 候选随后还会读取最多 1 MiB 文件尾。当前机器约有 2,485 个 rollout、总计 6.1 GiB，单次已命中实测约 90 ms；理论上 100 个 running 候选可产生约 100 MiB/30 秒的读取量。

- 位置：`app-server/src/codex/lifecycle-reader.ts:67-92,96-112,169-189`、`app-server/src/state/reconciler.ts:134-164,167-182,210-228`
- 影响：平时 running 数量少时影响有限，但大量僵尸状态、找不到文件或慢盘环境会拖长 reconciliation round；round 执行为串行，后面的候选会被延迟。
- 修复方向：按 Codex 日期目录和文件名后缀建立一次索引，并对 miss 做有期限的负缓存；读取侧可从文件末尾反向找到最近的 lifecycle 行，避免固定读取并 JSON.parse 整个 1 MiB 尾部。

## 已确认的安全边界

- `thread/read=active` 优先于 rollout idle，因此当前独立 Codex app-server 明确观察到活跃 turn 时不会被降级。
- rollout 终态必须不早于当前 ThreadRef projection，旧 `task_complete` 不会覆盖新 `UserPromptSubmit`。
- `notLoaded`、`systemError`、读取失败、未知或缺失 lifecycle 均保持原状态。
- lifecycle observation 仍经过现有 thread、panel、tmux pane 和 provider 身份校验，再由 Backend 更新目标 panel 并聚合 session。

## 检查与证据

- 真实终端 `a8fcee31`：App Server projection 为 running，独立 `thread/read` 为 `notLoaded`，对应 rollout 尾部为 `turn_aborted`。
- 使用补丁后的 reader 与 reconciler 对该真实 thread 执行只读验证，生成 `observedStatus=idle`、`observedLifecycle=rollout:turn_aborted`、`compensation=true`。
- 已通过 App Server state-sync、event-center、Agent Team review-checkpoints、App Server typecheck/lint、architecture、docs 与 diff 检查。

## 建议

本次范围只处理已经修复的内容传播问题。后续应优先处理 P1；扫描优化可以结合实际指标跟进，但至少应给 miss 加负缓存并暴露扫描耗时/候选数，避免 runtime status 只显示“周期正常”却看不到自愈覆盖率。
