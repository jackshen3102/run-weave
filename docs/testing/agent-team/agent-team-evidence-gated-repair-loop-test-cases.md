# Agent Team 证据门禁修复闭环测试案例

## 范围

验证 Agent Team 在 code_review / behavior_verify 失败回弹后，Code Agent 必须先完成可审计的复现与同场景回归交接，backend 才允许继续派发；验证同一修复目标 3 次仍失败时自动进入人工处理。

不覆盖首次 code 实现质量、测试案例本身是否充分、agent provider 模型能力、UI 配置和全量业务验收。verifier 是否执行完整测试集不属于本改动；仍保留任一必跑 case 失败即停和 selective rerun。

## 前提事实

- 长期边界：`docs/architecture/multi-agent-orchestrator.md` 中的修复交接与预算规则。
- run 真相：`.runweave/agent-team/<runId>.json`。
- worker 结果：pane-scoped `.runweave/outbox/<sessionId>.panel-<panelId>.json`。
- 串行路径：`code -> code_review -> behavior_verify`；只有 bounced code completion 需要 `fixVerifications`。
- behavior repairKey 由 caseId 生成；review repairKey 由 blocking finding 的 invariantKey 生成。
- `noProgressCount` 是全局 liveness 兜底，`recheckAttempt` 是 verifier outbox timeout，`repairCycle.attempts` 才是 Code Agent 修复次数。
- 本仓库不新增单元测试文件；状态机和协议通过现有 Agent Team verify script、隔离临时 repo/run、pane-scoped outbox 和 run JSON 取证。

## 必跑命令

按顺序执行，任一失败即停：

```bash
pnpm agent-team:verify-review-checkpoints
pnpm typecheck
pnpm lint
git diff --check
```

静态门禁不能替代以下 run/outbox 行为证据。

## 覆盖说明

- 主路径：AGT-RP-001、AGT-RP-002、AGT-RP-004。
- 等价类与边界：AGT-RP-003、AGT-RP-005、AGT-RP-006、AGT-RP-007。
- 状态迁移：AGT-RP-002、AGT-RP-006、AGT-RP-008、AGT-RP-010。
- 时序、幂等与恢复：AGT-RP-009、AGT-RP-010。
- 并发/多失败项：AGT-RP-008。
- 协议兼容：AGT-RP-011。
- 回归：AGT-RP-005、AGT-RP-012。
- 不覆盖鉴权与权限：本改动不新增 endpoint，仅扩展现有 create-run options 和 pane outbox 协议。
- 不覆盖浏览器 UI：本改动没有 UI 行为，不需要 `$toolkit:playwright-cli`；runtime reproduction evidence 的真实性由实际目标 case 的既有验收方式负责。

## 用例

### AGT-RP-001 behavior 失败必须提供真实 Before/After 才能进入 review

前置条件：隔离 Agent Team run 已由 behavior_verify 对 `CASE-RUNTIME-001` 返回 fail；backend 已生成 `behavior_verify:CASE-RUNTIME-001` 并回弹 code。

操作：读取 bounce prompt；Code Agent 按 prompt 记录真实产品入口、scenarioId、validationSessionId 和 Before evidence，完成最小修复后以相同 scenario 写入 After evidence 与 `verification=pass`，再写 completed outbox。

预期：Codex prompt 显式要求 `$toolkit:reproduce-before-fix`；provider-neutral 合约要求 `real_product + reproduced`。backend 接受与当前 repairKey 匹配的交接，attempts 从 0 变 1，并只派发一次 code_review。

失败判断：prompt 只要求改代码；harness/mock 被当成 runtime 复现；缺 Before/After 仍派发 review；attempt 未增加或重复增加；Code Agent 自写 acceptance pass 推进 run。

验证方式：隔离 run + pane prompt/outbox + run JSON + verify script。

### AGT-RP-002 缺失或阻塞的修复交接不能推进下游门禁

前置条件：准备三个独立 bounced run，分别让 code outbox 缺少 `fixVerifications`、写 `reproduction=blocked`、写 `verification=fail`。

操作：对每个 run 发出 code completion；缺 schema 场景按 backend 的一次补交 prompt 再提交一次无效 outbox。

预期：三种情况均不派发 code_review、不增加 repair attempts、不改变 checkpoint；缺 schema 只允许一次补交，第二次无效后进入 `need_human`；blocked/fail 直接带证据进入 `need_human`。

失败判断：任何无效交接进入 review；补交期间允许继续改源码；阻塞被记为未复现或消耗一次修复预算；run 无原因停住。

验证方式：verify script + run JSON/log + pane outbox freshness。

### AGT-RP-003 structural review finding 不被强制伪造真实产品复现

前置条件：code_review 返回一个 P1 finding，`invariantKey=checkpoint.index-ownership`、`verificationMode=structural`，evidence 提供可执行的原 Git harness。

操作：backend 回弹 code；Code Agent 原样执行 reviewer harness，写 `reproduction.mode=review_harness`、`status=confirmed`，修复后复跑同一 harness 并写 pass evidence。

预期：bounce prompt 不要求把纯 Git 契约包装成真实 UI/runtime 场景；backend 接受原 harness 的 Before/After，随后派发 review。

失败判断：必须启动无关 Dev Session 才能交接；只阅读代码、不跑已提供 harness 也能通过；mock harness 被用于 runtime finding。

验证方式：临时 Git repo + 原 harness 输出 + outbox/run JSON。

### AGT-RP-004 最小受影响矩阵与 fail-fast 同时成立

前置条件：behavior failure 的 invariant 只影响正向、时序和一个回归路径，并发维度不适用；准备一个时序检查失败的 code handoff。

操作：Code Agent 依次执行原复现场景和受影响检查；时序检查失败后停止，不执行后续回归项，并在 impactedChecks 中记录 pass/fail/skipped 原因。

预期：backend 拒绝 `verification=pass`，不要求为了“矩阵完整”继续跑不适用或失败后的检查；下一次 gate 仍只收到失败、未执行、依赖和 diff 影响范围，不被扩大为全量。

失败判断：失败后仍强制跑完整套件消耗资源；空 impactedChecks 被接受；不适用维度必须伪造用例；selective rerun 被改为全量默认。

验证方式：verify script 中记录命令顺序与 dispatch caseIds。

### AGT-RP-005 任意 diff 不能重置同一修复目标的三次预算

前置条件：create-run 未显式配置预算，behavior case `CASE-STUCK-001` 已建立 repair cycle；每轮 Code Agent 都产生不同 diff，交接证据结构有效，但独立 gate 仍返回同一 case fail。

操作：完成三次 `code handoff -> gate fail`；第三次失败后观察 run 状态。每轮同时传入或记录 `hadDiff=true`。

预期：三次合格 handoff 依次记录 attempts=1/2/3；第 3 次修复后的同 case 失败不再产生第 4 个 bounce，run 进入 `need_human`。`noProgressCount` 是否清零不影响 repair budget。

失败判断：diff 将 attempts 清零；第 3 次之后仍派发 code；第 2 次即提前中断；把 verifier 的两次稳定失败误算成两次 code 修复。

验证方式：verify script + run JSON 时间线 + prompt 计数。

### AGT-RP-006 自定义预算只接受 1～5 且在 run 创建时固定

前置条件：准备 create-run API 输入 `maxRepairAttempts` 为 0、1、5、6，以及未提供四种/五种等价类。

操作：分别创建 run；对成功 run 制造持续相同 repairKey 的失败链。

预期：0 和 6 返回 400 且无 run 副作用；1、5 分别在对应次数后的再次失败进入人工；未提供时固定为 3。运行中不能由 worker outbox 覆盖预算。

失败判断：范围外被接受；默认值不是 3；Code Agent 或 reviewer 能修改 maxAttempts；重启后预算漂移。

验证方式：真实 API + run JSON + verify script。

### AGT-RP-007 review 通用 caseId 下按 invariantKey 隔离计数

前置条件：所有 review 结果仍使用通用 `case_14`。先返回标题不断变化但 `invariantKey=readiness.event-boundary` 的 P1；随后返回 `invariantKey=checkpoint.git-ownership` 的另一 P1。

操作：让第一个 invariant 经历两次合格 code handoff 后仍 fail，再让第二个 invariant 首次 fail；读取 active repair cycles 和 prompts。

预期：readiness cycle attempts=2；Git ownership 建立 attempts=0 的独立 cycle。标题/summary/ref 变化不重置 readiness 预算，通用 case_14 也不把两个 invariant 合并。

失败判断：只按 case_14 导致第二个 finding 继承次数；只按文本 fingerprint 导致 readiness 每轮归零；Code Agent 可改 repairKey。

验证方式：合成 review outbox + verify script + run JSON。

### AGT-RP-008 多个阻断 finding 必须逐项交接且并行计数不串扰

前置条件：一个 review outbox 同时包含两个 P1，分别对应两个 invariantKey；backend 一次 bounce 发送两个 repairKey。

操作：Code Agent 第一次只提交其中一项 fixVerification；补交后提交两项有效交接；下一轮 reviewer 让一项 pass、一项 fail。

预期：缺一项时不派发 review；完整后只派发一次 review并分别增加次数；pass 项关闭 cycle，fail 项保留自身次数并再次 bounce。

失败判断：部分交接推进；同一次 completion 重复计数；一个 finding 的 pass 清空另一个；重复派发多个 code_review。

验证方式：verify script + outbox/run JSON + dispatch 日志。

### AGT-RP-009 第 2 次修复缺少机制重评时不能继续

前置条件：同一 repairKey 已有 attempts=1，独立 gate 再次 fail。

操作：观察第二次 bounce prompt；Code Agent 提交 reproduction/verification 均合格但 `strategyAssessment` 为空的 outbox，再补交包含上一轮失败机制和状态所有权/事件边界/数据模型判断的 outbox。

预期：第二次 prompt 明确要求机制重评；第一次交接不推进且不增加次数；补交有效后 attempts=2 并派发 review。

失败判断：第二轮仍可只写“已修复”；backend 通过函数名/分支数量猜测策略；补交导致重复修改或重复计数。

验证方式：prompt snapshot + outbox normalizer + verify script。

### AGT-RP-010 backend 重启与重复 completion 不重复消耗预算

前置条件：一个有效 code outbox 已落盘，backend 在写入 attempts=1 或派发 code_review 的故障窗口重启；保存 active dispatch/outbox mtime。

操作：启动 reconciliation，并重复发送同一 completion signal；读取 run、prompt 次数和 repair cycle。

预期：通过 freshness/active dispatch 幂等恢复；attempts 最终只为 1，code_review 只收到一次 prompt，旧 completion 不创建新 cycle。

失败判断：重启后 attempts=0 或 2；重复派发；旧 outbox 被当成下一轮 fixVerification；run 永久停住。

验证方式：隔离 backend 重启 + run/outbox 快照 + prompt 计数。

### AGT-RP-011 历史 outbox 可读但新 P0/P1 缺稳定键不能进入修复循环

前置条件：准备一个没有新字段的历史 completed outbox用于 export/recovery；另准备当前 dispatch 的 review outbox，含 P1 但缺 invariantKey/verificationMode。

操作：读取/导出历史 run；处理当前 review completion；让 reviewer 在一次结构补交后仍缺字段。

预期：历史 outbox 正常归一化和导出；当前 review 不 bounce code，先补交一次，随后进入 `need_human`；不回退为 `case_14` 计数。

失败判断：历史数据无法读取；当前 finding 被静默丢弃或无限回弹；自动生成不稳定 key 并宣称可靠。

验证方式：旧 fixture + 当前 pane outbox + verify script。

### AGT-RP-012 verifier timeout、全局 liveness 与修复次数保持独立

前置条件：三个独立 run 分别触发 verifier outbox timeout、`hadDiff=false` 且无结果的全局无进展、同一 repairKey 的 gate 复验失败。

操作：推进各自状态到对应阈值，读取 `recheckAttempt`、`noProgressCount`、`repairCycle.attempts` 和 escalation reason。

预期：三个计数器只因各自事件变化；日志和人工原因明确区分“worker 未产出”“全局无活动”“3 次合格修复后仍失败”。

失败判断：timeout 增加 repair attempts；任意 diff 清空 repair budget；同 case gate fail 被记录成 worker timeout；人工信息无法判断触发源。

验证方式：verify script + run JSON/log 判定表。

## 验收通过标准

- AGT-RP-001～012 全部通过，并能从 run JSON、pane prompt/outbox 或脚本输出回查证据。
- 所有 invalid/blocked 交接都 fail closed，未创建 checkpoint、未派发下游 gate、未伪造 acceptance pass。
- 默认 3 次预算、invariantKey 隔离、幂等恢复和计数器职责均符合文档。
- fail-fast/selective rerun 保持原行为，没有引入“每轮必须全量执行”的 token 回归。
- 未新增单元测试文件；静态门禁与行为验证均通过。
