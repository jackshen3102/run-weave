# Agent Team 控制面可靠性优化测试案例

## 来源与编号

- 复盘来源：`docs/review/2026-07-18-agent-team-framework-repair-run-retrospective.review.md`。
- 事实来源：`.runweave/agent-team/atr_a07db00d_20260717170123.json`。
- 该 Run 的可追溯 Case 使用 `ATFR` 前缀且已到 `ATFR-010`；当前项目树中原生成案例文件已不存在，因此本文件继承同一前缀，从 `ATFR-011` 连续编号，不另造领域前缀。

## 范围

验证 Agent Team 控制面在 worker completion、repair protocol correction、真实行为 fixture、finding 范围判断和 selective rerun 场景下满足以下目标：

- 机械性恢复不进入语义 Human Gate；
- active role、active dispatch、consumed receipt 和下一 dispatch 作为一个可恢复状态迁移处理；
- 协议补交只复用原 thread，thread 暂时 busy 时等待，不新开 thread；
- behavior verifier 创建的 fixture Run 有所有权、可审计终态和强制回收；
- repair 合同使用稳定身份，不依赖长文本逐字相等；
- scope、skip、dependency 和 not_reproduced challenge 可机读并自动路由；
- 标记为 `critical-path` 的核心真实行为在结构扩展审查前执行；
- UI 和事件流区分系统恢复、操作阻塞和人工语义裁决。

## 非目标

- 不放宽可追溯测试案例、pane-scoped outbox、dispatch-id-v1、review checkpoint 或真实复现门禁。
- 不允许为补交创建新 agent thread，不恢复 legacy dispatch fallback。
- 不由 Agent 自动决定 `out_of_scope`、`waived` 或验收合同修改。
- 不物理删除历史 Run JSON 或 outbox history；fixture cleanup 使用可审计的 `cancelled` 终态。
- 不新增单元测试文件；使用隔离 verify harness、真实 API、Run JSON、pane/outbox 和真实浏览器验收。

## 前提事实

- Run 真相位于 `.runweave/agent-team/<runId>.json`；pane 结果位于 `.runweave/outbox/<sessionId>.panel-<panelId>.json`。
- 当前 `AgentTeamRun.status` 没有 `blocked/cancelled`，`logs` 是无结构字符串；`activeWorkerRole` 和 `activeWorkerDispatch` 是两个可分别写入的字段。
- 当前 completion 先要求解析 active dispatch，之后才检查 consumed receipt；状态折叠可先持久化 active role + null dispatch，再建立下一 dispatch。
- 当前协议补交持久化 correction dispatch 后立即调用通用 prompt 投递；原 thread 为 `agent_running` 时会被判定不可复用。
- 当前 `fixVerifications.invariant` 与 repair cycle invariant 使用字符串逐字比较。
- 当前 `acceptanceResults.skipped` 只有自由文本 `skipReason`；`not_reproduced` 只对 code_review 来源建立自动 challenge。
- 当前 loader 已支持 Case `标签` 和 `依赖`，可用 `critical-path` 标签建立前置 smoke 集合。

## 必跑命令

按顺序执行，任一失败即停：

```bash
pnpm agent-team:verify-control-plane
pnpm agent-team:verify-review-checkpoints
pnpm agent-team:verify-fixture-lifecycle
pnpm work-history:verify
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/backend typecheck
pnpm --filter @runweave/frontend typecheck
pnpm --filter @runweave/cli typecheck
pnpm lint
git diff --check
```

静态门禁不能代替以下 Run/outbox/API/浏览器行为证据。涉及 Agent Team 面板状态时必须通过 `$toolkit:playwright-cli` 附着本次 Dev Session 的真实页面取证。

## 覆盖说明

- 状态迁移与幂等：ATFR-011～ATFR-014、ATFR-021、ATFR-022。
- 协议等价类与非法身份：ATFR-011、ATFR-012、ATFR-015。
- scope/repair 判定表：ATFR-018、ATFR-019。
- dependency、skip 与 source verifier 路由：ATFR-016、ATFR-017。
- fixture 所有权、异常和清理：ATFR-020、ATFR-021。
- 兼容与恢复：ATFR-012、ATFR-014、ATFR-022。
- 核心行为调度：ATFR-023。
- UI 与可取证性：ATFR-024、ATFR-025。
- 不覆盖通用 HTTP 鉴权：本改动不改变 Agent Team API 的认证边界；新增 payload 仍走现有 API 认证和严格 Zod 校验。
- 不覆盖跨进程强事务：目标是基于持久化 transition/receipt 的幂等恢复，不承诺文件系统与 tmux prompt 的分布式 exactly-once。

## 用例

### ATFR-011 原 worker thread 暂时 busy 时协议补交自动等待并只产生一次状态效果

前置条件：准备一个 dispatch-id-v1 Run；code worker 已写入缺少一个可补字段的 pane-scoped outbox并触发 completion；同一 pane 的原 thread 仍为 `agent_running`，threadId 和 provider 均保持不变。

步骤：触发 completion；观察 Run recovery/delivery 状态；让原 thread 转为 `agent_idle`；等待 correction prompt 投递并提交合法补交 outbox；重复发送原 completion signal。

期望：Run 在 thread busy 期间保持自动恢复状态，不进入 `need_human`，不创建新 thread；idle 后使用相同 threadId 投递同一 correction dispatch；合法补交只折叠一次，重复 signal 不增加 round、repair attempt 或下游 prompt。

失败判定：thread busy 立即进入 Human Gate；创建新 thread；同一补交产生两个状态迁移；补交期间允许修改源码边界；等待没有 deadline 或无法从 Run JSON 判断状态。

验证方式：隔离 Agent Team harness + panel thread 状态 + pane prompt/outbox + Run JSON transition 证据。

### ATFR-012 原 worker thread 身份丢失时 fail closed 且归类为操作阻塞

前置条件：准备与 ATFR-011 相同的 correction pending Run；在投递前让 pane 的 threadId 或 provider 与原记录不一致。

步骤：推进 correction delivery 到 deadline；读取 Run、结构化 blocker 和 Agent Team 面板；尝试重复 completion和 backend 重启恢复。

期望：系统不向新身份发送补交、不回退 legacy dispatch；Run 进入 `blocked` 而非语义 `need_human`，blocker owner 为 operator 且包含原/现 thread 身份、可执行恢复说明；重启不改变分类或重复发送。

失败判定：向错误 thread 投递；新开 thread；把身份丢失伪装成人工 scope 决策；Run 无错误码地停留 running；日志泄露 prompt 或敏感信息。

验证方式：隔离 panel mutation harness + Run JSON + `$toolkit:playwright-cli` 面板证据。

### ATFR-013 worker completion 到下一 dispatch 之间不出现 active role 与 dispatch 不一致

前置条件：Run 正在等待 code_review，review outbox 合法通过且下一角色应为 behavior_verify；同时订阅每次 Run store write。

步骤：触发 review completion；记录全部持久化快照；在状态折叠与下一 dispatch 建立的故障注入点分别重启 backend。

期望：每个持久化快照都满足“active role 与 active dispatch 同时存在且 role 一致”或“两者同时为空”；consumed receipt、acceptance fold 和下一 dispatch 由同一 transitionId 关联；重启后恢复到同一下一动作。

失败判定：出现 active role 非空而 active dispatch 为空；出现 dispatch role 与 active role 不同；重启后需要人工 intervention；重复派发 behavior_verify。

验证方式：Run store write recorder + 故障注入 harness + Run JSON 快照。

### ATFR-014 已消费 dispatch 的迟到或重复 completion 在 active dispatch 缺失时仍幂等忽略

前置条件：某 dispatch 已有 durable consumed receipt；构造 Run 正在终态化或下一 transition 尚未安装，active dispatch 为空；保留旧 outbox dispatchId。

步骤：分别从 terminal_event、app_server、startup、watchdog 重放旧 completion；读取 Run、prompt 计数和结构化事件。

期望：系统先按 outbox dispatchId 命中 consumed receipt，再决定为 duplicate/stale；四种来源均不进入 Human Gate，不改变 acceptance/round/repair attempt，不发送 prompt；事件包含 reasonCode=`dispatch_already_consumed`。

失败判定：先因 active dispatch 为空进入门禁；任何重放产生副作用；不同 signal 来源得到不同状态结果；回退 legacy dispatch。

验证方式：四来源 completion harness + Run JSON hash + prompt 计数。

### ATFR-015 语义相同的 repair 交接用稳定 contractId 校验而不比较长文本

前置条件：backend 为一个 repairKey 生成稳定 repairContractId；准备三份 code outbox：合法 contractId 但省略/改写展示 invariant、错误 contractId、属于旧 dispatch 的 contractId。

步骤：分别提交三份 outbox；观察 protocol correction、attempt 和下游 dispatch。

期望：合法 contractId 被接受且只增加一次 attempt；展示文本的换行、压缩或本地化不影响结果；错误和旧 contractId 均 fail closed 并触发一次可补交协议，不进入下游。

失败判定：继续要求 invariant 文本逐字相等；错误 contractId 被接受；合法语义因文本差异进入 Human Gate；worker 能自行生成未由 backend 下发的有效 contractId。

验证方式：outbox 判定表 harness + prompt snapshot + Run JSON。

### ATFR-016 behavior finding 的 not_reproduced challenge 自动回到原 behavior verifier

前置条件：behavior_verify 对 Case 返回真实 reproduction 并建立 runtime repair；code 使用相同 scenario 执行后提交 `not_reproduced` 和执行证据。

步骤：提交 code outbox；读取下一 dispatch 的 role、caseIds、scenarioId和 prompt；让 behavior verifier重跑原场景并分别返回 reproduced 与 not_reproduced 两个独立分支。

期望：下一 dispatch 自动回到 `behavior_verify`，只包含受影响 Case 和原 scenario；reproduced 分支重新 bounce code，not_reproduced 分支关闭/降级原 repair cycle并保留双方证据；不进入通用 Human Gate。

失败判定：固定回派 code_review；直接把 code 的 not_reproduced 当 pass；丢失原 verifier 场景；扩大到全量 Case；要求人工手工 dispatch。

验证方式：双分支 repair harness + pane prompt/outbox + Run JSON。

### ATFR-017 fail-fast 跳过的依赖 Case 在 blocker 解除后自动局部续跑

前置条件：ATFR-A 为当前失败 Case，ATFR-B/ATFR-C 结构化标记 `blocked_by_case: ATFR-A`，ATFR-D 已通过且不依赖 A；四个 Case 属于同一 behavior verifier。

步骤：修复并复验 A 为 pass；观察下一 behavior dispatch；完成 B/C；读取 D 的状态和证据。

期望：系统自动派发 B/C，不需要 intervention；D 不重跑且保留原 pass/evidence；结构化 skip 被清除，所有依赖解除后 Run 正常推进。

失败判定：仍进入“环境阻塞”Human Gate；全量重跑包含 D；只恢复直接依赖而遗漏传递依赖；自由文本变化导致路由不同。

验证方式：依赖图 harness + dispatch caseIds + Run JSON evidence diff。

### ATFR-018 out_of_scope 或 ambiguous finding 在首次 repair attempt 前请求人工裁决

前置条件：准备两个独立 final review finding，scopeAssessment 分别为 `out_of_scope` 和 `ambiguous`，均包含 scope sourceRefs、reproduction 和可追溯 Case 影响。

步骤：提交 review outbox；读取 pendingFindingDecision、repair cycle、code pane 和 UI；分别由用户裁决 out_of_scope 与 blocking。

期望：两种 finding 都在 code bounce 前进入语义 `need_human`，repair attempts 保持 0；out_of_scope 裁决关闭 finding且不修改事实；blocking 裁决后才建立 repair dispatch和预算。

失败判定：先消耗 repair attempt；Agent 自动代替用户裁决；finding 事实被删除；裁决后全量重跑无关 Case。

验证方式：finding disposition API + Run JSON + `$toolkit:playwright-cli` 范围裁决卡片。

### ATFR-019 明确 in_scope 的 blocking finding 仍遵守独立修复预算

前置条件：final review finding 的 scopeAssessment 为 `in_scope`，sourceRefs 有效、caseImpacts 可追溯，maxRepairAttempts=3。

步骤：完成三次合法 code handoff且独立 gate 三次仍返回同一 repairContractId 失败。

期望：不额外询问 scope；attempts 依次为 1/2/3；第 3 次后进入 pending finding risk disposition，原因与 scope decision 区分；不同 repairKey 不串预算。

失败判定：所有 P1 都提前要求人工导致自动修复失效；scopeAssessment 重置预算；第 4 次仍自动 bounce；把 exhausted 归类为协议错误。

验证方式：三轮 repair harness + Run JSON timeline + prompt 计数。

### ATFR-020 verification fixture 由父 Run 和 dispatch 完整持有并在结束前归零

前置条件：父 Run 的 behavior dispatch 通过隔离 Dev Session 在另一个project/dedicated Backend创建三个 `verification_fixture` Run，分别处于 running、need_human 和 done；自动shared Backend计划已提升为dedicated，显式shared请求被拒绝；每个 fixture 记录 ownerRunId、ownerDispatchId、ownerCaseIds、ownerDevSessionId、fixtureNamespace 和是否独占 terminal session；Dev Session manifest记录同一owner scope。

步骤：完成父 behavior outbox；停止owned Dev Session并取得candidate cleanup receipt；触发parent owner cleanup gate；读取父/子 Run、Dev Session manifest中的Run/terminal/pane/outbox resource ledger、实际terminal/pane资源和outbox history。

期望：running/need_human fixture进入`cancelled`，done fixture保持done；独占session/pane被回收，共享session不被销毁；历史Run JSON和outbox history保留；candidate receipt和parent receipt均报告owned live fixture=0，且所有owned Dev Session已stopped后父Run才能done。

失败判定：父 Run done 时仍有 owned live fixture；物理删除审计记录；销毁非 fixture 共享 session；把取消写成 pass/done；无 owner 的历史 Run 被误清理。

验证方式：真实 API + terminal resource inventory + Run/outbox history + `$toolkit:playwright-cli` Run 列表。

### ATFR-021 fixture cleanup 部分失败时父 Run 不伪造完成且可幂等重试

前置条件：父 Run 拥有两个 live fixture和一个owned Dev Session；让一个terminal session cleanup失败，另一个正常成功，或保留Dev Session为ready以模拟跨backend cleanup未闭环。

步骤：触发父 Run 完成；恢复失败资源后重试 cleanup；期间重启 backend并重复 completion。

期望：第一次父Run保持非终态并列出精确残留资源；PR 1的blocked状态已可用时进入`blocked`且owner=operator，否则暂时进入`need_human`并由结构化cleanup receipt标记为操作恢复；已清理fixture不回滚；恢复后重试只处理残留项，最终owned live fixture=0、owned Dev Session已stopped且父Run完成；所有取消操作幂等。

失败判定：部分失败仍标父 Run done；需要手改 JSON；重复清理误删共享资源；重启后丢失 cleanup 账本。

验证方式：cleanup 故障注入 + backend restart + 资源账本快照。

### ATFR-022 历史 Run 和旧 outbox 在新增状态字段后保持可读且不获得虚假所有权

前置条件：准备没有 runKind、lineage、blocker、recovery、events 和 repairContractId 的历史 Run/outbox fixture，以及一个当前 schema Run。

步骤：执行 list/get/export、startup reconciliation 和 UI 展示；对历史 active dispatch完成一次合法旧协议收尾，再建立新 dispatch。

期望：历史数据按 primary Run、无 owner、无 recovery 读取；旧 active dispatch只在其原边界内兼容完成，新 dispatch一律使用新 contract/delivery协议；UI 不崩溃且不把历史 Run 当 fixture清理。

失败判定：需要批量重写历史 JSON 才能启动；旧 Run 被自动取消；新 dispatch 回退旧协议；export 丢失原数据。

验证方式：历史 fixture + list/get/export API + startup harness + `$toolkit:playwright-cli`。

### ATFR-023 critical-path Case 在首次结构审查前完成真实行为 smoke

前置条件：code_first Run 包含两个带 `critical-path` 标签的 behavior Case、两个普通 Case和 review gate；初始 code worker 完成。

步骤：观察后续角色顺序；让一个 critical Case 在真实产品中失败并修复；再让两个 critical Case通过，继续完成 review和普通 behavior。

期望：首次 code 后先 dispatch behavior_verify且只含 critical Case；失败立即走同场景 repair；critical 全通过后才进入 code_review，随后执行剩余 behavior；没有 critical 标签的历史 Run仍保持原 code→review→behavior顺序。

失败判定：先进行多轮结构 review才首次运行 critical Case；普通 Case被提前全量执行；跳过 review gate；默认改变所有历史 Run顺序。

验证方式：角色/Case dispatch timeline + 真实产品 Playwright evidence + 无标签兼容分支。

### ATFR-024 结构化事件可以单独还原 dispatch、Gate 和恢复时序

前置条件：准备一个经历正常 dispatch、一次自动 protocol recovery、一次 operator blocked恢复和一次 scope Human Gate的 Run。

步骤：仅读取 Run events/API export，不读取自由文本 logs和 pane scrollback；重建事件时序并与真实 transition对照。

期望：每条事件都有 at、eventType、transitionId、dispatchId/role/caseIds（适用时）和 reasonCode；可以计算各状态停留时间；自由文本 logs继续为历史兼容展示，但不再是机器统计依据。

失败判定：仍需解析中文字符串；事件缺时间或身份；同一 transition重复记录；事件包含 prompt、token或敏感字段。

验证方式：event projection脚本 + API export + schema检查。

### ATFR-025 UI 明确区分自动恢复、操作阻塞和人工语义裁决

前置条件：三个独立 Run 分别处于自动 correction recovery、thread身份丢失 blocked、pendingFindingDecision need_human。

步骤：使用 `$toolkit:playwright-cli` 打开真实 Agent Team 面板，依次选择三个 Run并检查状态标签、原因、允许动作和通知。

期望：自动恢复显示“正在恢复”且不发送 Human Gate通知；blocked显示“需要恢复现场”及最小操作，不显示 scope disposition；need_human显示“需要范围裁决”并只提供合法 disposition；三者不会共用模糊“需要人工介入”文案。

失败判定：三种状态都显示 Human Gate；自动恢复可被误点完成；blocked提供越权裁决；need_human被系统自动越过；Run选择被 fixture残留污染。

验证方式：`$toolkit:playwright-cli` 真实浏览器 DOM、交互和截图证据。

## 验收通过标准

- ATFR-011～ATFR-025 全部通过并保留每条指定证据。
- 机械性 `need_human` 为 0；scope/acceptance/risk 之外的阻塞有独立状态和 owner。
- 任一持久化 Run 快照不出现 active role / active dispatch 身份不一致。
- correction 暂时 busy 自动恢复；身份变化仍 fail closed且不新开 thread。
- 父 Run 完成时 `ownedLiveFixtureRuns=0`，历史证据没有被删除。
- out_of_scope/ambiguous finding 在 repair attempts=0 时请求裁决；in_scope finding继续遵守预算。
- critical-path Case 首次真实行为执行目标小于 Run 启动后 60 分钟。
- 未新增单元测试文件；静态门禁、隔离 harness和真实浏览器行为证据全部通过。
