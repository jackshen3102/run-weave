# Agent Team 跨层编排测试案例

本文档是 `docs/architecture/multi-agent-orchestrator.md` 的跨层验收合同，验证主 Agent、三类 worker、backend 状态机、tmux pane、completion hook、pane-scoped outbox 与 UI/API 能形成同一条可追溯闭环。专题内部算法仍以 `docs/testing/agent-team/` 下既有用例为唯一细粒度定义；本文只定义跨模块组合后才可观察的行为，避免复制已有专题步骤。

## 范围

覆盖：

- 缺少测试案例时从 `intake` 生成项目内 Markdown，并以 `generatedTestCaseFilePath` 作为 split 硬门禁。
- `code`、`code_review`、`behavior_verify` 三类 worker 的 pane 拆分、串行门禁和结构化回传。
- terminal completion feed、pane-scoped outbox、run JSON 与 UI/API 的身份一致性。
- 行为失败后的选择性复验、修复交接、修复预算、无进展熔断与人工恢复。
- 可选本地 review checkpoint 的提交边界和 fail-closed 规则。
- backend 重启恢复、并发 run 隔离、接口鉴权、项目文件边界和 pty 降级边界。

不覆盖：

- 不重复验证 Markdown parser 的全部语法变体；格式等价类和字段映射由 `agent-team-verification-case-source-test-cases.md` 负责。
- 不重复穷举 review checkpoint 的 Git plumbing；结构化 harness 由 `agent-team-review-checkpoint-test-cases.md` 负责。
- 不验证 worker 内部私有函数调用次数；只验证 run、pane、outbox、终端输出、API 和 UI 可观察状态。
- 不新增单元测试文件；本仓库按真实 Runweave 环境、现有 verify harness 和 `$toolkit:playwright-cli` 取证。
- 不验证 push、PR 或发布；checkpoint 仅是 run 内本地门禁，不是正式发布机制。

## 前提事实

- 需求来源：`docs/architecture/multi-agent-orchestrator.md`。
- run 共享状态：`.runweave/agent-team/<runId>.json`。
- 测试案例解析：`backend/src/agent-team/acceptance-case-loader.ts`，只接受项目内 Markdown，case 标题必须是 `### <CASE-ID>`，且必须包含 `步骤`、`期望`、`失败判定`。
- split 入口：`POST /api/agent-team/runs/:runId/propose-split`；请求可带 `generatedTestCaseFilePath`，worker role 由 `packages/shared/src/agent-team.ts` 约束。
- completion 真值入口：`/internal/terminal-completion` 写入 terminal completion feed；App Server 的 `agent.completion` 不直接推进 Agent Team loop。
- worker 结果必须写 pane-scoped `.runweave/outbox/<pane-or-panel>.json`，并与 run、session、panel、tmux pane、role 和 dispatch 身份一致。
- Web 行为必须通过 Dev Session 解析出的真实 surface 附着 `$toolkit:playwright-cli`；不得新开无关浏览器或用静态检查替代。
- 所有故障注入使用隔离项目、隔离 terminal session 或隔离 Dev Session，不停止或修改用户正在使用的 run。

## 必跑命令

以下命令按顺序执行，任一失败即停；静态门禁不能替代后面的真实行为用例：

```bash
pnpm --filter ./packages/shared typecheck
pnpm --filter ./backend typecheck
pnpm --filter ./frontend typecheck
pnpm --filter ./frontend lint
pnpm agent-team:verify-review-checkpoints
pnpm testing:inventory
git diff --check
```

## 设计方法与覆盖矩阵

- 场景法：AGT-ARCH-001、AGT-ARCH-002 覆盖从 intake 到三角色执行的基本流。
- 等价类与边界值：AGT-ARCH-003 覆盖不存在、项目外、空案例和缺段落四类非法来源；AGT-ARCH-012 覆盖不支持 split 的 pty runtime。
- 判定表：AGT-ARCH-006、AGT-ARCH-007 覆盖 pass/fail/skipped、稳定失败、repairKey、预算次数与 strategyAssessment 的组合。
- 状态迁移：AGT-ARCH-002、AGT-ARCH-008、AGT-ARCH-009 覆盖 intake/proposal/executing/need_human/done 及非法推进。
- 错误猜测：AGT-ARCH-004、AGT-ARCH-005、AGT-ARCH-010 覆盖迟到 completion、重复 signal、stale outbox 和重启窗口。
- 并发与权限：AGT-ARCH-011、AGT-ARCH-013 覆盖鉴权、项目边界、run/session/pane 隔离。
- 兼容回归：旧 `/api/orchestrator/*` 已明确下线，不作为兼容目标；回归重点是现行 `/api/agent-team/*`、tmux 和结构化 outbox 契约。

## 用例

### AGT-ARCH-001 缺少测试案例时必须停在 intake 并拒绝泛化 acceptance

前置条件：

- 在隔离的 tmux-backed terminal session 创建 Agent Team run。
- run 提供有效 `planFilePath`，但 `testCaseFilePath` 与 `generatedTestCaseFilePath` 均为空。
- 记录创建后的 run ID 和项目路径。

步骤：

1. 通过鉴权 API 读取 run，并使用 `$toolkit:playwright-cli` 查看真实 Agent Team sidecar。
2. 在未生成测试案例文件前，不携带案例路径调用 `POST /api/agent-team/runs/:runId/propose-split`。
3. 再次读取 API、`.runweave/agent-team/<runId>.json`、worker pane 列表和 sidecar。

期望：

- 初始 run 保持 `phase=intake`，`acceptance=[]`、`workers=[]`、`proposal=null`。
- propose-split 返回 400，错误信息包含“缺少可追溯测试案例文件”。
- 请求失败后仍无 worker pane，且系统没有生成“核心改动按任务目标落地”一类默认 acceptance。
- sidecar 明确提示需要基于计划文件生成测试案例，而不是显示已经拆分。

失败判定：

- 未提供可解析案例文件仍进入 `proposal` 或 `executing`。
- run 出现无 `sourceCaseId` / `sourceFilePath` 的泛化 acceptance。
- 任一 worker pane 在门禁通过前被创建或收到启动 prompt。

标签：主路径 负向 门禁 可追溯

### AGT-ARCH-002 可解析生成文件必须以精确三角色进入 executing

前置条件：

- 隔离 run 处于 `intake`，`options.autoApproveSplit=true`，并带有效计划文件。
- 已用 `$toolkit:write-test-cases` 生成项目内 `docs/testing/agent-team/*-test-cases.md`，且真实 loader 至少解析出 1 条 case。

步骤：

1. 调用 `POST /api/agent-team/runs/:runId/propose-split`，设置 `source=agent`、`generatedTestCaseFilePath`，并只提交 `code`、`code_review`、`behavior_verify` 三个 worker。
2. 读取响应、run JSON、tmux pane 列表和每个 worker 的启动输出。
3. 使用 `$toolkit:playwright-cli` 查看 sidecar 的阶段、worker 角色和 acceptance 来源。

期望：

- API 成功，run 直接进入 `phase=executing`、`status=running`。
- `verification.acceptanceSource=plan_file_generated`，`generatedTestCaseFilePath` 为 loader 归一化后的项目相对路径，并记录非空 SHA-256。
- acceptance 数量等于 loader 解析数量，每项保留 `caseId=sourceCaseId`、`sourceFilePath` 和三级标题来源。
- run 中恰好存在 `code`、`code_review`、`behavior_verify` 三类 worker；实际执行遵守后端串行 gate，不把三者当成可互相越权的独立主控。
- 每个已创建 pane 的 panel/tmux/role/dispatch 身份可从 run JSON 和终端输出相互对应。

失败判定：

- 路径存在但 acceptance 丢失来源字段、case 数量不一致或使用默认文案。
- 缺任一指定角色、出现旧 `coder/reviewer/tester` 角色或重复 role。
- `autoApproveSplit=true` 仍停在人工 proposal，或未创建可追溯的 worker dispatch。

依赖：AGT-ARCH-001

标签：主路径 状态迁移 三角色

### AGT-ARCH-003 非法生成文件不得改变 run 或创建 worker

前置条件：

- 为四个相互独立的隔离 run 分别准备以下输入：不存在路径、项目根外路径、无三级 case 标题的 Markdown、case 缺少 `步骤` / `期望` / `失败判定` 任一必需段落。
- 每个 run 均处于 `intake` 且尚无 worker。

步骤：

1. 每次只选择一个非法等价类作为 `generatedTestCaseFilePath` 调用 propose-split。
2. 记录每次 HTTP 状态和错误信息。
3. 读取对应 run JSON、项目 `.runweave/outbox/` 和 tmux pane 列表。

期望：

- 不存在或不可解析文件返回 400；项目根外路径返回 403。
- 错误明确指出路径不存在、越界或缺失的 case 段落，不用泛化 acceptance 降级。
- 四个 run 均保持原 phase/status，`workers=[]`、`acceptance=[]`、`generatedTestCaseFilePath=null`。
- 不产生 worker pane、worker outbox 或 completion 消费副作用。

失败判定：

- 任一非法输入被接受、被静默裁剪成空 acceptance，或触发默认 acceptance。
- 一次失败请求污染其他 run、创建 pane 或修改 loop 计数。

标签：等价类 文件边界 负向

### AGT-ARCH-004 completion 只能推进身份完全匹配的 pane-scoped outbox

前置条件：

- 隔离 run 正在等待一个已派发 worker，记录 runId、sessionId、panelId、tmuxPaneId、role、dispatchId 和目标 pane-scoped outbox 路径。
- 准备 6 个独立变体：完全匹配、错 run、错 session、错 panel、错 tmux pane、错 role/dispatch。

步骤：

1. 每轮恢复同一基线，只写入一个 outbox 变体并发送对应 `/internal/terminal-completion` signal。
2. 读取 run JSON、completion 日志、后继 pane 输入和 outbox 消费记录。
3. 对完全匹配变体重复发送同一 completion signal。

期望：

- 只有完全匹配变体触发一次状态迁移和一次后继 dispatch。
- 五个错误身份变体均记录可解释的 stale/mismatch 原因，不改变 acceptance、active role、round 或 loop 计数。
- 重复发送完全匹配 signal 保持幂等，不重复消费 outbox、不重复注入 prompt。
- 所有结果都从 pane-scoped outbox 读取；不存在 session 级 `.runweave/outbox/<sessionId>.json` 回退。

失败判定：

- 任一身份不匹配 outbox 推进 run 或被归属到错误 worker。
- 同一合法结果产生两次状态迁移、两次 prompt 或两次 loop 计数。
- backend 使用 session 级 legacy outbox 作为成功证据。

标签：身份隔离 幂等 completion outbox

### AGT-ARCH-005 只有 terminal completion feed 能推进 Agent Team loop

前置条件：

- 隔离 run 正在等待 worker，合法 pane-scoped outbox 已写入但尚未消费。
- 能分别投递 App Server `agent.completion` 和 backend `/internal/terminal-completion`。

步骤：

1. 只投递 App Server `agent.completion`，记录 ThreadRef/TerminalState 投影、run JSON 和 loop 状态。
2. 再投递同一 pane 的 `/internal/terminal-completion`，读取 run JSON、日志和 sidecar。
3. 对两个事件保留时间戳和来源证据。

期望：

- App Server 事件可以更新其受限投影，但不直接消费 Agent Team outbox、不推进 active role 或 loop round。
- terminal completion feed 到达后，backend 才按身份匹配消费 outbox并推进一次。
- 日志能区分 completion 来源，不把 App Server 投影误记为 Agent Team 决策来源。

失败判定：

- 仅 App Server 事件就推进 worker gate 或修改 acceptance。
- terminal completion 到达后仍不消费合法 outbox，或两个来源各推进一次。

标签：事件边界 状态迁移 回归

### AGT-ARCH-006 部分行为失败后只复验失败未执行依赖和受影响用例

前置条件：

- 隔离 run 的 acceptance 至少包含 5 条相互可区分的 case，其中一条有显式 `dependsOn`。
- 首轮 `behavior_verify` 结果包含 pass、fail、skipped/未执行三种状态，并记录代码影响面。

步骤：

1. 让首轮 behavior verifier 写入合法 pane-scoped outbox 并完成。
2. 完成后端要求的 code 修复与 code_review gate，使 run 进入复验派发。
3. 读取复验 prompt、run acceptance、round 和已通过 case 的历史证据。

期望：

- 复验集合只包含失败、未执行、失败项依赖和本次 diff 明确影响的 case。
- 首轮已通过且不受影响的 case 保持 pass，不被重置为 pending，也不要求无理由全量重跑。
- 复验 prompt 逐条保留 `sourceCaseId`、`sourceFilePath` 和依赖信息。
- 新结果合并后，历史证据和当前轮结果可区分，不把 skipped 当作 pass。

失败判定：

- 后端无差别重置全部 acceptance，或遗漏失败/未执行/依赖 case。
- 已通过 case 的证据被覆盖，skipped 被计为 pass，或复验来源不可追溯。

依赖：AGT-ARCH-002

标签：选择性复验 依赖 状态迁移

### AGT-ARCH-007 修复交接必须覆盖 repairKey 并受独立预算约束

前置条件：

- 分别构造一个 behavior fail 和一个带 P0/P1 blocking finding 的 code_review fail。
- run 的 `maxRepairAttempts=3`，backend 已为两类失败建立各自 repairKey。

步骤：

1. 先提交缺失、过期或 key 不匹配的 `fixVerifications`，观察 gate。
2. 再提交恰好覆盖 repairKey 且带真实 runtime/structural 证据的 handoff，观察独立 reviewer/verifier 是否接棒。
3. 对同一 repairKey 连续制造三轮独立 gate 失败；第 2、3 轮分别检查有无 `strategyAssessment`。

期望：

- 无效 handoff 不进入下一 gate；协议补交只允许一次，仍无效时进入 `need_human`。
- 有效 handoff 只表示可交给独立 gate 复验，不允许 code worker 自己把 acceptance 标记为 pass。
- 第 2 次及以后必须提供 `strategyAssessment`；diff、round、noProgress 或 timeout 都不能重置该 repairKey 的 `repairCycles`。
- 第 3 次独立 gate 仍失败后，run 进入 `need_human`，保留每轮 handoff、失败摘要和现场。

失败判定：

- repairKey 未覆盖仍推进、code 自证通过、预算被任意信号重置或超过 3 次仍自动修复。
- review finding 没有稳定 invariantKey/verificationMode 仍进入修复闭环。

标签：修复预算 判定表 独立门禁

### AGT-ARCH-008 连续无客观进展必须熔断且仅由人工 note 恢复

前置条件：

- 隔离 run 的 `maxNoProgress=3`，准备相同失败 fingerprint 和不提升 `bestPassCount` 的三轮结果。
- 记录所有 worker pane 和当前 outbox，不删除现场。

步骤：

1. 连续提交三轮无新 diff、无新增 pass、相同 fingerprint 的合法结果。
2. 读取 run JSON 和 sidecar，尝试继续自动注入 worker prompt。
3. 通过 `POST /api/agent-team/runs/:runId/resume` 提交非空人工 note，再读取 run、pane 和下一 dispatch。

期望：

- 第 3 次无进展后 `status=need_human`、`loop.escalated=true`，后续自动注入被冻结。
- 熔断不删除 pane、outbox、acceptance、errorFingerprints 或失败证据。
- 空 note 被拒绝；非空 note 清理当前重复失败计数并注入主 Agent 上下文，run 才恢复推进。

失败判定：

- 少于阈值就熔断、达到阈值仍无限循环，或熔断时清空现场。
- 没有人工 note 也自动恢复，或 note 未进入后续主 Agent 上下文。

标签：熔断 人工恢复 状态迁移

### AGT-ARCH-009 local_commit 模式必须锁定 checkpoint 并对漂移 fail closed

前置条件：

- 使用干净 Git 分支和隔离 worktree 创建 `reviewCheckpointMode=local_commit` 的 run。
- code 产生一组任务内改动，code_review 首轮给出 pass；另准备来源文件漂移、外部 HEAD 漂移、未暂存代码漂移和 verifier SHA 错误四个独立变体。

步骤：

1. 让 backend 完成首轮 review checkpoint，读取 commit trailer、run JSON 和 Git 状态。
2. 在各自恢复的基线上单独注入四种漂移，然后尝试继续 review/behavior gate。
3. 在无漂移基线上让 behavior verifier 回传正确 `verifiedCheckpointCommit`，全部案例通过后观察 final full review。

期望：

- checkpoint 只由 backend 创建在 run 专属本地分支，排除 `.runweave/**` 和 `docs/review/**`，不 push、不替代正式提交。
- 四种漂移均 fail closed 到 `need_human`，不让错误 SHA 的 behavior 结果通过。
- 正常路径的 verifier 只验证 prompt 指定 SHA；所有行为通过后仍执行从任务基线到最新 checkpoint 的 final full review。
- backend 重启时按 trailer 恢复已创建 checkpoint，不重复提交。

失败判定：

- worker 自行创建 checkpoint、敏感/排除文件进入 commit、checkpoint 被 push，或任何漂移未阻断。
- behavior 未绑定 SHA 就通过，或跳过 final full review 直接 done。

标签：checkpoint Git fail-closed

### AGT-ARCH-010 backend 重启必须从 run 与新 outbox 恢复且不重复推进

前置条件：

- 隔离 run 正在等待一个 worker，记录派发时 outbox baseline mtime；准备 baseline 为 null 和已有 stale outbox 两种状态。
- 可以只重启隔离 backend，不影响用户正在使用的服务。

步骤：

1. 在 worker 写完新 outbox、completion 尚未送达的窗口停止 backend。
2. 恢复 backend，等待启动 reconciliation；再等待至少一个周期扫描。
3. 对 null baseline 和 stale outbox 两种状态分别读取 run、日志、prompt 次数和 outbox mtime。

期望：

- 新 outbox 在 backend 恢复后被消费一次，run 在一个扫描周期内进入正确后继状态。
- null baseline 使用 dispatch/request 时间判断新结果；早于派发的 stale outbox 不被消费。
- 启动扫描与周期扫描不会重复推进，同一结果只产生一个后继 prompt。
- 真正没有新 outbox 时保留既有 timeout/retry/need_human 语义，不把“无结果”伪装成 pass。

失败判定：

- 重启后 run 永久卡住、消费 stale 文件、重复派发，或必须人工重发 completion 才恢复。
- 扫描把不存在结果当成功，或破坏原 timeout 上限。

标签：重启恢复 迟到结果 幂等

### AGT-ARCH-011 受保护 Agent Team API 必须鉴权并限制项目文件边界

前置条件：

- 存在一个隔离 run 和可用的正确 Bearer token；另准备无 token、错误 token、另一个项目 ID、项目外文件路径四个变体。

步骤：

1. 分别使用无 token、错误 token 和正确 token 调用 run 查询与 propose-split。
2. 使用正确 token 尝试读取另一个项目的 session/run，并提交项目外 plan/test case 路径。
3. 检查 HTTP 响应、backend 日志和敏感字段输出。

期望：

- 无 token 或错误 token 返回 401，且不泄露 run 内容。
- 正确 token 只能按现有授权边界访问已注册资源；跨项目路径或解析后越界路径返回 403。
- 错误响应和日志不包含 Bearer token、hook token 或其他凭证原文。
- 所有拒绝请求不改变 run、worker、acceptance 或 loop 状态。

失败判定：

- 未鉴权可读写 run、路径遍历成功、跨项目数据串出，或日志泄露完整敏感 token。
- 拒绝请求仍创建 worker/pane 或修改共享状态。

标签：鉴权 路径边界 敏感数据

### AGT-ARCH-012 pty runtime 必须拒绝 worker split 并保留可恢复现场

前置条件：

- 在隔离项目创建 runtime 为 pty 的 terminal session，并准备 loader 可解析的生成测试案例文件。
- run 尚未创建任何 worker pane。

步骤：

1. 对该 run 提交包含三类 worker 和 `generatedTestCaseFilePath` 的 propose-split。
2. 读取 HTTP 响应、run JSON、terminal session 和 sidecar。
3. 将同一任务迁移到可 split 的 tmux session 后重新创建隔离 run，并提交相同提案。

期望：

- pty session 明确拒绝 split，不伪造 worker pane、不丢失任务、计划文件或生成案例路径。
- 错误信息指出 runtime 不支持 pane split，run 保留可供人工迁移的现场。
- tmux session 上相同合法提案可进入正常 split，证明失败来自 runtime 能力而非测试案例。

失败判定：

- pty 上显示已 split 但无真实 pane，或任务/验收来源被清空。
- 迁移到 tmux 后仍因残留错误状态无法创建新 run。

标签：runtime 边界 降级 错误反馈

### AGT-ARCH-013 并发 run 的 completion outbox 和 UI 不得串扰

前置条件：

- 在两个隔离 project/terminal session 中各启动一个 executing run，二者拥有相同 worker role 但不同 runId、sessionId、panelId、tmuxPaneId 和 outbox。
- 两个 run 的 acceptance case ID 可相同，用于验证身份不能只靠 case ID。

步骤：

1. 近同时让两个 worker 写入结果相反的合法 pane-scoped outbox 并产生 completion。
2. 并发读取两个 run API、各自 sidecar、tmux pane 和 outbox 历史。
3. 对其中一个 run 触发 focus-pane 和 export，检查返回资源集合。

期望：

- 每个 completion 只更新所属 run；相同 role/case ID 不造成错误归属。
- pass/fail、round、bestPassCount、repairCycles、active role 和 UI 展示分别保持各自结果。
- focus-pane 只聚焦所属 pane；export 只包含 run-bound panels，并把同 session 其他 pane 明确列为非所属资源。
- 两个 run 均不创建 session 级 legacy outbox。

失败判定：

- 任一 run 消费另一个 run 的 outbox、UI 显示交叉状态、focus 错 pane 或 export 混入对方结果。
- 仅靠 case ID/role 匹配导致 completion 串扰。

标签：并发 隔离 export UI

## 验收通过标准

- AGT-ARCH-001 至 AGT-ARCH-013 全部有当前轮真实证据，且状态均为 pass；未执行、skipped 或仅静态检查不计通过。
- 所有 acceptance 都能追溯到本文件的 `sourceCaseId`、`sourceFilePath` 和标题；不存在泛化默认 acceptance。
- split 只使用 `code`、`code_review`、`behavior_verify` 三类 worker，身份、pane、dispatch、outbox 和 completion 全链一致。
- 非法文件、越界路径、错误鉴权、stale identity、pty runtime 和状态漂移均 fail closed，且不产生 worker 副作用。
- 选择性复验、修复预算、无进展熔断、checkpoint 和重启恢复均保留完整现场并且不重复推进。
- 浏览器/UI 结论由 `$toolkit:playwright-cli` 附着真实 Dev Session surface 取证；backend/协议结论由真实 API、run JSON、tmux、outbox 或现有 verify harness 取证。
