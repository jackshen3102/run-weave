# Beta 资源管理测试计划合理性评审

## Review Scope

- Run：`atr_d3024666_20260718153150`
- 测试计划：`docs/testing/platform/beta-resource-management.testplan.yaml`
- 评审目标：逐条判断 BRM-001～BRM-012 的验收合同是否合理、当前 pass/skip 是否可信，以及暂停应归因于环境、实现、验证基础设施还是执行顺序。
- 边界：只读评审；未修改实现、测试计划、Run JSON 或 outbox，未触发新的 Agent Team dispatch。

## Verdict

测试计划整体合理，12 条 Case 都直接对应实施计划承诺的安全不变量，不建议 `refresh_acceptance`。当前流程暂停也不是 `agent_running` 投递排队：Run 已无 active worker，worker pane 均为 idle；它因 BRM-001、BRM-009～012 被结构化标记为 `environment skipped` 而进入 Human Gate。

当前结果应拆成三类：

1. BRM-002～008：行为结论与合同匹配，可以保留 pass。
2. BRM-001：产品行为证据足以支持 Case 本体，但 Dev Session finally 因 cleanup 认证失败，按资源账本合同不能完成；应修 cleanup 后只重跑 BRM-001。
3. BRM-009～012：Case 合理，但当前 `environment` 归因不准确。BRM-009 缺少计划明确要求的可控崩溃注入；BRM-010～012 则缺少集成 fixture/执行编排，不能把本轮 planner 选中 fullstack 等同于产品不存在 Beta 入口。

## Findings

### P1：BRM-001 的 cleanup 认证实现使已验证行为无法完成资源门禁

`resolveCleanupAuth()` 只有 Electron profile token 和固定 `admin/admin` 两条路径（`scripts/dev-session/agent-team-fixture-cleanup.mjs:271-302`）。BRM-001 的 dedicated Backend 使用非默认认证且 fullstack Session 不含 Electron，因此 `dev:stop` 在停止服务前收到 HTTP 401，Session `dvs-4ed2ba` 仍为 ready。

这不是 BRM-001 验收合同问题。Run 内已有隔离 HOME 的五槽投影、逐槽分类和查询前后文件指纹一致证据；缺的是符合 owner ledger 的最终 cleanup receipt。当前 pending 合理，但 `environment` 只是表象，根因是 cleanup credential resolution 的实现缺口。

### P1：BRM-009 是 required Case，但仓库没有可控 finalizer 故障注入面

实施计划明确要求“在每个故障注入点中断 finalizer 后重跑 status/recover”（`docs/plans/2026-07-18-beta-resource-management.md:431`），并要求临时 HOME、真实子进程和文件 identity fixture 覆盖崩溃窗口（同文件 `:469`）。当前 finalizer 直接顺序执行 reset、metadata、stopping manifest、lease release 和 completed manifest（`scripts/dev-session/beta-slot-pool-lifecycle.mjs:82-163`），没有命名 checkpoint 或受控 failpoint。

因此 BRM-009 本身合理，worker 没有把静态推断写成 pass 也合理；但把缺少计划内验证能力写成外部 `environment` 不准确。这是尚未完成的验证基础设施/实现工作，required Case 在补齐前不能关闭。

### P1：BRM-010～012 的 skip 理由错误地把“选了 fullstack”解释成“没有 Beta 入口”

planner 明确允许显式提升为 beta，并支持 `--instance pool-0N`（`scripts/dev-session/planner.mjs:466-503`）；CLI 也实现了 requested slot、有界恢复重试以及并发 allocator winner/loser 错误（`scripts/dev-session/cli.mjs:443-485`）。本次只读 dry-run 的实际结果为 `profile=beta`、`selectedBy=explicit-profile`、`requiredProfile=fullstack`、`executable=true`、`unsupportedServices=[]`。

所以 BRM-010～012 不能仅因当前 validation Session 是 fullstack 就判定入口不存在。真正缺口是：尚无安全、可重复、owner-scoped 的隔离 fixture 来构造满池并发 start、显式目标的四种槽位状态，以及 recovered/blocked/preserved 三处 receipt 与 secret-redaction 场景。三条 Case 都应保持 pending，但归因为验证编排/fixture 缺口，而不是不可恢复的环境问题。

### P2：BRM-002～008 的证据足以判行为，但可审计持久性偏弱

这些 Case 的 detail 包含真实子进程、inode/mtime、receipt、等待时长和资源保持结果，结论与合同逐项对应；但是多数 `ref` 是 `BRM-00x ... / scene` 形式的逻辑标识，没有对应 `.runweave/evidence` 持久文件。当前 Run JSON 足以保存结论，但后续独立复核不容易重放原始命令输出。后续重跑 pending Case 时，应把结构化 JSON/command output 落到 owner-scoped evidence 目录，并让 `ref` 指向实际路径。

## Per-case Assessment

| Case    | 合同是否合理                       | 当前结论是否合理                                               | 判断与下一步                                                                                                                              |
| ------- | ---------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| BRM-001 | 合理                               | `pending/skipped` 的门禁结果合理，`environment` 根因分类不准确 | 五槽投影和只读性本体已有充分证据；先修 cleanup 认证并安全停止 `dvs-4ed2ba`，再只重跑本 Case。                                             |
| BRM-002 | 合理                               | pass 可信                                                      | 明确区分 acquisition PID 与 runtime health，也覆盖新近 orphan 的保守 preserved；保持 pass。                                               |
| BRM-003 | 合理                               | pass 可信                                                      | 覆盖“一次清空所有零进程 stale”、健康 Session 保持、receipt 三处一致与第二次幂等；保持 pass。                                              |
| BRM-004 | 合理                               | pass 可信                                                      | 记录 5830ms 二次检查，只停止目标 owner 的 live component，并在释放后重新原子 acquire；保持 pass。                                         |
| BRM-005 | 合理                               | pass 可信                                                      | 分离 hygiene 的零成本全清与 capacity pressure 的最少 live 回收，且校验 acquiredAt 稳定排序；保持 pass。                                   |
| BRM-006 | 合理                               | pass 可信                                                      | 三类 identity/unknown blocker、显式 recover 诊断、资源零副作用和 force 参数拒绝均已覆盖，并经过独立 review gate；保持 pass。              |
| BRM-007 | 合理                               | pass 可信                                                      | owner lock busy 与 shared degraded 都被保留，且共享进程/引用 Session 未改写；保持 pass。                                                  |
| BRM-008 | 合理                               | pass 可信                                                      | 覆盖安全 quarantine、active path blocker 和 ENOTDIR 失败后的幂等重试；保持 pass。                                                         |
| BRM-009 | 合理，但执行前提需要具名 failpoint | skip 是诚实的，`environment` 分类不合理                        | 在现有 finalizer 增加只供 verifier 使用的确定性 checkpoint/failure injection，并通过真实临时 HOME/子进程跑四个入口；不得删除或弱化 Case。 |
| BRM-010 | 合理                               | 当前 skip 理由不成立，尚不能判 pass                            | Beta start 和并发保护代码已存在；补 owner-scoped 满池 fixture，真实并发两个 start 后选择性重跑。                                          |
| BRM-011 | 合理                               | 当前 skip 理由不成立，尚不能判 pass                            | `--profile beta --instance pool-0N` 已受支持；补 healthy/partial/mismatch/idle 隔离现场，验证显式目标不回退。                             |
| BRM-012 | 合理                               | 当前 skip 理由过宽，尚不能判 pass                              | receipt 持久化路径存在，但缺 recovered/blocked/preserved 的集成场景与 secret fixture；补齐后验证三处一致和序列化脱敏。                    |

## Minimal Recovery

1. 不修改测试计划，不执行 `refresh_acceptance`。
2. 修复 dedicated/fullstack Backend 的 cleanup credential resolution，完成 `pnpm dev:stop --session dvs-4ed2ba --json`，确认 `fixtureCleanup.status=completed`、`ownedLiveFixtureRuns=0`。
3. 为 BRM-009 补齐计划内的确定性 finalizer failpoints；为 BRM-010～012 补齐临时 HOME、真实子进程、owner-scoped 的 Beta fixture/执行入口。不要直接占用当前全局四个 occupied Beta slot 构造验收现场。
4. 代码复审通过后，仅重新 dispatch `BRM-001,BRM-009,BRM-010,BRM-011,BRM-012`；BRM-002～008 和 AGT-REVIEW-GATE 保留现状，不全量重跑。

## Checks Performed

- `pnpm testplan:validate docs/testing/platform/beta-resource-management.testplan.yaml`：通过，12 条 required Case。
- `pnpm dev:session --profile beta --dry-run --json`：显式 beta profile 可执行，`unsupportedServices=[]`，当前容量快照为 1 idle / 4 occupied。
- `pnpm dev:status --session dvs-4bbfc4 --json`：上一轮 Session 已 stopped，`fixtureCleanup.status=completed`、`ownedLiveFixtureRuns=0`。
- 只读检查 Run JSON、各 Case result/evidence、相关 planner/CLI/finalizer/cleanup 实现与 `.runweave/evidence`；未执行行为重跑。
