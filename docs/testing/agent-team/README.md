# Agent Team 测试计划索引

Agent Team 测试按稳定产品能力分类，不再按单次需求、历史缺陷或实现 PR 建文件。每条行为只有一个
权威 Case；专项验证脚本可以覆盖同一行为，但不再复制一份自然语言验收合同。

## 分类

| 分类       | 权威测试计划                                                      | Case | 范围                                                                    |
| ---------- | ----------------------------------------------------------------- | ---: | ----------------------------------------------------------------------- |
| 生命周期   | `lifecycle/agent-team-lifecycle.testplan.yaml`                    |    8 | 验收来源、Run/Terminal 身份、split、worker/provider、鉴权和 UI 动作权限 |
| 执行闭环   | `execution/agent-team-execution-and-repair.testplan.yaml`         |    9 | outbox、completion 幂等、flow、依赖、repair、checkpoint 和 Activity     |
| 恢复与资源 | `recovery/agent-team-recovery-and-fixtures.testplan.yaml`         |   11 | framework repair、rerun、watchdog、人工恢复、fixture cleanup 和历史兼容 |
| 完成与干预 | `completion/agent-team-completion-and-intervention.testplan.yaml` |   10 | completion outcome、人工 Case 裁决、历史投影和 refresh                  |

## 执行原则

- 新需求先归入以上四类；只有出现新的独立产品能力域时才新增分类。
- 同一不变量只在一个文件中成为 required Case；其他计划通过引用该 Case 避免复制。
- 浏览器步骤必须使用 `$toolkit:playwright-cli` 在真实 Dev Session surface 取证。
- Backend/协议行为使用当前 `agent-team:verify-*` 脚本、真实 API、Run JSON 和 pane-scoped outbox 取证。
- `typecheck`、`lint` 和静态代码阅读只是前置门禁，不能替代行为结果。

## 本次整理

- 原 `agent-team-core.testplan.yaml` 与 `agent-team-critical-regressions.testplan.yaml` 按能力拆入生命周期、执行和恢复分类。
- 原 `agent-team-completion-outcome.testplan.yaml` 迁移为完成与干预分类，删除文件名中的单次实现语义。
- 原 framework repair 与 control-plane 两份 Markdown Case 已删除；其中与当前代码一致的需求迁入 YAML，重复项合并。
- 删除与当前实现相反或尚未落地的 Case：App Server completion 不推进 loop、独立 `blocked` Run 状态、
  `repairContractId`、`scopeAssessment=ambiguous`、`critical-path` 前置调度，以及 behavior finding 的错误
  not_reproduced 路由。这些内容不能作为当前 required 验收合同。

## 主要合并与删除决策

| 原 Case                          | 当前归属           | 决策                                                                                                                  |
| -------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| AGT-001 + AGT-CR-001             | AGT-LC-001         | 合并为“split 前必须存在可追溯 required YAML”一个不变量                                                                |
| AGT-004 + AGT-005                | AGT-LC-004         | 合并 proposal 校验、tmux 能力和 worker 原子创建                                                                       |
| AGT-013 + AGT-CR-005             | AGT-LC-005         | 合并 provider/pane 身份与 launch 失败原子性                                                                           |
| AGT-006 + AGT-007 + ATFR-013/014 | AGT-EX-001/002     | 拆成 outbox 合法性与多来源幂等两个独立不变量                                                                          |
| AGT-009 + ATFR-016 的有效部分    | AGT-EX-005         | 统一真实复现、结构合同和 reviewer challenge 交接                                                                      |
| AGT-010 + ATFR-019               | AGT-EX-006         | 合并稳定 repair 身份与预算上限                                                                                        |
| ATFR-001/002/008                 | AGT-RC-001/006     | 合并 framework begin 幂等、旧 dispatch 失效与非法 resume                                                              |
| ATFR-004/005                     | AGT-RC-003         | 合并 continue 的不可用等价类与重试语义                                                                                |
| AGT-CR-003                       | AGT-RC-007         | 归入缺失 outbox 的 watchdog 恢复                                                                                      |
| ATFR-020/021/022                 | AGT-RC-009/010/011 | 拆为 fixture 归属、清理重试和历史兼容                                                                                 |
| ACO-001～010                     | AGT-CP-001～010    | 保留独立 completion/人工裁决不变量并统一分类前缀                                                                      |
| AGT-CR-002                       | 删除               | 当前 App Server completion 会进入统一 reconcile 链路，原 Case 与代码相反                                              |
| ATFR-011/012/015/023             | 删除               | 依赖未实现的自动 busy 等待、独立 blocked 状态、repairContractId 或 critical-path 调度                                 |
| ATFR-016/018/025 的不成立部分    | 删除               | 删除错误 behavior 路由、未实现 scopeAssessment 和不存在的 blocked UI；当前有效语义已并入 AGT-EX-005/007 与 AGT-LC-008 |
