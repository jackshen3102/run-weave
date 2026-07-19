# Agent Team 控制面可靠性完整优化计划

> 粒度：L3 执行级
> 来源：`atr_a07db00d_20260717170123` 深度复盘
> 当前配套案例已按能力收敛到 `docs/testing/agent-team/execution/agent-team-execution-and-repair.testplan.yaml`
> 与 `docs/testing/agent-team/recovery/agent-team-recovery-and-fixtures.testplan.yaml`；本文中的 ATFR-011～025
> 保留为历史实施编号，不再作为当前 required Case ID。

## 1. 目标

把本次 Run 暴露的 7 次 Human Gate 分成三类并由不同机制处理：

1. **系统可恢复**：thread 暂时 busy、迟到 completion、dispatch 过渡、协议字段补交——自动恢复，Run 保持 running；
2. **操作现场阻塞**：thread 身份丢失、环境不可用、fixture cleanup失败——进入可恢复的 blocked 状态，给出明确 operator 动作；
3. **人类语义裁决**：scope、acceptance contract、风险接受——只有这类进入 need_human。

最终同时解决四个结果问题：

- 机械性 Human Gate 从 6/7 降为 0；
- 父 Run 完成时不再遗留本轮创建的 live fixture Run；
- repair loop 不再因长文本、自由文本 skip或错误 source verifier路由而停住；
- `critical-path` 真实行为在结构扩展审查前执行，核心 Bug首次发现目标小于 60 分钟。

## 2. 当前现状与差异

| 主题            | 当前代码                                                                                                                                                                                                                                       | 目标差异                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| completion 幂等 | [`service-completion.ts`](../../backend/src/agent-team/service-completion.ts) 先解析 active dispatch，再检查 consumed receipt                                                                                                                  | 先以 outbox dispatchId 命中 receipt；已消费结果不依赖当前 active dispatch            |
| dispatch 状态   | [`service-execution.ts`](../../backend/src/agent-team/service-execution.ts) 可先写 active role + null dispatch，再调用 serial dispatch                                                                                                         | receipt、acceptance fold、active role与下一 dispatch组成单一 transition              |
| 协议补交        | [`service-repair-protocol.ts`](../../backend/src/agent-team/service-repair-protocol.ts) 持久化后立即投递；[`service-worker-dispatch-support.ts`](../../backend/src/agent-team/service-worker-dispatch-support.ts) 遇 agent_running直接不可复用 | correction持久化为 pending delivery，等待同 thread idle；重启可恢复，绝不新开 thread |
| repair 身份     | [`repair-loop.ts`](../../backend/src/agent-team/repair-loop.ts) 比较 `item.invariant.trim() === cycle.invariant.trim()`                                                                                                                        | backend生成稳定 repairContractId；文本只展示，不承载身份                             |
| source verifier | not_reproduced自动 challenge仅覆盖 code_review来源                                                                                                                                                                                             | 按 repair cycle sourceRole回到原 code_review或 behavior_verify                       |
| skip/dependency | shared协议只有自由文本 skipReason；pending skipped被统一当环境阻塞                                                                                                                                                                             | 结构化 skip code和 blockerCaseIds；依赖解除自动局部续跑                              |
| scope           | reviewer可主动 out_of_scope，但 blocking finding可先消耗预算                                                                                                                                                                                   | 每个P0/P1先提交scopeAssessment；out/ambiguous在attempt=0裁决                         |
| fixture         | Run没有kind/owner/cleanup账本，也没有cancelled终态                                                                                                                                                                                             | fixture由父Run+dispatch+Case持有；完成前强制归零，审计记录保留                       |
| 调度顺序        | code_first固定 code→review→behavior                                                                                                                                                                                                            | 有critical-path标签时 code→critical smoke→review→remaining behavior                  |
| 可观测性        | Run `logs: string[]`；UI把所有 need_human显示成“需要人工”                                                                                                                                                                                      | 结构化events/recovery/blocker；UI区分recovering、blocked、need_human                 |

额外事实：父 Run 指向的历史计划和生成案例文件当前不在项目树中，但权威 Run JSON 保留 `ATFR-001～ATFR-010` 的来源身份。因此新案例继承 `ATFR` 并从 `ATFR-011` 继续，不修改或伪造缺失的历史来源。

## 3. 成功指标

| 指标                                    |                     基线 | 完成目标 |
| --------------------------------------- | -----------------------: | -------: |
| 机械性 Human Gate                       |            6 次/本次 Run |        0 |
| active role / dispatch 不一致持久化快照 |                 2 次暴露 |        0 |
| thread busy correction Gate             |                     2 次 |        0 |
| out_of_scope finding 无效修复           |               3 attempts |        0 |
| 父 Run结束后的 owned live fixture       | 至少 10 个非终态现场 Run |        0 |
| 核心行为首次真实执行                    |                 约 5h52m |     <60m |
| 机器统计依赖自由文本日志                |                       是 |       否 |

## 4. 不做什么

- 不回退 dispatch-id-v1，不接受 session-level outbox，不复用旧 dispatch冒充新任务。
- 不允许因为原 thread暂时不可用而新开 thread；上下文安全优先于自动完成。
- 不降低 P0/P1 reproduction、caseImpacts、review checkpoint、真实浏览器证据或测试案例可追溯性。
- 不自动做 out_of_scope/waived；acceptance refresh 由主 Agent 基于代码与验收证据显式执行并留下 intervention 记录，不因 `need_human` 状态再次请求用户确认。
- 不删除现有 `.runweave/agent-team/*.json` 或 outbox history。历史脏现场先保留证据，待新 cleanup能力完成后用可审计 cancelled迁移处理。
- 不在本仓库新增单元测试/TDD文件；验证使用独立脚本、隔离临时项目、真实API和Playwright。
- 不把所有改动塞进一个PR。下面四个PR必须按顺序、逐个通过各自Case后合入。

## 5. 目标数据模型

### 5.1 Run 状态与阻塞所有权

在 `packages/shared/src/agent-team.ts` 扩展：

```ts
type AgentTeamStatus =
  | "clarifying"
  | "running"
  | "blocked"
  | "need_human"
  | "done"
  | "failed"
  | "cancelled";

interface AgentTeamRecoveryState {
  kind: "dispatch_delivery" | "protocol_correction" | "fixture_cleanup";
  state: "pending" | "retrying";
  transitionId: string;
  dispatchId?: string | null;
  attempt: number;
  maxAttempts: number;
  deadlineAt: string;
  lastErrorCode?: string | null;
}

interface AgentTeamBlocker {
  owner: "operator" | "human";
  kind:
    | "worker_identity"
    | "environment"
    | "fixture_cleanup"
    | "scope_decision"
    | "acceptance_decision"
    | "risk_decision";
  reasonCode: string;
  summary: string;
  caseIds: string[];
  createdAt: string;
}
```

规则：

- transient retry写`recovery`，Run保持`running`；
- 需要恢复现场但不需要产品裁决时写`status=blocked`和`blocker.owner=operator`；
- 只有scope/acceptance/risk写`status=need_human`和`blocker.owner=human`；
- `cancelled`只用于明确取消的Run/fixture，不等价于pass、done或failed。

### 5.2 Dispatch delivery 与原子 transition

在 `AgentTeamActiveWorkerDispatch` 墠加：

```ts
purpose:
  | "initial_code"
  | "critical_behavior_smoke"
  | "review"
  | "full_behavior"
  | "repair"
  | "protocol_correction";
deliveryState: "pending" | "delivered";
transitionId: string;
repairContracts?: Array<{ repairKey: string; contractId: string }>;
```

`transitionId`由 backend生成；一次 transition必须在单次`writeRun`中同时写入：

- 旧 dispatch consumed receipt；
- acceptance/loop fold；
- 下一 active role + active dispatch，或两者同时为null；
- recovery/blocker清理；
- 对应结构化event。

tmux prompt无法与JSON文件做分布式exactly-once；本计划采用“持久化身份 + 至少一次投递 + dispatchId幂等消费”。崩溃窗口允许同一dispatch prompt重送，但不允许产生重复状态效果。

### 5.3 Fixture lineage

```ts
type AgentTeamRunKind = "primary" | "verification_fixture";

interface AgentTeamRunLineage {
  ownerRunId: string;
  ownerDispatchId: string;
  ownerCaseIds: string[];
  ownerDevSessionId: string;
  fixtureNamespace: string;
  ownsTerminalSession: boolean;
  cleanupPolicy: "on_owner_dispatch_complete" | "on_owner_run_complete";
}
```

本地控制面直接创建fixture时必须同时满足：owner Run存在、owner dispatch当前有效且role为behavior_verify、owner Case属于该dispatch；不要求fixture与owner同project。跨backend创建时，Dev Session manifest固定记录owner Run、dispatch、Case和fixture namespace，并把同一身份注入candidate backend；candidate只接受与该环境身份一致的fixture lineage。缺一项返回400/409且不创建副作用。历史manifest没有dispatch身份时不得推断所有权。

cleanup不删除JSON/outbox history；它把live fixture置为cancelled、冻结worker、清空active dispatch，并仅在`ownsTerminalSession=true`时回收其独占session/pane。共享session永不由fixture cleanup销毁。

### 5.4 Repair 与 verification 结构化合同

- backend按canonical JSON生成`repairContractId=sha256(...)`；canonical字段只包含repairKey、caseIds、verificationMode、source scenario/evidence identities和review target identity。
- worker回传contractId；`invariant`保留为展示字段并允许旧outbox兼容，不再逐字决定有效性。
- P0/P1 finding新增`scopeAssessment: { status: "in_scope"|"out_of_scope"|"ambiguous"; summary; sourceRefs[] }`。
- acceptance result的skip新增结构化对象：

```ts
skip?: {
  code: "blocked_by_case" | "fail_fast" | "environment" | "not_applicable";
  blockerCaseIds?: string[];
  retryable: boolean;
  detail: string;
};
```

`skipReason`只作旧数据兼容与展示，新dispatch prompt要求结构化skip。
`blocked_by_case`与`fail_fast`必须提供`blockerCaseIds`且`retryable=true`；只有全部blocker Case进入pass后才自动续跑。`environment`等待现场恢复后显式续跑，`not_applicable`固定`retryable=false`并等待人工裁决。续跑种子只取失败、未执行和刚解除依赖的Case，再以`dependsOn`做与数组顺序无关的传递闭包；不得把所有pending Case无条件并入。

### 5.5 结构化事件

现有Activity Facts作为唯一机器可读时间线；所有`agent_team.*`事实的payload至少包含`transitionId/reasonCode/purpose`，按事件补`dispatchId/role/caseId`。同一次Run持久化产生的facts共享`transitionId`。`logs`继续保留为兼容展示投影，禁止机器指标解析中文logs；不新增`AgentTeamRun.events`，避免Activity与Run双写分叉及Run JSON无限增长。

## 6. 实施顺序

### PR 1：Dispatch 原子性与同线程 correction 自动恢复

目标：消除4次由protocol correction和active dispatch空窗造成的机械门禁。

修改范围：

- `packages/shared/src/agent-team.ts`：增加dispatch purpose/delivery/transition和recovery/blocker基础类型；历史字段保持optional。
- `backend/src/agent-team/service-completion.ts`：先从outbox dispatchId查consumed receipt；将receipt并入一次transition写入。
- `backend/src/agent-team/service-execution.ts`：不再先持久化active role + null dispatch；把下一动作交给统一transition builder。
- `backend/src/agent-team/service-serial-dispatch.ts`：新增“携带fold patch建立下一dispatch”的原子入口；旧调用逐步迁移。
- `backend/src/agent-team/service-repair-protocol.ts`：correction改为pending delivery，不立即把thread busy升级Human Gate。
- `backend/src/agent-team/service-worker-dispatch-support.ts`：新增仅针对同一thread identity的idle等待；agent_running是等待态，identity变化才失败。
- `backend/src/agent-team/service-recheck.ts`：startup/watchdog恢复pending delivery；deadline为60秒，事件驱动优先，watchdog兜底。
- `backend/src/agent-team/service-support.ts`：集中append transition event和blocker/recovery状态。
- `frontend/src/components/terminal/terminal-agent-team-panel-model.ts`及attention组件：先支持running+recovery与blocked展示，旧Run保持现状。

关键约束：

- 不修改`submitWorkerDispatchPrompt`对“不得新开已有上下文thread”的底线；新增的是等待/恢复，不是fallback。
- duplicate completion检查必须发生在“active dispatch缺失”门禁之前。
- prompt发送成功但delivered状态未落盘的崩溃窗口按同dispatchId可重送；消费端保证一次效果。
- PR 1不改变repair scope、skip和调度顺序。

验收：ATFR-011～ATFR-014、ATFR-022兼容分支；运行`pnpm agent-team:verify-control-plane`和既有review-checkpoint verifier。

回滚：新增字段均optional；回滚代码后历史Run仍可读取。已写入pending delivery的Run回滚前必须先等待归零，不能在活跃pending状态直接降级。

### PR 2：Fixture 所有权、取消终态与完成门禁

目标：父Run完成时owned live fixture严格为0，不再污染UI和后续事实源。

修改范围：

- `packages/shared/src/agent-team.ts`：增加runKind、lineage、cancelled status、CancelAgentTeamRunRequest。
- `backend/src/routes/agent-team.ts`：create schema接受严格fixture lineage；新增`POST /runs/:runId/cancel`，只做可审计终态化，不物理删除。
- `backend/src/agent-team/service-lifecycle.ts`：校验fixture owner；实现cancelRun；所有自动done和completeRun路径先执行owner cleanup gate。
- `backend/src/agent-team/storage/run-store.ts`：增加`listOwnedFixtureRuns(ownerRunId, ownerDispatchId?)`；现有list/get默认不隐藏fixture，另提供UI projection过滤/分组所需字段。
- `backend/src/agent-team/service-completion.ts`、`service-execution.ts`：behavior dispatch完成时触发其cleanupPolicy；部分失败写blocked/operator blocker。
- terminal资源层：只回收lineage明确标记为独占的session/pane；复用现有session destroy/panel delete能力，不写新的shell清理路径。
- `scripts/dev-session/*`：启动candidate前从active behavior dispatch固定owner scope；fixture-scoped Session必须使用dedicated Backend，自动shared计划升级为dedicated，显式shared请求fail closed；stop必须先调用candidate cleanup并把receipt写入manifest，resource ledger登记Dev Session、Run、terminal、pane和pane-scoped outbox身份，cleanup失败则拒绝停止服务。
- `frontend/src/components/terminal/terminal-agent-team-panel*`与activity history model：primary默认列表不被fixture抢占；fixture可在“验证现场”折叠区审计。
- `packages/runweave-cli/src/client/terminal-http-client.ts`、`commands/agent-team.ts`和`docs/cli/agent-team-cli.md`：提供显式fixture cancel/inspect入口，便于blocked现场恢复；不提供物理delete。

迁移策略：

- 无runKind历史Run按primary读取，无lineage绝不自动清理。
- 本次遗留的14个额外Run先保持只读证据；PR 2完成后生成一次明确清单，由人确认哪些属于该父Run，再调用cancel记录reason。禁止按时间范围自动猜owner。
- parent完成门禁只约束带lineage的新fixture，不让历史无owner数据永久阻断新Run。

验收：ATFR-020～ATFR-022；运行`pnpm agent-team:verify-fixture-lifecycle`和`pnpm work-history:verify`，并补充资源inventory证明没有销毁共享terminal。PR 1的独立`blocked`状态尚未落地时，cleanup gate先复用`need_human`作为可恢复非终态，并以结构化cleanup receipt区分；PR 1合入后迁移为`blocked/operator`。

回滚：cancelled是终态且不可自动恢复为running；回滚前确认没有依赖新status的活跃fixture。历史JSON和outbox history不删除，因此审计可恢复。

### PR 3：Repair contract、scope前置与结构化verification路由

目标：消除长文本误判、错误source verifier、自由文本skip和范围预算浪费。

修改范围：

- `packages/shared/src/agent-team.ts`：增加repairContractId、scopeAssessment、structured skip和lastSkip；旧字段保留optional。
- `backend/src/agent-team/repair-loop.ts`：生成/验证contractId；移除新协议对invariant文本相等的依赖；not_reproduced按cycle.sourceRole返回统一`verifier_reproduction_required`。
- `backend/src/agent-team/repair-review-contract.ts`：P0/P1要求scopeAssessment；out_of_scope/ambiguous进入pending decision；in_scope要求caseImpacts和sourceRefs。
- `backend/src/agent-team/outbox-normalizer.ts`、`outbox-resolver.ts`：兼容旧outbox，严格归一化新结构。
- `backend/src/agent-team/service-completion.ts`：按sourceRole dispatch原verifier；scope decision在resolveRepairTargets和attempt增长前处理。
- `backend/src/agent-team/service-acceptance-policy.ts`：根据blocked_by_case/fail_fast与dependsOn计算最小续跑闭包；environment和not_applicable进入blocked/acceptance decision，不再混为同一Human Gate。
- `backend/src/agent-team/service-execution.ts`：移除“任意pending skipped一律环境阻塞”的自由文本判断。
- `backend/src/agent-team/prompt-builders.ts`：worker只回显repairKey+contractId；review必须给scopeAssessment；behavior必须给structured skip；challenge明确回到原source verifier。
- `backend/src/agent-team/service-intervention.ts`：operator dispatch和human disposition保持权限分离；不能用普通dispatch绕过pending human decision。
- 前端executing section/finding decision：展示scope sourceRefs、structured skip依赖和blocker owner。

兼容策略：

- 已经active且没有contractId的旧dispatch允许按旧协议完成一次；由新代码建立的下一dispatch必须使用contractId。
- 旧skipReason展示为`legacy_unknown`，不能据此自动推断依赖；只有新structured skip参与自动续跑。
- scopeAssessment只对新dispatch prompt要求；历史pending finding维持既有人工裁决，不自动改写。

验收：ATFR-015～ATFR-019、ATFR-022新旧协议分支。

回滚：PR 3不删除旧字段；回滚时新contract outbox仍保留repairKey/invariant兼容展示，但必须先结束所有只含新structured skip的活跃dispatch，避免旧代码误判。

### PR 4：核心行为前置、结构化事件与UI分类

目标：让真实主路径Bug尽早出现，并让Run不再依赖解析中文日志复盘。

修改范围：

- `backend/src/agent-team/service-acceptance-policy.ts`：从Case tags派生`critical-path`集合；无标签保持旧顺序。
- `backend/src/agent-team/service-lifecycle.ts`、`service-completion.ts`、`service-execution.ts`：实现code→critical behavior smoke→review→remaining behavior；每个dispatch写purpose。
- `backend/src/agent-team/activity-events.ts`：增强现有Activity Facts，写入结构化`transitionId/reasonCode/purpose`；同一次Run write发出的facts共享transitionId。
- `packages/shared/src/activity/contracts.ts`：定义Activity purpose/reasonCode有限枚举；不增加Run event数组，敏感字段不进入Activity payload。
- `frontend/src/components/terminal/terminal-agent-team-panel-model.ts`、`terminal-agent-team-panel-attention.tsx`、`terminal-agent-team-executing-section.tsx`：展示recovering/blocked/need_human三类状态、dispatch purpose、fixture归属与scope decision。
- `frontend/src/pages/activity/agent-team-history-model.ts`：继续使用Activity Facts生成timeline；logs只作兼容展示，不作为机器指标来源。

调度规则：

1. 只有Case明确带`critical-path`才启用early smoke；不靠标题或模型猜测。
2. 初始code完成后只派critical Case；fail走现有同场景repair，pass后进入review。
3. review只读，不使critical pass失效；任何后续code改动按受影响Case机制重新置pending。
4. review通过后派剩余pending behavior Case，不重跑未受影响的critical pass。
5. 无critical标签Run保持现有code→review→behavior，避免全局增加dispatch成本。

验收：ATFR-023～ATFR-025；UI必须通过`$toolkit:playwright-cli`真实验证，静态截图不能代替。

回滚：early smoke由标签触发，可先停止新增标签实现行为级回滚；events是附加字段，旧UI仍可使用logs。

## 7. 验证脚本设计

新建而非继续膨胀现有单文件：

- `scripts/verify-agent-team-control-plane.mjs`：总入口，只编排场景并输出Case ID/结果。
- `scripts/verify-agent-team-control-plane/dispatch-transition.mjs`：ATFR-011～014。
- `scripts/verify-agent-team-control-plane/repair-contract.mjs`：ATFR-015～019。
- `scripts/verify-agent-team-control-plane/fixture-lifecycle.mjs`：ATFR-020～022。
- `scripts/verify-agent-team-control-plane/scheduling-events.mjs`：ATFR-023～024。
- `scripts/verify-agent-team-control-plane/harness.mjs`：隔离temp project、fake panel mutation、prompt recorder和故障注入；不包含业务断言。
- `package.json`：增加`agent-team:verify-control-plane`。

脚本要求：

- 每个Case独立创建临时project/run，不依赖上一Case遗留状态；
- 使用固定时钟或可注入clock验证deadline，禁止真实sleep 60秒；
- 每个场景finally检查临时Run、session、pane和server全部终态；
- 输出`CASE_ID PASS/FAIL`和证据路径，任一失败退出非0；
- 不创建`*.test.*`或`*.spec.*`单元测试文件。

## 8. API 与兼容性清单

需要同步更新：

- shared DTO与状态union；
- backend Zod create/cancel/finding/outbox validation；
- frontend API client和状态展示；
- runweave CLI client/命令/文档；
- work-history/activity读取`blocked/cancelled`；
- export保留lineage/recovery/blocker/events；
- startup reconciliation识别pending delivery/cleanup；
- 旧Run默认primary、旧status和旧outbox保持可读。

禁止采用启动时批量重写所有历史JSON的迁移。使用read-compatible、write-new-schema策略；只有经人确认的历史fixture执行显式cancel写回。

## 9. 风险与防护

### 数据丢失

风险最高的是fixture cleanup误删用户session。防护：没有`ownsTerminalSession=true`和owner identity双重匹配时只取消Run，不销毁session；永不删除history。

### 重复prompt

prompt与JSON无法原子提交。防护：同一dispatchId可至少一次投递，worker outbox和backend consumed receipt保证一次状态效果；事件明确记录redelivery，不宣称exactly-once。

### 状态兼容

新增blocked/cancelled会影响work history和UI exhaustive switch。每个PR先完成shared/backend/frontend/CLI typecheck，旧数据Case ATFR-022是合入硬门禁。

### 调度成本

early smoke可能增加dispatch。只由`critical-path`标签触发，并且只跑子集；以“首次真实行为<60m”和“总dispatch不因无标签Run增加”为双指标。

### Human Gate语义

不能为了把指标降到0而自动绕过风险。系统恢复失败进入blocked/failed，scope和risk仍必须need_human；前端与通知必须保留差异。

## 10. 每个PR的完成定义

每个PR必须同时满足：

- 对应ATFR Case全部通过并保存指定Run/outbox/API证据；
- `pnpm agent-team:verify-review-checkpoints`无回归；
- shared/backend/frontend/CLI typecheck通过；
- `pnpm lint`与`git diff --check`通过；
- 没有新增单元测试文件；
- 没有把现存无关工作区改动带入；
- code_review确认没有P0/P1；
- 涉及UI的PR 2/4实际执行`$toolkit:playwright-cli`。

最终整体验收按 Agent Team 测试索引执行 execution 与 recovery 两类当前 required Case，并运行对应
`agent-team:verify-*` 脚本；不再执行已删除的历史方案型 ATFR-011～025 Markdown Case。

## 11. 推荐执行节奏

1. PR 1先消除当前最频繁且最确定的机械门禁；不要同时改repair语义。
2. PR 2建立fixture所有权后，再运行任何会创建子Run的真实behavior验收。
3. PR 3处理协议与路由；使用PR 1的原子transition和PR 2的隔离fixture作为验证基础。
4. PR 4最后改变调度顺序和UI，以前三个PR的结构化状态作为输入。
5. 四个PR全部通过后，再单独发起一次经人确认的历史fixture cancelled迁移；不与功能代码混在同一提交。
