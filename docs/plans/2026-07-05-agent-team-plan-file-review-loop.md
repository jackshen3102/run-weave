# Agent Team 计划文件审查与自动修复 Loop 方案

## 背景

当前 Agent Team 把流程建模为 `clarify → proposal → executing`，并把需求澄清放进右侧 Agent Team route。这个模型和真实使用方式不一致：

- 需求澄清可以发生在任意对话或终端上下文里，不应该强绑定到 Agent Team route。
- 用户真正提交给 Agent Team 的是一个“可执行任务”，其中可能包含一个计划文件。
- 如果任务包含计划文件，系统应先审查计划文件；审查失败时由 AI 自动修计划，再复审，而不是进入人工 gate。
- 如果任务不包含计划文件，应走普通执行流程，不额外引入计划审查。

本方案只描述实现计划，不进入代码实现。

## 目标

1. 在 Agent Team 创建请求中新增一个可选字段 `planFile`。
2. `planFile` 存在且非空时，视为“带计划文件的任务”，先进入计划质量 loop。
3. `plan_review fail` 时自动把审查结果抛回给 `plan` worker 修复计划，再重新触发 `plan_review`。
4. `plan_review pass` 后再进入 worker 拆分 proposal/split。
5. `planFile` 不存在时，保持普通任务路径：直接进入 proposal/split，再执行 code/code_review/behavior_verify loop。
6. 需求澄清不再作为 Agent Team route 内的强制阶段；route 内只处理已经提交的任务。

## 非目标

- 不实现新的“生成计划”阶段。计划文件是输入，不是 Agent Team route 内生成的产物。
- 不把 `plan_review fail` 变成人工 gate。只有连续无进展、重复失败或 watchdog 超时才升级人工。
- 不新增单元测试文件。
- 不改变 worker outbox 的 `acceptanceResults` 证据模型。
- 不改 App 或 Electron 页面；首期只改 Web desktop Agent Team route 与 backend 编排。

## 用户可见行为

### 普通任务

用户只提交任务文本，不传 `planFile`：

1. Agent Team 创建 run。
2. 右侧展示“拆分提案”。
3. 用户确认后 split worker panes。
4. 执行 worker 默认仍为 `code`、`code_review`、`behavior_verify`。

### 带计划文件任务

用户提交任务文本，并传 `planFile`：

1. Agent Team 创建 run。
2. 系统先启动计划质量 loop，至少包含两个 worker：
   - `plan`：负责根据审查意见修改计划文件。
   - `plan_review`：负责审查计划文件。
3. `plan_review` 首先运行，读取 `task` 和 `planFile`。
4. 如果 `plan_review pass`，进入拆分提案阶段。
5. 如果 `plan_review fail`，系统把失败 case 和 evidence 抛回 `plan` worker。
6. `plan` worker 修复计划文件后，系统重新触发 `plan_review`。
7. 多轮无进展或超时后才进入人工介入。

## API 与数据结构

### Shared 类型

修改 `packages/shared/src/agent-team.ts`。

`CreateAgentTeamRunRequest` 增加：

```ts
planFile?: string;
```

`AgentTeamRun` 增加：

```ts
planFile?: string | null;
```

约束：

- `planFile` 字段不存在：普通任务。
- `planFile` 字段存在且 trim 后非空：带计划文件任务。
- `planFile` 字段存在但为空字符串：请求非法。
- `planFile` 首期作为计划文件引用传递给 worker；backend 不在 API 层读取文件内容，避免把文件读取权限和路径解析混进路由校验。

### 后端路由

修改 `backend/src/routes/agent-team.ts`：

- `createRunSchema` 增加 `planFile: z.string().trim().min(1).optional()`。
- 其它 route 不需要新增字段。

### Run phase

当前 `AgentTeamPhase = "clarify" | "proposal" | "executing"` 不再匹配目标模型。

建议改为：

```ts
export type AgentTeamPhase =
  | "intake"
  | "plan_review"
  | "proposal"
  | "executing";
```

语义：

- `intake`：任务已进入 Agent Team，但尚未进入 proposal。它不是多轮澄清，只是 route 内部的任务接收态。
- `plan_review`：计划文件审查/修复 loop 正在进行。
- `proposal`：执行 worker 拆分提案等待确认。
- `executing`：执行、code review、behavior verify loop。

兼容处理：

- 本仓库当前不需要兼容旧 run 文件时，可直接迁移类型和 UI 文案。
- 如果本地残留旧 `.runweave/agent-team/*.json` 中有 `phase="clarify"`，可以在读取时视为不可恢复旧 run，或由开发阶段清理旧 run 文件；不做产品级兼容。

## 后端编排设计

### 创建 run

修改 `backend/src/agent-team/service.ts` 的 `startRun`：

1. 校验 `task` 非空。
2. 保存 `planFile = input.planFile?.trim() ?? null`。
3. 不再注入“需求澄清” startup prompt。
4. 根据 `planFile` 分支：
   - 无 `planFile`：创建 run 后进入 `proposal`，生成默认执行提案。
   - 有 `planFile`：创建 run 后进入 `plan_review`，启动计划质量 worker。

### 普通任务提案

复用现有 `normalizeWorkers` 和 `normalizeAcceptance`：

- 默认 workers 保持 `code`、`code_review`、`behavior_verify`。
- 默认 acceptance 保持当前逻辑。
- 右侧显示 proposal 卡，用户确认后 split。

### 计划质量 loop

新增或调整 helper：

- `createPlanReviewWorkers(run)`：创建 `plan` 和 `plan_review` worker。
- `buildPlanReviewPrompt(run, worker)`：告诉 `plan_review` 审查 `planFile`，输出 `acceptanceResults`。
- `buildPlanFixPrompt(run, failedCases)`：把 `plan_review` 的失败证据发给 `plan` worker，要求修改 `planFile`。
- `dispatchPlanReviewRecheck(run, cases)`：`plan` 完成后重新触发 `plan_review`。
- `isPlanReviewCase(item)`：识别计划审查相关 case。

计划 loop 的规则：

1. `plan_review` outbox 有 fail：
   - 不进入 proposal。
   - 不设置 `need_human`。
   - 将稳定失败 case bounce 到 `plan` worker。
2. `plan` worker completion：
   - 重新触发 `plan_review`。
3. `plan_review` 全部 pass：
   - 冻结或结束 `plan` / `plan_review` worker。
   - 生成执行 worker proposal。
4. 无进展达到阈值：
   - `status = "need_human"`。
   - UI 展示计划 loop 熔断原因。

### 与现有 loop 复用关系

尽量复用现有机制：

- `acceptanceResults` 折叠逻辑。
- stable fail 去抖。
- `noProgressCount` / `maxNoProgress`。
- recheck watchdog。
- outbox resolver。

需要拆开的逻辑：

- 当前 `bounceFailuresToCode` 总是找 `code` worker。计划 loop 需要 `bounceFailuresToPlan`，目标必须是 `plan` worker。
- 当前 `resolveRecheckDispatches` 会把 review case 发给 `code_review | plan_review`，但计划 loop 中只能发给 `plan_review`。
- 当前 `allAcceptancePassed` 会直接把 run 置为 `done`。计划 loop 中 pass 不代表 run 完成，只代表可以进入 proposal。

## 前端设计

### 启动入口

修改 `frontend/src/components/terminal/terminal-agent-team-panel-sections.tsx` 的启动区域：

- 文案从“需求澄清”改为“提交执行任务”。
- 保留任务输入框。
- 新增一个计划文件输入框，绑定 `planFile`。
- 计划文件输入框为空时不传字段。
- 计划文件输入框非空时传 `planFile`。

建议文案：

- 任务输入 placeholder：`描述要执行的任务`
- 计划文件 placeholder：`可选：计划文件路径，如 docs/plans/xxx.md`
- 开始按钮：`开始 Agent Team`

### 计划审查状态 UI

新增 `PlanReviewSection`：

- 显示 `planFile`。
- 显示当前计划审查 loop 状态。
- 显示 `plan_review` 的 pass/fail 结果和 evidence。
- fail 后显示“已抛回 plan worker 修复”，而不是显示人工阻塞。
- 达到熔断条件时复用现有人工介入 UI。

### Proposal 与 executing

- `plan_review pass` 后展示现有 proposal 卡。
- 用户确认后进入 executing。
- executing 继续使用当前验收用例 + evidence UI。

## 文件范围

Shared：

- `packages/shared/src/agent-team.ts`

Backend：

- `backend/src/routes/agent-team.ts`
- `backend/src/agent-team/service.ts`
- `backend/src/agent-team/prompt-builders.ts`
- `backend/src/agent-team/loop.ts`
- `backend/src/agent-team/outbox-resolver.ts`（仅在需要区分 plan review evidence 时调整）

Frontend：

- `frontend/src/components/terminal/terminal-agent-team-panel.tsx`
- `frontend/src/components/terminal/terminal-agent-team-panel-sections.tsx`
- `frontend/src/services/terminal.ts`

文档：

- `docs/plans/2026-07-03-agent-team-loop-engineer.md` 可后续追加“已被计划文件审查方案修正”的说明，或保留为历史方案。

## 实施步骤

### 1. 扩展请求和 run 数据模型

- 增加 `planFile?: string` 请求字段。
- 增加 `AgentTeamRun.planFile?: string | null`。
- 调整 route schema。
- 调整前端 service payload。

验证：

```bash
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/backend typecheck
pnpm --filter @runweave/frontend typecheck
```

### 2. 去掉 route 内强制 clarify 语义

- 启动文案改为提交任务。
- `startRun` 不再写“需求澄清” clarify message。
- `buildStartupPrompt` 拆分：
  - 普通任务无需主 Agent 澄清 prompt。
  - plan loop 使用 plan/plan_review worker prompt。
  - proposal 可以由 backend 生成默认提案，或保留“主 Agent 生成提案”的后续入口。

验证：

- 创建无 `planFile` 的 run 后，不出现“需求澄清” UI。
- 右侧进入 proposal 或等待 proposal 的明确状态。

### 3. 实现 plan review worker 启动

- `planFile` 存在时创建 `plan` 和 `plan_review` worker。
- split 出两个 pane。
- 先向 `plan_review` 注入审查 prompt。
- `plan` pane 可以先启动但等待修复 prompt；也可以只在 fail 后启动，推荐首期一起启动，便于固定 pane 绑定和 outbox 路径。

验证：

- 带 `planFile` 创建 run 后，能看到 `plan` 与 `plan_review` panes。
- `plan_review` prompt 中包含 `task`、`planFile`、outbox path、evidence schema。

### 4. 实现 plan_review fail → plan fix

- 读取 `plan_review` outbox。
- fail case 达到 stable threshold 后，调用 `bounceFailuresToPlan`。
- `plan` worker 收到修复 prompt，修复计划文件。
- 记录 `bouncedToPanelId` 为 plan worker panel。

验证：

- 构造 `plan_review` fail outbox 后，不进入 `need_human`，不进入 executing。
- UI 显示失败证据和“已抛回 plan worker 修复”。

### 5. 实现 plan fix completion → plan_review recheck

- `plan` worker completion 后，重新触发 `plan_review`。
- recheck 只发给 `plan_review` worker。
- watchdog 继续生效。

验证：

- `plan` completion 后，`plan_review` 收到复审 prompt。
- 复审通过后进入 proposal。

### 6. plan_review pass 后进入 proposal/split

- 计划审查通过时生成执行 worker proposal。
- 默认执行 workers 仍为 `code`、`code_review`、`behavior_verify`。
- proposal 卡展示计划文件已通过审查。

验证：

- `plan_review pass` 后不会直接开始 code。
- 用户确认 proposal 后才进入 executing。

### 7. UI 收口与文案

- `PlanReviewSection` 展示计划文件、审查结果、修复 loop 状态。
- 熔断时显示“计划修复无进展”，不是泛化的“执行无进展”。
- 完成后下游仍读取 `status=done`。

验证：

- 无计划文件任务不出现计划审查 UI。
- 有计划文件任务在 pass 前不出现 code execution 状态。

## 验收标准

1. `POST /api/agent-team/runs` 不传 `planFile` 时，行为等同普通任务：进入 proposal/split/executing，不启动 `plan_review`。
2. `POST /api/agent-team/runs` 传 `planFile` 时，run 持久化 `planFile`，并进入计划审查 loop。
3. `plan_review fail` 不进入 executing，不设置人工阻塞；失败证据会抛给 `plan` worker。
4. `plan` worker 完成后自动触发 `plan_review` 复审。
5. `plan_review pass` 后进入 proposal，用户确认后才 split 执行 workers。
6. 多轮 plan review/fix 无进展后才升级人工。
7. evidence UI 继续使用人类可读 `label/summary/ref` schema。
8. 不新增单元测试文件。

## 验证方式

静态验证：

```bash
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/shared lint
pnpm --filter @runweave/backend typecheck
pnpm --filter @runweave/backend lint
pnpm --filter @runweave/frontend typecheck
pnpm --filter @runweave/frontend lint
```

浏览器验收必须使用 `$playwright-cli`：

1. 普通任务：不填计划文件，启动后不出现 plan review UI。
2. 带计划文件任务：填写 `docs/plans/...md`，启动后出现 plan review UI 和 `plan/plan_review` panes。
3. 构造 plan_review fail：确认 UI 显示审查失败并自动抛回 plan worker。
4. 构造 plan worker completion：确认自动触发 plan_review recheck。
5. 构造 plan_review pass：确认进入 proposal，未直接进入 executing。
6. 确认 proposal 后进入 executing，behavior_verify evidence UI 正常。

## 风险点

- 现有 `clarify` phase 已经写进 run schema 和 UI，移除时要避免半残留文案造成用户误解。
- `plan_review pass` 不能复用现有 `allAcceptancePassed → done` 逻辑，否则计划审查通过会错误结束整个 run。
- `plan_review fail` 不能复用现有 `bounceFailuresToCode`，否则会把计划问题发给 code worker。
- `planFile` 作为用户输入路径，首期只作为引用传给 worker；如果未来 backend 要读取文件，必须补路径边界和 project root 限制。
- 计划 loop 与执行 loop 共用 no-progress 计数时，要在进入 proposal/executing 前重置或切换上下文，否则计划阶段失败可能污染执行阶段熔断。
