# Environment blocker recovery 副作用收口计划

## 目标

在不扩大现有恢复架构的前提下，收口 environment blocker recovery 的两个 P1 边界：

1. 框架修复创建的 successor Run 不继承 predecessor 的恢复调度状态。
2. environment recovery intervention 在后端强制转换为唯一、确定的代表 Case 探针，省略或混选 Case 时也不能批量重置验收状态。

完成后仍保持以下不变量：同 fingerprint 的 run-scoped retryable environment skip 才能跨 Case 失效；恢复后按验收文件顺序一次派发一个 Case；首个真实产品失败立即进入现有 bounce/fail-fast。

## 非目标

- 不改变 `InterveneAgentTeamRunRequest`、CLI 参数或 HTTP API 结构。
- 不升级 `workerDispatchProtocolVersion`，不迁移历史 Run JSON。
- 不改变 `blocked_by_case`、`fail_fast`、`not_applicable` 的现有处理。
- 不改变正常 behavior dispatch、code/code_review intervention、repair budget 或 checkpoint 流程。
- 不新增 UI、后台轮询器、数据库表、恢复 action 或单元测试文件。

## 当前代码与差异

### Successor Run 状态泄漏

`backend/src/agent-team/service-framework-repair.ts` 的 `resetAcceptance()` 通过展开 predecessor Case 构造 successor Case，但未清空 `latestObservation` 和新增的 `environmentRecovery`。`backend/src/agent-team/service-acceptance-policy.ts` 又把 `environmentRecovery` 当成活动恢复 campaign 的调度依据，因此新 Run 会受旧 Run 的恢复顺序影响。

目标是：predecessor 保留完整恢复审计；successor 只复制验收合同字段，所有运行态观察和恢复调度字段从空状态开始。

### Intervention 门禁未闭合

`packages/shared/src/agent-team-intervention.ts` 允许省略 `caseIds`；`backend/src/agent-team/service-intervention.ts` 会在省略时选择该 role 的全部 Case。当前 `environmentRecoveryProbeForDispatch()` 对混合 Case 或多个 fingerprint 返回 `null`，调用方随后仍按普通 dispatch 批量重置 Case。

目标是：只要一次 behavior intervention 明确命中 run-scoped retryable environment blocker，后端就必须在任何 Run 写入前解析出唯一 fingerprint 和唯一代表 Case，无法无歧义解析时以 400 拒绝且零状态副作用。

## 业务规则

### Successor 清理规则

框架修复 rerun 构造 successor acceptance 时：

- `latestObservation = null`
- `environmentRecovery = null`
- 继续使用现有逻辑清空 status、skip、result、evidence、bounce 和 recheck 字段
- predecessor Run 不修改，原 observation、skip 和 environmentRecovery 审计继续保留

### Environment recovery intervention 解析规则

仅对 `role=behavior_verify` 且命中以下 Case 的 dispatch 启用特殊解析：

- `latestObservation.outcome = skipped`
- `skip.code = environment`
- `skip.retryable = true`
- `skip.blockerScope = run`
- `skip.blockerFingerprint` 非空

解析行为：

1. 显式 `caseIds` 全部属于同一 fingerprint：以该 fingerprint 在 acceptance 顺序中的第一个 blocked Case 为唯一探针；即使请求选中多条也只派一条。
2. 显式 `caseIds` 混入普通 Case、case-scoped blocker 或多个 fingerprint：返回 400；不得先更新 status、logs、intervention history 或 acceptance。
3. 省略 `caseIds`，且当前 Human Gate 只有一个可恢复 run-scoped environment fingerprint：后端自动选择该 fingerprint 的第一个 blocked Case。
4. 省略 `caseIds`，但存在多个可恢复 fingerprint：返回 400，并在错误中列出 fingerprint 与各自最前 Case，要求调用方明确选择。
5. 请求没有命中 run-scoped environment blocker：完全沿用现有普通 intervention 行为，不改变 code、code_review 或其他 behavior 恢复路径。

“第一个 Case”始终按 `acceptanceCasesForRole(run, "behavior_verify")` 的现有数组顺序决定，不新增排序字段。

## 实施任务

### 1. 清除 successor 的旧恢复状态

修改 `backend/src/agent-team/service-framework-repair.ts`：

- 在 `resetAcceptance()` 中显式设置 `latestObservation: null` 和 `environmentRecovery: null`。
- 不修改 predecessor，不改变其他 reset 字段。

验证：构造带 environmentRecovery 的 predecessor 并执行 framework repair rerun；successor Case 为 pending 且两个字段为空，predecessor 审计不变。

### 2. 将探针选择变成后端门禁

修改 `backend/src/agent-team/service-acceptance-policy.ts`：

- 基于现有 `isRunScopedEnvironmentBlocker()` 提供一个无状态解析函数，返回“非 environment recovery”或 `{ probe, case }`。
- 对混选、多 fingerprint 等歧义输入抛出 `AgentTeamError(400, ...)`。
- 复用现有 fingerprint 匹配、旧 observation 快照和 affectedCaseIds 生成逻辑，不创建第二套恢复模型。

修改 `backend/src/agent-team/service-intervention.ts`：

- 在 `updateRun()` 之前调用解析函数。
- 解析为 recovery 时只把代表 Case 传给 `dispatchSerialWorker()`，并把 probe 放入 active dispatch。
- 解析失败时不得产生 Run store 写入。
- 非 recovery 时保留原有 `selectAgentInterventionCases()` 路径。

### 3. 保持兼容和成本边界

- 保留旧 worker 的一次 protocol correction；不提升协议版本。
- 历史 environment skip 缺 fingerprint 时继续 fail closed，不推断 fingerprint。
- 不新增定时任务；恢复成本保持最多每个待验收 Case 一个 dispatch，空间保持每个失效 Case 一个审计快照。

## 文件范围

必须修改：

- `backend/src/agent-team/service-framework-repair.ts`
- `backend/src/agent-team/service-acceptance-policy.ts`
- `backend/src/agent-team/service-intervention.ts`
- `docs/testing/agent-team/execution/agent-team-execution-and-repair.testplan.yaml`

按本计划不应修改：

- `packages/shared/src/agent-team-intervention.ts`
- `packages/runweave-cli/**`
- `frontend/**`
- `electron/**`
- `app/**`
- worker protocol 版本与存储 schema

## 验收标准

行为验收使用 `docs/testing/agent-team/execution/agent-team-execution-and-repair.testplan.yaml` 中 `AGT-EX-010` 至 `AGT-EX-012`：

- 同 fingerprint 恢复只派一个代表 Case，后续严格按 acceptance 顺序一次一条。
- 省略 Case 但 fingerprint 唯一时可自动解析；混选或多个 fingerprint 时 400 且 Run 快照完全不变。
- framework repair successor 不包含 predecessor 的 observation/recovery 调度状态，predecessor 审计仍存在。
- 代表 Case 返回真实产品 fail 时，现有 bounce 在下一 behavior dispatch 前发生。

静态与回归门禁：

```bash
pnpm testplan:validate docs/testing/agent-team/execution/agent-team-execution-and-repair.testplan.yaml
pnpm typecheck
pnpm lint
pnpm agent-team:verify-control-plane
pnpm agent-team:verify-framework-recovery
```

通过标准：所有命令退出码为 0；control-plane 与 framework-recovery 的既有检查数不减少。失败时停止，不通过修改共享 API、协议版本或扩大重跑范围绕过。

## 风险、回滚与副作用控制

- 最大行为变化仅发生在 environment recovery intervention：歧义请求从“批量 dispatch”变为“400 零副作用”，这是预期的 fail-closed 收紧。
- framework repair successor 会失去 predecessor 的运行态 observation，但 successor 本来就是全新 Run；审计仍在 predecessor，因此没有证据丢失。
- 如果上线后需要回滚，只回滚上述三个后端文件即可；新增共享字段和现有 persisted Run 无需迁移或清理。
- 不通过协议升级解决兼容问题，避免同时影响在途 worker、CLI、Desktop 和历史 Run。
