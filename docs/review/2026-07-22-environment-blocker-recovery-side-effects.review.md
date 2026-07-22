# Environment blocker recovery 副作用评审

## 结论

当前实现没有 P0，但有 2 个应在交付前补强的 P1 边界。核心恢复状态机本身成立：只有 `environment + retryable + scope=run + 同 fingerprint` 才跨 Case 失效旧观察，恢复队列一次只派一个 Case，真实产品失败仍优先 bounce。风险主要来自恢复状态的生命周期和 intervention API 门禁尚未完全闭合。

## 发现

- **P1：框架修复 rerun 会把旧 Run 的 `environmentRecovery` 调度标记复制到新 Run。** `resetAcceptance()` 通过展开旧 Case 重置状态，但没有清除新字段 `environmentRecovery`（同时也没有清除 `latestObservation`）；新 Run 的 `behaviorVerificationCasesForDispatch()` 会把该历史标记当成仍在进行的恢复 campaign，优先按旧 `resolvedByDispatchId` 单 Case 调度，造成新 Run 调度被前序 Run 的恢复历史影响，审计归属也错误。定位：`backend/src/agent-team/service-framework-repair.ts:313`、`backend/src/agent-team/service-framework-repair.ts:557`、`backend/src/agent-team/service-acceptance-policy.ts:61`。修复方向：创建 successor 时明确清空 `latestObservation` 和 `environmentRecovery`；恢复审计只留在 predecessor。

- **P1：代表探针约束只写进 prompt，没有在 intervention API 上 fail closed。** `caseIds` 仍为可选；未传 `--cases` 时会选择该 role 的全部 Case，混选不同 fingerprint/普通 Case 时 `environmentRecoveryProbeForDispatch()` 返回 `null`，随后仍会批量 dispatch 并重置这些 Case。结果是“只探一个代表 Case、之后自动串行续跑”的关键不变量可以被合法 API 调用绕过。定位：`packages/shared/src/agent-team-intervention.ts:18`、`backend/src/agent-team/service-intervention.ts:188`、`backend/src/agent-team/service-acceptance-policy.ts:85`。修复方向：当 run 处于 retryable run-scoped environment blocker 恢复场景时，由后端自动选同 fingerprint 的首个 Case，或拒绝缺失/混合 fingerprint 的请求；不能只依赖主 Agent prompt。

- **P2：协议变更会让更新前已经收到旧 prompt 的 behavior worker 多走一次纠错，极端情况下转 `need_human`。** 新校验要求所有 environment skip 提供 fingerprint/scope，但协议版本仍是 1；旧 prompt 产生的合法旧格式 outbox 会被当作协议错误。现有 protocol correction 能自动补交一次，因此通常只是额外一轮；worker 无法补交时会暂停。定位：`backend/src/agent-team/service-acceptance-policy.ts:312`、`backend/src/agent-team/prompt-builders.ts:17`、`backend/src/agent-team/service-repair-protocol.ts:35`。修复方向：明确这是 v1 的兼容性收紧并保留纠错指标，或提升协议版本并为旧 dispatch 保持旧校验。

- **P2：恢复期间调度和 fixture cleanup 次数由“一批 Case 一次”变成“每个 Case 一次”。** 这是首个真实失败即停的必要代价，会增加 tmux prompt、outbox、持久化和中间 cleanup 次数；复杂度仍为 O(Case 数)，不会形成无界循环。定位：`backend/src/agent-team/service-acceptance-policy.ts:73`、`backend/src/agent-team/service-round-execution.ts:173`。建议记录恢复 campaign 的 Case 数与 dispatch 数，确认大型计划的额外耗时可接受。

## 低风险、可接受副作用

- Run JSON 会为每个失效 Case 多保存一份旧 observation/skip 快照，空间线性增长；单条字段有 160 字符 fingerprint 上限，当前规模可控。
- 错误复用同一 fingerprint 最坏会造成额外重跑，不会直接把 Case 标记为 pass；旧观察仍在 `environmentRecovery` 中可审计。
- 历史 persisted environment skip 没有 fingerprint 时不会被猜测性批量恢复，会继续停在 Human Gate，属于安全的 fail-closed 行为。

## 已核对

- `git diff --check`：通过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm agent-team:verify-control-plane`：19/19 通过。
- 临时状态机验证：同/不同 fingerprint、代表 Case、串行续跑、真实产品失败 bounce 均通过；未新增测试文件。
