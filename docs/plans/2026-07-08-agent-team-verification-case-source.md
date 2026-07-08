# Agent Team 验证用例来源改造计划

## 背景

当前 Agent Team 的 `behavior_verify` 用例来源不够可追溯：没有显式传入 `acceptance` 时，后端会使用两条泛化默认用例：

1. `核心改动按任务目标落地，页面/行为符合预期`
2. `关键回归用例通过，无明显破坏`

如果存在 `code_review` worker，后端再追加一条 code review gate 用例。这个默认路径能让流程跑起来，但不能保证验证目标来自用户确认过的计划或测试案例文件。

本计划把验证入口改成“计划文件 / 测试案例文件”两字段，并让测试案例文件成为最高优先级验收合同。

## 当前代码事实

- Agent Team 前端入口在 `frontend/src/components/terminal/terminal-agent-team-panel.tsx`。
- proposal 展示在 `frontend/src/components/terminal/terminal-agent-team-panel-sections.tsx`，当前只展示验收用例草案，不支持编辑 acceptance。
- 前端 `startAgentTeamRun()` 调用 `POST /api/agent-team/runs`，当前 payload 只有 `projectId`、`terminalSessionId`、`task`、`options`、`terminal`。
- 后端路由在 `backend/src/routes/agent-team.ts`，`createRunSchema` 当前不接收计划文件或测试案例文件。
- 后端 `backend/src/agent-team/service.ts` 中：
  - `startRun()` 调用 `normalizeAcceptance(undefined)` 生成默认 acceptance。
  - `proposeSplit()` / `submitSplitGate()` 可接收 `acceptance`，但当前 UI 确认拆分时只提交 worker 草案。
  - `acceptanceCasesForRole()` 会把非 code review 用例交给 `behavior_verify`。
- worker prompt 在 `backend/src/agent-team/prompt-builders.ts` 构造，`behavior_verify` 只执行传入的 acceptance，不负责生成测试案例。

## 目标

1. Agent Team 启动界面新增两个输入字段：
   - `计划文件`
   - `测试案例文件`
2. 如果提供测试案例文件，系统基于该文件拆分 `behavior_verify` acceptance case。
3. 如果没有测试案例文件，但提供计划文件，由主 Agent 使用测试用例生成技能产出测试案例文件，再基于生成文件拆分 acceptance。
4. 如果两个文件都没有，由主 Agent 使用测试用例生成技能从任务描述生成测试案例文件，再基于生成文件拆分 acceptance。
5. `behavior_verify` 只执行已落盘、可追溯的测试案例；没有可追溯测试案例时不进入执行验收。
6. 修复后重跑采用“失败点恢复 + 影响面补跑”，不默认全量重跑。
7. 实现完成后必须跑一个真实闭环场景，证明 agent worker 能按新规则真实执行，而不是只靠 mock、手写 outbox 或 API 直写 acceptance。

## 非目标

- 不在本轮引入复杂 DSL 或完全自动化 Playwright 脚本生成。
- 不要求 backend 直接调用模型或 Codex skill。
- 不新增单元测试文件。
- 不改 `code -> code_review -> behavior_verify` 串行门禁顺序。
- 不保留后端默认 acceptance 作为运行时路径；迁移后 `normalizeAcceptance(undefined)` 不应产生可执行验收用例。
- 不接受 mock worker、手写 outbox、伪造 completion、直接调用 `/round` 写结果作为本计划的最终验收。

## 用户可见行为

### 启动面板

在 Agent Team 开启流程区域增加两个可选文本输入：

- `计划文件`：例如 `docs/plans/2026-07-07-terminal-floating-composer.md`
- `测试案例文件`：例如 `docs/testing/terminal-floating-composer-test-cases.md`

字段规则：

- 支持项目内相对路径。
- 可以接受绝对路径，但必须解析到当前项目目录下。
- 测试案例文件优先级高于计划文件。
- 如果路径不存在，启动流程应阻止，并展示明确错误，不进入 worker split。

### Proposal / Executing 面板

proposal 和 executing 中展示 acceptance 来源：

- `来源：测试案例文件 docs/testing/...`
- `来源：计划文件生成 docs/testing/...`
- `来源：任务描述生成 docs/testing/...`

每条 acceptance 显示原始 case ID，例如 `AGT-VERIFY-001`，而不是只显示 `case_1`。

## 核心业务规则

### 用例来源优先级

1. `测试案例文件` 存在：读取文件，将其中可执行 case 拆成 acceptance。
2. `测试案例文件` 为空但 `计划文件` 存在：主 Agent 使用 `$toolkit:write-test-cases` 基于计划文件生成 `docs/testing/<主题>-test-cases.md`，再拆成 acceptance。
3. 两者都为空：主 Agent 使用 `$toolkit:write-test-cases` 基于任务描述生成测试案例文件，再拆成 acceptance。
4. 技能生成失败或没有产出可解析 case：阻止进入 worker split / `behavior_verify`，UI 和 run logs 显示“缺少可追溯测试案例文件”，不生成默认 acceptance。

### 测试案例文件格式

优先支持现有 `docs/testing/*-test-cases.md` 风格：

```md
### AGT-VERIFY-001 标题

步骤：

1. ...

期望：

- ...

失败判定：

- ...
```

解析规则：

- 识别三级标题中的 case ID：`[A-Z][A-Z0-9-]*-\d{3}`。
- 每个 case 转为一个 acceptance。
- acceptance 文案必须包含标题、关键步骤摘要、期望和失败判定摘要。
- 原始 case ID 保留在 acceptance 的 `caseId` 或新增 `sourceCaseId` 字段中。

### 修复后重跑策略

`behavior_verify` 首轮按测试案例顺序执行。遇到阻断失败可以停止，并把失败 case、失败步骤、证据写入 outbox。

code 修复后，重新触发 `behavior_verify` 时默认重跑：

1. 上轮失败 case。
2. 上轮未执行 case。
3. 与本轮代码 diff 影响面匹配的已通过 case。
4. 失败 case 的依赖 case 或最近 checkpoint case。

默认不重跑：

- 已通过、无依赖、且不在本轮 diff 影响面内的 case。

如果无法判断影响面，或者修复涉及全局状态、认证、session 生命周期、terminal 输入协议、路由、存储迁移，则允许全量重跑，但 verifier 必须在 outbox 中写明原因。

## 数据结构建议

在 `packages/shared/src/agent-team.ts` 增加 verification 配置：

```ts
export type AgentTeamAcceptanceSource =
  | "test_case_file"
  | "plan_file_generated"
  | "task_generated";

export interface AgentTeamVerificationConfig {
  planFilePath?: string | null;
  testCaseFilePath?: string | null;
  generatedTestCaseFilePath?: string | null;
  acceptanceSource: AgentTeamAcceptanceSource;
}
```

在 `AgentTeamAcceptanceCase` 中增加可选来源字段：

```ts
sourceCaseId?: string | null;
sourceFilePath?: string | null;
sourceHeading?: string | null;
tags?: string[];
dependsOn?: string[];
lastRunStatus?: "pass" | "fail" | "skipped" | "pending";
skipReason?: string | null;
```

在 `CreateAgentTeamRunRequest` 中增加：

```ts
planFilePath?: string | null;
testCaseFilePath?: string | null;
```

## 文件范围

共享类型：

- `packages/shared/src/agent-team.ts`

后端：

- `backend/src/routes/agent-team.ts`
  - 扩展 create/propose/split schema。
- `backend/src/agent-team/service.ts`
  - 保存 verification config。
  - 基于测试案例文件或生成结果构建 acceptance。
  - 移除运行时默认 acceptance 生成路径；没有可追溯 case 时返回可解释错误或停留在生成阶段。
  - recheck prompt 中携带重跑范围。
- `backend/src/agent-team/prompt-builders.ts`
  - 向主 Agent prompt 注入计划/测试案例文件路径。
  - 向 `behavior_verify` prompt 注入来源、case ID、跳过/重跑规则。
- 新增 `backend/src/agent-team/acceptance-case-loader.ts`
  - 解析 Markdown 测试案例文件。
  - 校验路径位于 project root 内。
  - 生成 `AgentTeamAcceptanceCase[]`。

前端：

- `frontend/src/components/terminal/terminal-agent-team-panel.tsx`
  - 管理计划文件和测试案例文件输入状态。
  - `startAgentTeamRun()` payload 带上两个路径。
- `frontend/src/components/terminal/terminal-agent-team-panel-sections.tsx`
  - 启动区域新增两个字段。
  - proposal/executing 显示 acceptance 来源和原始 case ID。
- `frontend/src/services/terminal.ts`
  - DTO 跟随 shared 类型。

文档和测试用例：

- `docs/testing/agent-team-verification-case-source-test-cases.md`

## 实施步骤

### 1. 类型和 API 接口

1. 扩展 shared DTO 和 run 数据模型。
2. 扩展 `createRunSchema`，接收 `planFilePath` / `testCaseFilePath`。
3. 路由层只做类型校验，路径存在性和项目内约束由 service 统一处理。

验证：

- `pnpm --filter ./packages/shared typecheck`
- `pnpm --filter ./backend typecheck`

### 2. 前端输入和展示

1. 在启动面板增加两个字段。
2. 启动请求携带字段值。
3. proposal/executing 显示 acceptance 来源。
4. 若后端返回路径错误，展示错误，不清空用户输入。

验证：

- `$playwright-cli` 打开 Web terminal，确认两个字段可输入、错误可见、成功启动后来源展示正确。
- `pnpm --filter ./frontend typecheck`
- `pnpm --filter ./frontend lint`

### 3. Markdown 测试案例解析

1. 新增 case loader。
2. 支持现有三级标题 case ID 格式。
3. 将标题、步骤、期望、失败判定压缩为 acceptance 文案。
4. 空文件、无 case ID、路径越界、文件不存在均返回明确错误。

验证：

- 使用 `docs/testing/agent-team-verification-case-source-test-cases.md` 作为输入。
- 启动 Agent Team 后右侧显示对应 case ID。
- 不提供可解析 case 时，不创建可执行 acceptance。

### 4. 技能驱动生成测试案例

1. 当没有测试案例文件时，主 Agent prompt 明确要求调用 `$toolkit:write-test-cases`。
2. 如果有计划文件，技能输入为计划文件。
3. 如果没有计划文件，技能输入为用户 task。
4. 生成文件必须落在 `docs/testing/`，并回填到 run 的 `generatedTestCaseFilePath`。
5. 后端只消费落盘后的测试案例文件，不直接调用模型。
6. 如果生成失败，流程停在需要人工处理的状态，不进入 worker split。

验证：

- 只填计划文件，主 Agent 生成测试案例文件，proposal/executing 来源显示 `plan_file_generated`。
- 两个字段都不填，主 Agent 生成测试案例文件，来源显示 `task_generated`。

### 5. behavior_verify 重跑策略

1. outbox 支持表达 `skipped` 或保留 `pending` + `skipReason`。
2. recheck prompt 携带：
   - 上轮失败 case。
   - 未执行 case。
   - 已通过 case 列表。
   - 本轮 diff 摘要。
   - 建议重跑范围和允许扩大的规则。
3. verifier 必须在 outbox 中说明跳过哪些已通过 case、为什么跳过。

验证：

- 制造一个中途失败 case，修复后只重跑失败/未执行/影响面 case。
- UI 能显示 skipped 或 pending-with-reason，不把未重跑误判为失败。

### 6. 真实闭环场景验收

实现完成后必须至少跑通一个真实场景，优先使用当前项目 worktree；如当前项目环境不可用，可用临时 mock project，但必须走真实 Runweave UI 和真实 worker pane。

推荐场景 A：当前项目 worktree

1. 基于当前仓库创建独立 worktree，例如 `../browser-viewer-agent-team-verification-dogfood`。
2. 在该 worktree 中准备一个小而真实的需求，例如修改一个 `docs/prototypes/*` 页面上的可见交互文案或状态展示。
3. 为该需求准备测试案例文件，至少包含 3 条 case：
   - 一条会通过的主路径。
   - 一条先失败、需要 code worker 修复后重跑的路径。
   - 一条已通过且修复后不需要重跑的独立路径。
4. 启动真实 Runweave Web，打开该 worktree 对应 project 的 terminal。
5. 通过 Agent Team UI 填写任务、计划文件或测试案例文件，启动真实流程。
6. 让 code worker 真正修改 worktree 文件。
7. 让 code_review worker 真正审查。
8. 让 behavior_verify worker 用 `$playwright-cli` 打开真实页面并写出 pane-scoped outbox。
9. 修复失败 case 后，确认 recheck 只重跑失败、未执行、依赖或影响面 case。

推荐场景 B：临时 mock project

1. 创建一个最小 Vite/静态 HTML 项目，放在临时目录并注册为 Runweave project。
2. 准备测试案例文件，要求修改页面上的真实可见行为。
3. 通过真实 Agent Team UI 跑完整 `code -> code_review -> behavior_verify` 流程。

禁止作为通过依据：

- 手动写 `.runweave/outbox/*.json` 代替 worker 产出。
- 直接调用 `/api/agent-team/runs/:runId/round` 代替 completion/outbox 回流。
- 伪造 terminal completion 事件。
- 只读取 run JSON 或只跑静态检查。
- 只验证 case parser，不让真实 agent worker 执行需求。

验收证据必须包含：

- worktree 或 mock project 路径。
- 真实 Runweave URL、`projectId`、`terminalSessionId`、`runId`。
- Agent Team UI 截图或 DOM。
- code / code_review / behavior_verify 三个 worker pane 的真实 prompt 和结果片段。
- 实际 git diff。
- behavior_verify 的 Playwright 截图、DOM/API 证据和 pane-scoped outbox。
- 修复后重跑范围说明，包含跳过已通过 case 的理由。

## 验收标准

配套测试用例见 `docs/testing/agent-team-verification-case-source-test-cases.md`。本计划通过需要同时满足：

1. 启动界面有 `计划文件` 和 `测试案例文件` 两个字段。
2. 测试案例文件存在时，acceptance 来自该文件，并保留原始 case ID。
3. 没有测试案例文件时，主 Agent 通过 `$toolkit:write-test-cases` 生成文件，再生成 acceptance；生成失败则阻断执行。
4. `behavior_verify` prompt 明确列出来源文件、case ID、证据要求。
5. 修复后重跑不是默认全量，而是按失败点、未执行项、依赖和影响面决定范围。
6. 任一路径错误都阻止启动，并给出明确错误。
7. 至少一个真实闭环场景通过，且证据来自真实 Runweave UI、真实 worker pane、真实文件 diff 和真实 Playwright 行为验证。
8. `pnpm typecheck`、`pnpm lint`、`git diff --check` 通过；浏览器行为验收必须用 `$playwright-cli` 取证。

## 风险与约束

- Markdown case 解析不能过度依赖单一格式；先支持现有 `docs/testing` 主流格式，再逐步扩展。
- backend 不应直接调用模型或 skill，否则会把终端可见工作流变成不可观测后台智能行为。
- 如果生成测试案例文件后用户没有确认，验收合同可能仍不可靠；建议 proposal 阶段展示生成文件路径和 case 列表。
- 路径校验必须防止读取项目外任意文件。
- 删除默认 acceptance 后，必须保证“生成测试案例失败”有清晰错误和恢复入口，否则用户会卡在无 worker split 的状态。
- 真实闭环场景会消耗更多时间，但这是证明 agent 能按流程执行的必要成本；不能为了提速降级为 mock outbox 或手工回填结果。
