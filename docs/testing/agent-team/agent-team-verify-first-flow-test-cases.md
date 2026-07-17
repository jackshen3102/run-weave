# Agent Team Verify-First Flow 测试案例

本文档是 Agent Team「执行模式反转（verify-first flow）」这次改动的测试案例源文件，交接给执行 agent 使用。它覆盖新的 `options.flow` 契约、反转入口（先 behavior_verify 起步）、首轮全绿短路完成、无代码活动时 review gate 的 vacuous pass、失败回环复用既有 verify↔code 子循环、verify-first 下 `stableFailThreshold=1`，以及前端 flow 选择器 UI 与值透传。

本 skill 只负责**写**用例；执行、取证、判缺陷由 `run-test-cases` 负责。

## 测试原则

- 只验证真实场景：状态机/协议类用例用真实 `AgentTeamService`（真实 tmux pane、真实 outbox 路由）驱动；UI 类用例用 `$toolkit:playwright-cli` 操作真实浏览器；桌面端联动用 `$computer-use`。
- **禁止用静态检查冒充功能验证**：`pnpm typecheck` / `pnpm lint` 只是前置门禁，不作为任何行为/UI 用例的通过证据。
- 本仓库不新增单测/Vitest；状态机用例复用既有 harness（真实 service + 真实 tmux），不写 mock service 单测。
- 每条用例围绕一个明确行为，断言可观察结果（run 状态、activeWorkerRole、acceptance case 状态、UI 文本/属性、prompt 内容），不断言私有函数调用次数。
- 每条用例自带前置、相互独立，断言确定可复现，不依赖时间/顺序/网络抖动。
- 每条用例留证据：脚本关键输出、run JSON 片段、outbox 片段、截图/DOM 摘要。

## 被测契约

实现范围（本次改动引入）：

- `AgentTeamRunOptions` 新增可选字段 `flow?: "code_first" | "verify_first"`，缺省视为 `code_first`，向后兼容已持久化的 run JSON。
- `verify_first` 下：`applySplit` 的首个 active worker 是 `behavior_verify`（而非 `code`）；后半段 fail→bounce code→code_review→回 behavior_verify 的子循环、`repairCycles`/`maxRepairAttempts`/`maxNoProgress` 熔断、`need_human`/`notifyMainOnHumanGate` 全部复用现有逻辑，不改状态机主体。
- `verify_first` 下 `stableFailThreshold=1`（首轮 fail 即抛回 code）；`code_first` 保持默认 `2`。
- **首轮全绿短路**：behavior_verify 全绿且本 run 从未消费过任何 `code`/`code_review` dispatch（`consumedWorkerDispatches` 无对应 role）时，合成的 `AGT-REVIEW-GATE` case 无审查对象，被判 vacuous pass，run 直接 `done`，不触发空 review。
- **守卫精确性**：一旦本 run 已消费过 code/code_review dispatch（发生过真实代码活动），review gate **不**被自动放过，必须经真实 code_review 满足；behavior 全绿也不得静默 `done`。
- 开启 `reviewCheckpointMode="local_commit"` 时，首轮全绿零改动（`checkpoints.length === 0`）不触发 `base..base` 的空 final review。
- 前端 `StartFlowSection` 提供 Code First / Verify First 选择器，选中值经 `startFlow` → `options.flow` 透传后端；retry 时从失败 run 的 `run.options.flow` 回填。

关键代码锚点：

- `packages/shared/src/agent-team.ts`（`AgentTeamFlow` 类型、`AgentTeamRunOptions.flow`）
- `backend/src/routes/agent-team.ts`（`createRunSchema.options.flow` 校验）
- `backend/src/agent-team/loop.ts`（`createInitialLoop(maxRepairAttempts, stableFailThreshold)`）
- `backend/src/agent-team/service-workflow-policy.ts`（`resolveInitialActiveWorkerRole(workers, flow)`）
- `backend/src/agent-team/service-lifecycle.ts`（`startRun` 读 flow、verify_first 传 threshold=1、写 `run.options.flow`）
- `backend/src/agent-team/service-execution.ts`（`applySplit` 按 flow 选首个 dispatch；`applyRound` 的 review-gate vacuous pass 守卫 + 零-diff final review 短路）
- `frontend/src/components/terminal/terminal-agent-team-panel.tsx`（flow state、透传、retry 回填）
- `frontend/src/components/terminal/terminal-agent-team-panel-sections.tsx`（`StartFlowSection` 选择器 UI）
- `scripts/verify-agent-team-review-checkpoints/verify-first-flow.mjs`（真实 service e2e 模块）
- `scripts/verify-agent-team-review-checkpoints/bootstrap-lifecycle-serial-harness.mjs`（harness 暴露 `round()`）

## 测试环境

状态机 e2e 用例通过既有 harness 脚本执行（真实 `AgentTeamService` + 真实 tmux socket，outbox 由 fixture 注入）：

```bash
# 运行整套 agent-team 契约 + verify-first 三场景
pnpm agent-team:verify-review-checkpoints
```

UI 用例二选一：

- 优先在真实桌面端/Web workspace 里打开 Agent Team 面板（需登录态 + 可运行 tmux terminal），用 `$toolkit:playwright-cli` 附着操作真实面板。
- 若无法起完整环境，用临时 Vite 入口挂载真实 `StartFlowSection` 组件渲染（不接后端），用 `$toolkit:playwright-cli` 验证选择器渲染、切换和 `onFlowChange`/`onStart` 透传。

## 必跑命令

按顺序执行，任一失败即停：

```bash
pnpm agent-team:verify-review-checkpoints   # 必须输出 "ok": true 且含三条 verify-first 检查
pnpm typecheck
pnpm lint
git diff --check
```

静态门禁不能替代真实状态机与浏览器证据。

## 用例索引

| ID         | 场景                                            | 验证方式                     |
| ---------- | ----------------------------------------------- | ---------------------------- |
| AGT-VF-001 | flow 缺省向后兼容为 code_first                  | e2e harness / route          |
| AGT-VF-002 | route 校验拒绝非法 flow 值                      | 可执行脚本（HTTP）           |
| AGT-VF-003 | verify_first split 首个 active worker 是 verify | e2e harness（真实 tmux）     |
| AGT-VF-004 | 首轮全绿 + 零代码活动直接 done                  | e2e harness                  |
| AGT-VF-005 | review gate 在已有代码活动后不被 vacuous pass   | e2e harness（对照）          |
| AGT-VF-006 | verify_first 失败首轮即抛回 code（threshold=1） | e2e harness                  |
| AGT-VF-007 | 失败回环复用 verify↔code 子循环至完成/熔断      | 真实桌面端 + codex（端到端） |
| AGT-VF-008 | 开启 checkpoint 时首轮全绿零改动不触发空 review | e2e harness / 真实桌面端     |
| AGT-VF-009 | UI 选择器渲染与切换生效                         | `$toolkit:playwright-cli`    |
| AGT-VF-010 | UI 选中值经 onStart 透传到 options.flow         | `$toolkit:playwright-cli`    |
| AGT-VF-011 | retry 从失败 run 回填 flow                      | `$toolkit:playwright-cli`    |
| AGT-VF-012 | code_first 回归：仍从 code 起步、threshold=2    | e2e harness                  |

---

### AGT-VF-001 flow 缺省时向后兼容为 code_first

步骤：

1. 构造一个不带 `options.flow` 的 create-run 请求（模拟旧客户端 / 已持久化 run）。
2. 通过 `startRun` 或 route 创建 run，读取生成的 `run.options.flow` 与 `run.loop.stableFailThreshold`。

期望：

- `run.options.flow === "code_first"`。
- `run.loop.stableFailThreshold === 2`（未被 verify_first 改成 1）。
- split 后首个 active worker 为 `code`（沿用旧行为）。

失败判定：

- 缺省 flow 被解析成 `verify_first`，或 threshold 被改成 1，或首个 worker 变成 behavior_verify。

### AGT-VF-002 route 校验拒绝非法 flow 值

步骤：

1. 向 `POST /api/agent-team/runs` 提交 `options.flow="verify"`（非法值）、`options.flow=123`（非字符串）各一次。
2. 分别提交 `options.flow="code_first"`、`options.flow="verify_first"` 合法值各一次（可用 mock service 只断言 schema，参照 `repair-integration.mjs` 的 route 测法）。

期望：

- 两个非法请求返回 HTTP 400。
- 两个合法请求通过校验，service 收到的 `options.flow` 分别等于 `code_first` / `verify_first`。

失败判定：

- 非法 flow 值被接受（非 400），或合法值被拒绝，或 service 收到的值被篡改。

### AGT-VF-003 verify_first split 首个 active worker 是 behavior_verify

步骤：

1. 用 `bootstrap-lifecycle-harness` 的 `withHarness` 起真实 tmux + `AgentTeamSerialDispatchHarness`。
2. 构造 `options.flow="verify_first"`、`phase="proposal"` 且含 code/code_review/behavior_verify 三 worker 的 run。
3. 调 `service.split(run, workers, acceptance)` 完成 `applySplit`。

期望：

- 返回 run `phase === "executing"`、`activeWorkerRole === "behavior_verify"`。
- 只有 behavior_verify worker `frozen === false`，其余两个 frozen。
- 首个 startup prompt 投递到 behavior_verify pane（对应 `verify-first-split-starts-behavior-verify` 检查）。

失败判定：

- 首个 active worker 是 code 或 code_review；或多于一个 worker 未冻结；或首个 prompt 发给了非 behavior_verify pane。

### AGT-VF-004 首轮全绿 + 零代码活动时 run 直接 done

步骤：

1. 起 `verify_first`、`executing` 态、`consumedWorkerDispatches` 为空、`reviewCheckpoint=null` 的 run，acceptance 含一条 behavior case（如 BSP-001）。
2. 调 `service.round(run, { acceptanceResults:[{caseId, status:"pass"}], completedWorkerRole:"behavior_verify" })` 驱动 `applyRound`。

期望：

- 返回 run `status === "done"`、`activeWorkerRole === null`。
- 该 behavior case 状态 `pass`。
- 合成的 `AGT-REVIEW-GATE` case 被判 `pass`（resultSummary 说明「无代码改动，Code Review 门禁无审查对象」）。
- 未产生任何二次 dispatch（无多余 review 派发）。对应 `verify-first-first-pass-all-green-completes` 检查。

失败判定：

- run 停在 `running`（review gate 卡住）；或 review gate 仍为 pending/fail；或触发了一次 code_review dispatch。

### AGT-VF-005 已发生代码活动时 review gate 不被 vacuous pass（对照）

步骤：

1. 起 `verify_first`、`executing` 态的 run，`consumedWorkerDispatches` 含至少一条 `role:"code"` 和一条 `role:"code_review"` 的 receipt（模拟已经历过 bounce→code→review）。
2. 调 `service.round(run, { acceptanceResults:[{caseId, status:"pass"}], completedWorkerRole:"behavior_verify" })`。

期望：

- run **不**为 `done`（review gate 未被自动放过）。
- `AGT-REVIEW-GATE` case 状态**不**为 `pass`（须经真实 code_review 满足）。
- 对应 `verify-first-review-gate-not-bypassed-after-code-activity` 检查。

失败判定：

- behavior 全绿即静默 `done`，或 review gate 在无真实 review 的情况下被置 pass —— 说明守卫信号退化（例如错用 `repairCycles` 而非 `consumedWorkerDispatches`）。

### AGT-VF-006 verify_first 失败首轮即抛回 code（stableFailThreshold=1）

步骤：

1. 起 `verify_first` run（`createInitialLoop(maxRepairAttempts, 1)`，即 `stableFailThreshold=1`），acceptance 含一条 behavior case。
2. 调 `service.round` 传入该 case `status:"fail"`（`completedWorkerRole:"behavior_verify"`）。

期望：

- 该 case 单轮 fail 即达到稳定失败阈值，被 bounce 到 code pane（`bouncedToPanelId` 指向 code pane）。
- 不需要连续两轮 fail 才回弹。

失败判定：

- 首轮 fail 后未 bounce（仍等第二轮），说明 threshold 未按 verify_first 收敛为 1。

### AGT-VF-007 失败回环复用 verify↔code 子循环直到完成或熔断（真实端到端）

步骤：

1. 在真实桌面端（Beta 实例）用 `$computer-use` 起可 split 的 tmux terminal，`$toolkit:playwright-cli` 打开 Agent Team 面板。
2. 选择 Verify First 模式，填入一个**含已知失败用例**的 `docs/testing/*-test-cases.md`，开始 run（真实 codex 驱动 worker pane）。
3. 观察面板与 pane：behavior_verify 先跑 → 失败用例抛回 code → code 修复 → code_review → 回 behavior_verify 复验。

期望：

- 首个执行的是 behavior_verify（面板 Loop 状态显示 behavior_verify 为 active）。
- 失败用例出现「→ 已抛回 code pane 修复」标记。
- 修复通过后 run 走向 `done`；若持续失败，`noProgressCount`/`repairCycles` 达阈值后进入 `need_human` 并按 `notifyMainOnHumanGate` 通知主 Agent。
- 证据：面板截图、各 pane 终端画面、run JSON 的 acceptance/loop 片段、真实 outbox 片段。

失败判定：

- 起步不是 behavior_verify；或失败用例未回弹 code；或修复通过后 run 不完成；或熔断后未进入 need_human / 未按配置通知主 Agent。

说明：本用例是唯一覆盖「真实 AI CLI 在 pane 内按 prompt 产出合规 outbox」的端到端场景；AGT-VF-003~006 用 fixture outbox 覆盖编排与状态流转。

### AGT-VF-008 开启 checkpoint 时首轮全绿零改动不触发空 final review

步骤：

1. 在干净 Git worktree 起 `verify_first` + `reviewCheckpointMode="local_commit"` 的 run（`reviewCheckpoint.checkpoints` 为空、`lastReviewedCommit === taskBaseCommit`）。
2. 让 behavior_verify 首轮全绿（无任何代码改动），驱动 `applyRound`。

期望：

- run 直接 `done`，`needsFinalReview` 为 false（因 `checkpoints.length === 0`）。
- 不产生 `base..base` 的空 diff final review dispatch。
- 不产生任何 checkpoint commit。

失败判定：

- 全绿零改动仍触发一次 final code_review，或生成空 checkpoint commit，或 run 卡在 running。

### AGT-VF-009 StartFlowSection 渲染 flow 选择器且切换生效

步骤：

1. 用 `$toolkit:playwright-cli` 打开含真实 `StartFlowSection` 的页面（真实面板或临时挂载入口）。
2. 读取快照，确认「执行模式」区块存在两个按钮 Code First、Verify First。
3. 点击 Code First，再点击 Verify First，各取一次快照。

期望：

- 两个按钮均渲染，含各自说明文案（Code First：先写码 → 评审 → 验证；Verify First：先验证 → 失败才修复 → 评审）。
- 选中按钮带 `aria-pressed=true` 且高亮样式；未选中为 false。
- 切换后下方说明文案与编号步骤第 2 条随模式变化（verify_first 显示「先跑验证；失败按 verify → code → review 回环推进」）。
- 证据：两态截图 + 快照中 `[pressed]` 标记差异。

失败判定：

- 选择器不渲染；或点击后 `aria-pressed`/高亮不切换；或说明文案不随模式更新。

### AGT-VF-010 选中值经 onStart 透传到 options.flow

步骤：

1. 在真实面板中，选择 Verify First，填入必填 task，点击「开始 Agent Team」。
2. 抓取发往 `POST /api/agent-team/runs` 的请求体（`playwright-cli requests` 或后端日志）。

期望：

- 请求体 `options.flow === "verify_first"`。
- 改选 Code First 再提交时，请求体 `options.flow === "code_first"`。

失败判定：

- 请求体缺少 `options.flow`，或其值与 UI 当前选中不一致。

说明：无完整后端时，可用临时挂载入口断言 `onStart` 回调拿到的 flow 值等于当前选中值（等价验证透传链路），并在证据中标注为组件级验证。

### AGT-VF-011 retry 从失败 run 回填 flow

步骤：

1. 构造/复现一个 `status="failed"` 且 `run.options.flow="verify_first"` 的 run，在面板中触发「修改参数并重试」。
2. 观察回填后的 StartFlowSection 选择器状态。

期望：

- 选择器回填为 Verify First（`run.options.flow ?? "code_first"`）。
- 对 `flow` 缺省的旧失败 run，回填为 Code First。

失败判定：

- retry 后 flow 选择器恢复成默认 code_first 而非失败 run 的原值；或旧 run 报错。

### AGT-VF-012 code_first 回归：仍从 code 起步且 threshold=2

步骤：

1. 起 `options.flow="code_first"`（或不传 flow）的 run，走 `applySplit`。
2. 检查首个 active worker 与 `loop.stableFailThreshold`。
3. 让某 behavior case 单轮 fail 一次，确认未立即 bounce。

期望：

- 首个 active worker 为 `code`。
- `stableFailThreshold === 2`。
- 单轮 fail 不立即回弹，需连续两轮稳定 fail 才 bounce（沿用改动前行为）。

失败判定：

- code_first 下首个 worker 变成 behavior_verify，或 threshold 变成 1，或首轮 fail 即回弹 —— 说明反转改动泄漏到了 code_first。

## 验收通过标准

以下条件必须同时满足：

- 必跑命令全部通过；`pnpm agent-team:verify-review-checkpoints` 输出 `"ok": true` 且包含三条 verify-first 检查（AGT-VF-003/004/005 对应）。
- AGT-VF-001/002/003/004/005/006/008/012 在真实 service + 真实 tmux（或 route 脚本）下全部满足期望，无未声明副作用。
- AGT-VF-009/010/011 在 `$toolkit:playwright-cli` 真实浏览器下验证选择器渲染、切换、透传与回填，留有两态截图与请求体/回调证据。
- AGT-VF-007 在真实桌面端 + 真实 codex 下完成一次完整反转回环（起步 behavior_verify → 失败回弹 → 修复/复验 → done 或熔断 need_human），留有面板、pane、run JSON、outbox 证据；若环境不可用，明确记录「未执行 + 阻塞原因」，不得用其它用例冒充。
- code_first 回归（AGT-VF-012）证明反转能力未泄漏到默认流程。
