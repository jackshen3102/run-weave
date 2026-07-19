# Beta 固定资源池管理 Round 6 代码复审

## 结论

审查不通过。Round 6 修复已让 `runBetaPoolRecoveryPass()` 返回未选候选的 `preserved` receipt、`candidateOrder` 和 `orderingReason`，资源选择仍保持最小回收；但真实 Beta start 的聚合边界只复制 `recovered/preserved/blocked/failed`，把新增的两个排序解释字段丢弃。BRM-005 要求的候选顺序原因仍不可达实际 start 输出，存在 1 条 open P1。

## 审查范围

- Dispatch：`ee5779d6-814a-4bb6-a55e-a0e6e78e7410`
- 基线：`HEAD=af3f8b8091458935dde7b2c7b51c120d991de0fb`
- Code Agent dispatch：`55476b43-f9c9-4bba-b34e-51baa5850abb`
- 本轮修复文件：`scripts/dev-session/beta-slot-pool-recovery.mjs`、`scripts/dev-session/verify-beta-slot-pool.mjs`、`scripts/verify-dev-session.mjs`
- Repair：`behavior_verify:BRM-005`
- 当前 run 未提供冻结 `reviewTarget`；本轮以 repair cycle、Code Agent outbox 和当前工作树为边界。

## Findings

### P1：排序解释字段没有传播到 Beta start 输出

`scripts/dev-session/beta-slot-pool-recovery.mjs:605-658` 正确构造并返回 `candidateOrder` 与 `orderingReason`。然而生产调用方 `scripts/dev-session/cli.mjs:388-399` 的 `poolRecovery` 只声明四个 receipt 数组，`mergePoolRecovery()` 也只复制 `recovered`、`preserved`、`blocked`、`failed`。容量恢复结果在 `scripts/dev-session/cli.mjs:451-456` 进入该聚合函数后，新增排序字段被丢弃；最终 start 输出发布的仍是这个裁剪后的 `poolRecovery`。

隔离静态合同 `brm-005-start-output-explanation-static-contract-round6` 确认：producer 同时提供两个字段，consumer 的四类数组可达 start 输出，但 `candidateOrderReachableAtStartOutput=false`、`orderingReasonReachableAtStartOutput=false`。仓库全局搜索也显示生产代码中没有其它消费者转发这两个字段。

这直接违反 BRM-005 第 3 步：未选 pool-02 的 receipt 虽能说明“容量已由更高优先级候选满足”，却没有恢复成本、acquiredAt、rank 或明确的稳定排序规则；操作者仍无法从实际 Beta start 输出判断为何 pool-01 优先于 pool-02。修复应让 start 的聚合合同保留每次 recovery pass 的 `candidateOrder` 和 `orderingReason`（多次 pass 时需明确分组或合并语义），并在真实 start 输出边界增加断言；仅验证私有 pass 返回值不能关闭该 Case。

## Resolved Findings

本轮没有完全关闭的 finding。资源最小回收和未选候选保留逻辑已经成立，但解释字段尚未到达产品输出边界，因此 `behavior_verify:BRM-005` 不能标记 resolved。

## 已执行检查

- `brm-005-start-output-explanation-static-contract-round6`：确认 producer 有 `candidateOrder/orderingReason`，start merge 不复制二者，两个字段均不可达产品输出。
- `rg -n "candidateOrder|orderingReason" ...`：除 recovery producer 与 verifier 外无生产消费者。
- `pnpm dev:session:verify`：首次在既有 `verify-registry.mjs:517` status/stop race 断言出现一次 `undefined !== 5`，立即原命令重跑通过；该文件本轮无 diff，未作为 finding。
- `pnpm testplan:validate docs/testing/platform/beta-resource-management.testplan.yaml`：通过，12 个 required cases。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `git diff --check`：通过。

审查全程只读取实现并运行本地静态合同和仓库门禁；未启动或停止 Dev Session，未访问外部系统，未修改实现代码。
