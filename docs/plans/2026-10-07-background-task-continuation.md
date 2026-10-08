# 后台任务保留进度并自动继续

状态：第一阶段已实现并验收核心闭环；第二阶段待实施。适用于周期定时任务及快捷指令后台运行；不改变普通终端任务监控的职责。

## 目标与结论

用户希望后台任务在已有授权内持续完成，遇到临时故障后无需打开终端发送“继续”。推荐在现有 ScheduledRun 内增加有界续接：保留 runId、原 Codex thread、执行目录和权限快照，每轮结果单独留档，由 Backend 安排下一轮。底层仍可能重新执行失败的 push 等步骤，但不会从头重做整个任务。

第一阶段实现覆盖后台自动续接、轮次记录、停止与接管互斥及 Web/iOS 入口。正式实例与历史任务未改动。

## 实际记录

只读查询本机 Stable 配置指向的 scheduled-tasks SQLite：`scheduledFor >= 2026-10-01T00:00:00Z`，本次查询共 53 条，数据库结果为 44 succeeded、8 blocked、1 provider_timeout。该计数是后台首轮运行记录，不等于用户后续处理后的最终任务结果。

| 运行 ID 前缀 | 任务与原因                                                                          | 推荐处理                                                       |
| ------------ | ----------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 77c41c04     | github-pr：两次 GitHub Internal Server Error，已有提交 01028ce7，认证及仓库检查通过 | 延迟恢复原 thread，核对远端后继续 push、PR、CI 与合并          |
| 0a351d2d     | github-pr：多组改动，Agent 要求明确范围                                             | 先核对原授权；确实缺范围时等待用户回答，不由自动“继续”扩大范围 |
| b748dfee     | github-pr：多组改动，Agent 要求明确范围                                             | 同上；原对话后续实际得到用户“所有代码”的补充                   |
| d759f4d7     | github-pr：检查时发生外部写入，交付范围不确定                                       | 不能仅靠等待几分钟恢复；须确认写入结束及改动归属               |
| e1c047ce     | 文档维护：main 所在 worktree 被使用，无法满足先快进 main 的技能前置                 | 有可验证释放条件时等待；不得切换或清理别人使用的目录           |
| f488bd5c     | daily-refactor：main 落后且 worktree 被进程占用                                     | 同上；优化 main 前置规则属于另一个改动                         |
| ab15141b     | github-pr：PR #665 已合并，来源存在并发改动，收尾未完成                             | 保存已合并事实，仅恢复尚未完成的安全收尾                       |
| 2677d5c3     | github-pr：PR #663 已合并，来源仍有终端使用                                         | 等待可证明的释放条件；不重复创建或合并 PR                      |
| fe2cd5d2     | daily-refactor：provider_timeout，无有效最终结果                                    | 先核对执行者与副作用；第一版不自动续接未知结果或重置执行预算   |

原始对话提供了直接证据（北京时间）：

- 截图对应的 `77c41c04`：23:15:33 返回 blocked；23:22:55 用户输入“继续”；23:26:11 同一 thread 返回 succeeded，报告 PR #728 已合并。SQLite 仍保存首轮 blocked。
- `0a351d2d`：11:22:34 返回范围受阻；11:38:58 用户输入“继续”；11:46:22 同一 thread 报告 PR #715 成功。此例说明前后范围判断可能不一致，不能据此把机器人输入等同于用户授权。
- `b748dfee`：用户补充“所有代码”后，同一 thread 报告 PR #684 成功。这里包含真实的新输入，不能归为临时环境故障。

上述 PR 状态是原对话中的完成报告，本轮没有重新查询 GitHub。相关本机 rollout：

- `rollout-2026-10-07T23-12-56-01a116ec-c036-79d0-95a2-90941a9de70e.jsonl`
- `rollout-2026-10-07T11-20-40-01a11460-a365-7df0-80ed-1236397c0cd2.jsonl`
- `rollout-2026-10-05T00-04-03-01a107a8-7667-79e2-a553-e1056c3ebb7f.jsonl`

## 代码现状与缺口

1. `backend/src/scheduled-tasks/providers/result.ts` 只有 succeeded、blocked、failed；提示词把权限、网络、认证及缺输入统一归为 blocked，没有下一步与恢复条件。
2. `backend/src/scheduled-tasks/runtime.ts` 在 provider 一轮结束后直接写 completed/failed 和 finishedAt。失败即释放后台所有权，没有延迟续接调度。
3. `backend/src/scheduled-tasks/providers/types.ts` 没有恢复 thread 的请求参数；`providers/codex.ts` 总是启动全新的 `codex exec`。
4. `terminal-attachment.ts` 已能使用保存的 thread 在普通终端恢复，校验目录、模型和会话身份；这是可复用的身份保障，但后台续接能力仍缺失。
5. 当前 open-terminal 是结束后的自由对话入口，没有将其后续轮次纳入原后台任务。因此任务已完成而历史首轮仍受阻，是现有运行记录语义的局限，不能直接监听任何 final 覆盖旧结果。
6. `storage/database.ts` 的 waiting 已用于旧 owner 尚存活；恢复扫描会处理所有 waiting。加入延迟等待时必须区分原因，否则重启会将正常等待误判为 interrupted。
7. `backend/src/device-monitor/scheduled-task-alerts.ts` 按 runId 和订阅去重通知；若同一 run 后来完成，只改状态无法保证成功通知再次发出。
8. 普通终端监督已有 completed/blocked/continue 分类及有界问询，但依赖终端身份，blocked 不继续。它不是后台执行器，也不能直接套用为后台循环。

本机 `codex exec resume --help` 显示支持指定 session、stdin、JSON 输出和 output-schema。第一步仍需在隔离项目验证实际恢复语义、父级权限参数及模型覆盖；帮助信息不是执行成功证据。

## 用户可见行为

- 新运行提供“自动继续”开关，建议新任务和新快捷运行默认开启；旧配置缺省关闭，历史运行不自动复活。每次运行冻结选择。
- 已有授权内还有下一步时显示“继续处理中”；临时服务故障显示“等待恢复，预计 5 分钟后继续，已继续 1/3 次”，并保留最近原因。
- 等待期间提供“立即继续”“停止自动继续”“接管到终端”。立即继续仍是原 run、原 thread；“重新运行”明确创建新任务执行，两者分开。
- 真正需要输入时显示具体问题，可在详情直接回答并继续；权限拒绝需用户解决权限问题，文本回答不改变执行权限。
- 每轮保留开始、结束、原因、完成项、剩余项与输出；主记录展示当前进展及最终结果，原受阻报告仍在时间线可查。
- 中间等待不发“失败”通知；完成、需要用户输入或恢复额度耗尽时才通知。电脑休眠或 Backend 离线时等待恢复在线，UI 不承诺离线执行。

## 恢复规则

| 决策        | 条件                                                                        | 行为                                                     |
| ----------- | --------------------------------------------------------------------------- | -------------------------------------------------------- |
| continue    | 原授权内存在具体下一步，无必须由用户解除的阻塞                              | 原 thread 继续；同一停止原因重复出现则进入等待或人工处理 |
| wait        | 有证据的临时错误或明确外部条件，例如服务 5xx、带恢复时间的限流、CI 尚未完成 | 持久化 nextAt，释放执行槽，到期核对状态后再推进          |
| needs-input | 真实缺少范围、输入、认证或授权                                              | 展示所缺信息；不自动回答用户问题、不反复申请被拒权限     |
| stop        | 已取消、额度耗尽、不可恢复身份、未知执行结果                                | 留存原因与现场；不自动启动另一条 thread 冒充恢复         |

分类由本轮 Agent 输出结构化建议；Backend 校验策略、额度、所有权、身份及结果完整性。第一版不另启独立分类 Agent，不通过 reason 文本包含“超时”之类关键词直接恢复。缺少结构化建议按人工处理。

建议默认最多 3 次自动续接。无明确外部时间时依次等待 1、5、15 分钟；有明确恢复时间时不得早于该时间。第一轮进入自动恢复后最长保留 60 分钟；立即推进也消耗额度，不能用新错误文案重置额度。到期尚未取得执行槽则结束自动恢复并说明排队超期。

总执行时长和输出继续使用原运行预算，按各轮实际执行累计，等待时间不计执行时长；续接不会把原超时预算重新充值。明确的 provider_timeout、输出上限、结果损坏及崩溃后的未知写入，第一版进入人工处理。

续接提示词必须包括：继续原任务；核对已完成成果与外部事实；仅完成剩余义务；沿用原授权和执行策略；自动消息不构成范围确认或审批。PR 写操作超时后先查询分支、head、PR 和合并状态；thread 相同不等于写操作天然幂等。

## 合同、存储和所有权

采用原 run 聚合多轮 attempt；attempt 保存不可变的每轮结果。公共合同进入 `packages/shared/src/scheduled-tasks/`，Swift DTO 同步。

- 配置增加 `continuationPolicy: { mode: "off" | "bounded" }`；首次上线额度使用上述统一值，不开放任意无限次数。共享配置登记快捷运行默认值；最终策略、额度和窗口进入 run 快照。
- provider 新结果协议增加结构化 recovery：action、阻塞类别、可读证据、剩余工作、最早恢复时间、所需用户输入；成功时 recovery 为 null。旧记录保留兼容，旧结果不能被猜测为可恢复。
- run 增加 revision、resultRevision，以及 continuation（phase、count、nextAt、deadline、lastAttemptId、stopReason）。waiting 必须携带明确原因，区别自动延迟、用户输入和 owner_unresolved。
- 新增 attempt 存储：runId、attemptId、序号、原 thread、执行者身份、开始结束时间、输入来源、输出游标范围、结果。领取、扣额度、设置所有权在 SQLite 同一事务完成。
- provider 请求支持显式 resumeThreadId；禁止 `--last`。校验同一 cwd、模型、权限快照和实际返回的 thread ID。thread 不一致时停止并报告，不能覆盖原 threadRef。
- 新增 `POST /api/scheduled-tasks/runs/:runId/continue`，输入 expectedRevision 及可选的真实用户 answer，要求 Idempotency-Key；202 返回同一运行。已经由终端接管、活跃 provider、失效目录或无可恢复 thread 返回明确 409。
- continue 不修改原始 prompt/权限快照；answer 作为追加的真实用户输入存档。任务配置修订不影响进行中的 run。人工“继续”不重置自动额度；需要新增自动额度时明确展示并由用户选择。
- 现有 stop 覆盖 queued、running 及自动 waiting；停止是持久化状态变更，取消 nextAt，且与领取续接串行。归档只允许无执行者、无待续接的结束记录。
- open-terminal 与后台领取共用持久化所有权仲裁。用户接管必须先取消待续接并确认 provider 退出；已有终端绑定的历史 run 第一版不自动拉回后台。两个 Backend/重复点击也不能获得两个 owner。
- 后台每轮完整退出并落盘后才能安排下一轮。重启只恢复明确持久化为“待执行”的续接；已领取但启动/投递不确定的 attempt 先核对原执行证据，不能确认就停在 interrupted/owner_unresolved，不盲目重放。
- 同一任务有等待续接时仍算未结束，下一周期按现有 busy 规则跳过；等待不占全局 provider 并发槽。快捷取得原活跃 run，不创建重复执行。
- 所有读取和变更沿用现有 Backend 认证、连接 scope、项目上下文校验；模型建议和错误文本不拥有改变策略的权限。

通知按 runId、resultRevision 和订阅生成唯一事件，网关 eventId 同步带 revision；旧格式事件兼容。不对每次自动等待发终态通知。

## 分两步交付

### 第一步：后台自动继续闭环（已实现，2026-10-08）

覆盖结构化 continue/wait、持久化 attempt、同 thread 恢复、停止和接管互斥、Web/iOS 展示及最终结果通知。新执行在后台完成时更新同一 run；权限、输入和未知执行结果保留人工出口。这一步解决截图场景，不需要用户先打开终端。

### 第二步：减少必须进入终端的人工处理（待实施）

在运行详情回复缺失信息并恢复原任务。若要把终端中的继续结果也计入任务，增加显式“接管并继续此任务”的 operation：绑定 runId、thread、任务版本及指定轮次，只采纳该 operation 的有效业务结果。原“打开历史对话”保留自由追问语义，后续无关 final 不得改写任务状态。既有历史受阻记录不根据全文最后一句自动改成成功。

同时优化 github-pr 快捷指令的范围表达：允许用户保存“提交本次指定改动”或“提交当前全部改动”等明确模板；不能把本轮优化请求当作授权所有历史任务提交全部改动。

## 实施文件范围

| 文件或目录                                                                                                                                       | 职责                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `packages/shared/src/scheduled-tasks/types.ts`、`api.ts`                                                                                         | 策略、恢复信息、attempt/API 和 capability 合同                                   |
| `packages/shared/src/configuration/fields.ts`                                                                                                    | 快捷运行默认策略登记                                                             |
| `backend/src/scheduled-tasks/providers/{types,result,codex,codex-options,capabilities}.ts`                                                       | 恢复请求、结构化结果、真实 resume 能力探测                                       |
| `backend/src/scheduled-tasks/{runtime,service,run-record,quick-input-run,terminal-attachment}.ts`                                                | 调度、用户输入、所有权交接；新增 continuation 模块承载策略，避免继续扩大 runtime |
| `backend/src/scheduled-tasks/storage/`                                                                                                           | 新增不可变迁移、attempt 表、版本条件更新、等待与重启恢复                         |
| `backend/src/routes/scheduled-tasks.ts`                                                                                                          | continue 请求校验、幂等键及 HTTP 错误映射                                        |
| `backend/src/device-monitor/scheduled-task-alerts.ts`                                                                                            | 聚合结果通知及版本去重                                                           |
| `frontend/src/services/scheduled-tasks.ts`、`frontend/src/features/scheduled-tasks/`                                                             | API、策略设置、时间线、继续/停止/接管，及完成提醒去重                            |
| `packages/app-ios/Sources/RunweaveIOS/Contracts/ScheduledTasks.swift`、`Services/ScheduledTasksService.swift`、`State/ScheduledTasksModel.swift` | Swift 合同、API 与状态同步                                                       |
| `packages/app-ios/Sources/RunweaveIOS/Features/ScheduledTasks/`、`Features/Terminal/QuickCommandRunViews.swift`                                  | 定时任务与截图详情入口的同步体验                                                 |
| `frontend/docs/scheduled-tasks.md`                                                                                                               | 实现完成后更新当前运行、恢复及兼容合同                                           |

第二步的终端 operation 需沿现有终端任务控制与完成事件链路接入，不能让定时任务反向依赖 HTTP route 或另建终端输入通道。

## 兼容、回滚与风险

- 旧任务缺省 off，旧运行缺省无 continuation；不批量唤醒历史 failed。capability 不支持时隐藏自动继续入口，禁止 silently 降级成新建 thread。
- 增量迁移不可修改 001/002；先部署可读取新字段的 Backend，再开启策略。回滚先关闭新续接领取，等待执行者退出并持久化暂停，保留 attempt 表和输出；旧二进制若不能识别新 waiting 语义，不直接回退运行。
- 最大风险是同 thread 并发写入、重复外部操作及自动消息被误当成授权。必须先通过所有权、幂等和权限验收再默认开启。
- 本轮不实现跨电脑调度、独立常驻执行进程、Agent Team、自动提权、抢占目录或自动修改技能规则。Backend 离线及长时间服务故障仍有明确边界。

## 验收与验证

新增 [续接验收合同](../testing/scheduled-tasks/continuation.testplan.yaml)，涵盖实际恢复、策略、额度、互斥、重启、权限、状态回写及两端入口。第一阶段已实施；人工回答及终端 operation 归因仍待第二阶段。不能将第一阶段的局部验收视为整份合同通过。

复用 [既有运行验收](../testing/scheduled-tasks/runtime.testplan.yaml) 的 SRT-003/005/007/009/013/014/015/016，及 [快捷运行验收](../testing/background-commands/core.testplan.yaml) 的 BGC-003/006/007/010/011/012，防止恢复与调度回归。

实现后运行 shared/backend/frontend typecheck、相关 lint、`pnpm architecture:check`、`pnpm scheduled-tasks:verify-runtime`、`pnpm backend:verify-lifecycle`。集成覆盖扩展现有 scripts/verify，不新增单元测试。Web 使用隔离 Dev Session 和 toolkit:playwright-cli；iOS 使用 toolkit:agent-device，源码构建与真实交互分别报告。截图中的服务故障以受控隔离服务返回失败再恢复复现，不对真实仓库重复 push 造故障。

本轮文档检查命令：`pnpm testplan:validate docs/testing/scheduled-tasks/continuation.testplan.yaml`、`pnpm docs:check`、`git diff --check`。格式检查不代表产品能力已实现。
