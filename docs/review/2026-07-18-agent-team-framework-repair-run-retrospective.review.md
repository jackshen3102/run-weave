# Agent Team framework repair Run 深度复盘

复盘对象：`atr_a07db00d_20260717170123`
复盘时间：2026-07-18
结论性质：只读复盘，不修改实现、不改验收合同、不干预现有 Run

## 一、结论

这个 Run 的结果是成功的：父 Run 最终 `done`，11/11 acceptance case 通过，测试案例可追溯，worker split 符合 `code / code_review / behavior_verify` 三角色要求，dispatch 与 pane-scoped outbox 均留下了可审计记录。

但过程效率和现场治理不合格：总历时 6 小时 52 分，消费 17 个 dispatch，进入 7 次 Human Gate。7 次中只有 1 次——是否把 ATFR-007 扩张到 predecessor finalization 精确失败注入——真正需要人类做范围裁决；其余 6 次属于系统本可自动恢复的调度、协议或验证编排问题。

最关键的反直觉结论是：**ATFR-006 不是一个很难修的 Bug。它合理、能够在真实产品中复现，并在首次真实执行后很快定位并修复；真正的问题是它直到 Run 启动约 5 小时 52 分后才第一次被真实执行。** 此前的大量成本消耗在协议补交、dispatch 中间态、结构审查和超出既定范围的 ATFR-007 finding 上。

## 二、量化结果

| 指标                  |            结果 | 判断                             |
| --------------------- | --------------: | -------------------------------- |
| 父 Run 总历时         |      6h 52m 13s | 过长                             |
| 最终 acceptance       |      11/11 pass | 结果合格                         |
| consumed dispatch     |              17 | 编排成本偏高                     |
| repair loop           |           11 轮 | 收敛过慢                         |
| Agent intervention    |            6 次 | 自动恢复不足                     |
| Human Gate            |            7 次 | 其中 6 次为机械性门禁            |
| Human Gate 等待       |      约 97m 26s | 约占总时长 23.6%                 |
| 真正人工语义裁决      |            1 次 | 应成为 Human Gate 的唯一主要用途 |
| ATFR-006 首次真实复现 | 启动后约 5h 52m | 核心行为验证严重后置             |

Human Gate 等待时长由父 Run 日志、outbox consume 和 intervention 的相邻时间估算，不应当作精确性能埋点；但数量级和主因明确：其中约 86 分钟用于 ATFR-007 范围裁决。

## 三、Run 实际经过

### 1. 初始化阶段：正确建立了可追溯验收

系统先识别到缺少可追溯测试案例，随后生成 `docs/testing/agent-team/agent-team-framework-repair-recovery-test-cases.md`，再按 `code / code_review / behavior_verify` 提交 split。这个门禁是正确的，避免了默认泛化 acceptance，也为后续每次局部重派提供了稳定 Case ID。

### 2. code 与 code_review 阶段：结构 finding 连续消耗修复轮次

初始 code dispatch 后，review 先后聚焦 continue 历史保留与 rerun rollback-safe 边界。ATFR-003 / ATFR-007 在多轮 code → review bounce 中反复出现。

这一阶段出现了三类控制面问题：

- fixVerifications 缺少协议字段，需要原 thread 补交；
- active role 存在但 activeWorkerDispatch 为空；
- ATFR-007 的 finding 实际已经进入计划和测试案例明确排除的中断/事务注入边界，却在请求 scope disposition 前先消耗完 3/3 修复预算。

最终用户把该 finding 裁决为 `out_of_scope`。这个人工决定合理，但发生得太晚。

### 3. behavior_verify 阶段：真实产品问题终于出现

behavior verifier 先在严格顺序下遇到 UI 恢复卡片不渲染，导致后续 Case 未执行；Backend 非 UI 状态机检查通过，但不能替代真实 UI 证据。这个停止行为符合严格逐条验收合同。

随后系统又出现两类不必要的 Human Gate：

- code 对 behavior finding 返回 `not_reproduced`，状态机没有自动把挑战路由回原 behavior verifier；
- 前置 blocker 解除后，ATFR-003/006/007 仍以自由文本 skip/pending 存在，系统无法机器判断依赖已解除，只能请求 intervention。

ATFR-006 在真实 UI 中首次执行时成功复现：terminal 绑定 Run 查询选择了“更新时间更晚的失败 predecessor”，而不是正在运行的 successor。修复收敛到 Run 选择排序规则，优先非终态活动 Run。之后 ATFR-006、ATFR-007 真实行为通过，父 Run 达到 11/11。

### 4. 父 Run 完成后：测试现场没有完整回收

behavior verifier 为 rerun / continue 创建了多组真实 Run。父 Run 完成后，`.runweave/agent-team` 中仍存在多个本轮产生的 `running` 或 `need_human` fixture Run，例如 `atr_30f6…`、`atr_4b58…`、`atr_08cd…`、`atr_969…`、`atr_d224…`。

这些子 Run 还会继续写共享项目下的 review 文档和 outbox。也就是说，父 Run 的 `done` 只代表父状态机完成，不代表本次验收现场已闭合。它会污染后续 Agent Team 面板的活动 Run 选择、review 轮次、运行事实读取和下一次测试。

这是本次复盘中优先级最高的可靠性问题。

## 四、ATFR-006 专项判断

### 能否复现

能。它在首次完整真实 UI rerun 路径中直接复现，不是由代码阅读、mock 或 review 摘要推断出来的。

### Case 是否合理

合理，而且不是低价值边界 Case。它验证 rerun 的核心产品语义：

1. 旧 Run 被保留；
2. 新 Run 使用新 runId / dispatch；
3. 新 Run 不继承旧执行结论；
4. UI 与 terminal 绑定选择新活动 Run，同时保留新旧双向追踪。

如果 UI 仍选择失败 predecessor，用户会看到错误的活动 Run，后续 continue、review、证据读取都可能作用在错误对象上。这是主路径身份一致性问题，不是罕见崩溃或存储中断边界。

### 为什么“能复现却一直解决不了”

前提不准确：它不是一直修不好，而是一直没有进入可信的真实复现路径。

- 前四轮主要处理结构 review finding；
- 3 次修复预算被 ATFR-007 的范围外事务边界消耗；
- 之后等待人工 disposition 约 86 分钟；
- behavior 阶段又先遇到 UI blocker、not_reproduced 路由和严格顺序 pending；
- ATFR-006 到约 22:53 才首次真实执行，随后在一个行为修复周期内收敛。

因此问题难度应判断为中低，流程发现延迟才是主成本。

## 五、严重问题

### [P1] 验证 fixture 没有所有权与强制回收

**现象**
父 Run `done` 后仍留下多个本轮创建的非终态 Run；部分子 Run 在父 Run 结束附近继续生成 review / outbox 产物。

**根因**
真实行为测试把产品级 Run 当 fixture 使用，但没有 `fixtureOwnerRunId`、隔离 source root、统一资源登记和 finally cleanup。父 Run 的完成条件也没有检查 owned live fixture 是否归零。

**风险**

- Agent Team 面板可能选中错误的活动 Run；
- 后续查询被残留 `running` Run 干扰；
- review 文档轮次和 outbox 继续增长，破坏事实边界；
- 下次复现可能在脏现场上得到不同结果。

**建议**

1. 所有行为验证创建的 Run 写入 `fixtureOwnerRunId` 和 `fixtureCaseId`；
2. 使用隔离 project/source root 或明确的 fixture namespace；
3. verifier 用资源账本登记 Run、pane、outbox、Dev Session；
4. finally 将所有 owned Run 置于终态并回收 pane；
5. 父 Run behavior_verify 完成门禁增加 `ownedLiveFixtureRuns === 0`。

### [P1] 协议补交与 worker thread 生命周期存在确定性竞态

**现象**
两次 fixVerifications 协议补交无法投递，错误均为既有 agent thread 当前不可复用、又禁止新开 thread 丢失上下文。

**代码机制**
[`service-repair-protocol.ts`](../../backend/src/agent-team/service-repair-protocol.ts) 在创建并持久化 correction dispatch 后立即发送；[`service-worker-dispatch-support.ts`](../../backend/src/agent-team/service-worker-dispatch-support.ts) 只在既有 thread 为 `agent_idle` 时允许复用。completion hook 到达时 thread 常仍处于 `agent_running`，因此补交请求天然容易撞上不可复用窗口。

**建议**
把补交建模为同 thread 的 `correction_pending` 队列，等待 thread idle 事件后再投递；设置有界超时。超时才转为系统故障，而不是立即进入 Human Gate。继续保留“不得新开 thread 丢失上下文”的安全约束。

### [P1] active role / active dispatch 的状态切换不是原子的

**现象**
两次出现 dispatch-id-v1 Run 缺少 activeWorkerDispatch，系统正确拒绝 legacy fallback，但只能请求 intervention。

**代码机制**
[`service-execution.ts`](../../backend/src/agent-team/service-execution.ts) 会在消费完成后清空 dispatch，并可持久化“仍有 active role、但 dispatch 为 null”的中间态；[`service-completion.ts`](../../backend/src/agent-team/service-completion.ts) 对该组合直接进入 Human Gate。迟到或重复 completion 命中这个窗口，就把内部状态切换暴露为人工问题。

**建议**

- 将“消费旧 dispatch + 安装下一 dispatch + 更新 active role”作为单一 transition 持久化；或显式增加 `dispatch_transitioning` 状态；
- 对已经有 consumed receipt 的重复 completion 做幂等忽略；
- Human Gate 只处理无法判定身份的真实冲突，不处理可由 receipt 判定的迟到事件。

### [P1] 范围裁决发生在修复预算耗尽之后

**现象**
ATFR-007 的 predecessor finalization 精确失败注入在完成 3/3 次合格修复交接后仍失败，系统才请求人工 disposition，最终被裁决 `out_of_scope`。

**判断**
计划与测试案例已经明确排除写入中断、罕见崩溃或跨进程事务语义。review finding 可以提出风险，但不应直接占用既定 Case 的全部修复预算。

**建议**
finding 建立时先执行 scope classification：若场景命中计划/Case 的显式 non-goal，直接请求一次 scope disposition；只有确认 in_scope 后才进入 repair attempt 计数。

## 六、重要改进

### [P2] 用稳定 ID 替代长文本逐字相等

[`repair-loop.ts`](../../backend/src/agent-team/repair-loop.ts) 对 invariant 使用 `trim()` 后逐字比较。ATFR-006 的修复语义与目标一致，却因压缩表达与原多行文本不完全相同再次触发协议门禁。

Backend 应生成 `invariantId`、规范化 hash 或引用 Case 中的结构化 invariant；worker 回传身份和证据即可，不应被要求逐字复述完整合同文本。

### [P2] skip / blocked / not_reproduced 必须结构化

当前自由文本无法表达“ATFR-006 因 ATFR-005 首个失败而未执行”。建议至少引入：

- `blocked_by_case(caseId)`；
- `environment(blockerId)`；
- `not_applicable(reasonCode)`；
- `not_reproduced(challengeDispatchId)`。

当 blocker Case 变为 pass，调度器应自动恢复同一 verifier 的受影响 Case；behavior finding 被 code 挑战为 not_reproduced 时，应自动回到原 behavior verifier，而不是进入 Human Gate。

### [P2] 核心真实行为 smoke 应前置

code worker 的静态/脚本自检与 behavior acceptance 必须在状态中区分。建议第一轮 code self-check 后，先运行 ATFR-003/006 这类 in-scope 核心身份路径 smoke，再进入扩展结构 finding。目标是核心行为首次真实执行小于 60 分钟。

### [P3] Run 日志应成为结构化事件流

父 Run 的 49 条日志主要是无 timestamp 的字符串，复盘必须跨 outbox receipt 手工拼接时序。建议每条记录包含：

- `timestamp`；
- `eventType`；
- `transitionId`；
- `dispatchId`；
- `role`；
- `caseIds`；
- `reasonCode`。

这样 Human Gate latency、重复 completion 和修复轮次都可直接计算。

## 七、目标流程

未来的 Human Gate 应严格收敛为“需要人做价值判断”的场景：

- 是否扩张需求范围；
- P0/P1 finding 是否接受、延期或降级；
- 是否修改验收合同；
- 是否承担不可逆风险。

以下情况不应进入 Human Gate：

- 同 thread 暂时 busy；
- 已消费 dispatch 的重复 completion；
- blocker 已解除后的 Case 续跑；
- 可由稳定 ID 补全的协议字段；
- 测试 fixture 的正常回收。

目标指标：

| 指标                                   |  目标 |
| -------------------------------------- | ----: |
| 机械性 Human Gate                      |     0 |
| out_of_scope finding 的 repair attempt |     0 |
| thread busy correction Gate            |     0 |
| active role / dispatch 不一致 Gate     |     0 |
| 父 Run 完成时 owned live fixture Run   |     0 |
| 核心行为首次真实复现                   | < 60m |

## 八、保留的安全属性

优化不应破坏本次已经证明有价值的约束：

- split 前必须有 loader 可解析的可追溯测试案例；
- dispatch-id-v1 不回退 legacy dispatch；
- 不新开 thread 冒充原 worker 上下文；
- outbox 保持 pane-scoped 与不可变消费记录；
- 局部 repair 不重跑无关已通过 Case；
- 验收合同的修改仍需显式 refresh_acceptance。

因此，本次复盘的方向不是“放松门禁”，而是把门禁分层：机械恢复由状态机完成，系统故障由明确 retry/fail 处理，只有语义取舍才交给人。

## 九、复盘后的实施入口

完整优化不作为一个大改动一次提交，而是按依赖拆成四个可独立验收的纵向 PR：

1. Dispatch 原子性与同线程 correction 自动恢复；
2. Fixture 所有权、取消终态与父 Run 完成门禁；
3. Repair contract、scope 前置与结构化 verification 路由；
4. Critical-path 行为前置、结构化事件与 UI 状态分类。

执行级计划见 `docs/plans/2026-07-18-agent-team-control-plane-reliability-optimization.md`；配套可追溯验收合同见 `docs/testing/agent-team/agent-team-control-plane-reliability-optimization-test-cases.md`，继承 `ATFR` 前缀并覆盖 `ATFR-011～ATFR-025`。
