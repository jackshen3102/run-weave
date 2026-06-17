# Do-A-IDEM 基础流程与角色计划

- 日期: 2026-06-17
- 状态: 计划中（仅计划，尚未编码）
- 关键词: Do-A-IDEM, role defaults, human gate, finalize, multi-agent orchestrator

## 1. 背景

当前 Runweave 已有通用多 Agent 编排底座：

- `packages/shared/src/orchestrator.ts` 定义了 run、roles、goals、timeline、humanInbox 等通用协议。
- `backend/src/orchestrator/service.ts` 已支持创建 run、派发 goal、接收 worker completion、读取 outbox 并把结果回灌到主 Agent。
- `frontend/src/components/terminal/terminal-orchestrator-panel.tsx` 已有 Orchestrator 配置态和运行监控态。
- `docs/plans/2026-06-13-multi-agent-orchestrator.md` 已明确底层形态：常驻主 Agent 终端 + 薄结果路由器 + worker 终端。

现有 `OrchestratorRunPackage` 只有 `status`、`goals`、`timeline`、`humanInbox` 等字段，没有机器可读的“当前阶段”。如果只靠主 Agent 记忆和 timeline 文本，UI 无法稳定判断当前是 `human_plan_approval` 还是 `human_verify`，后端也无法阻止跳过人工验收直接进入 `finalize`。

首期不引入可选 workflow template，也不新增完整 phase instance 状态机；但必须新增一个最小 `currentPhase` 字段，用来承载当前 Do-A-IDEM 阶段。然后把基础流程跑顺，并把默认 worker 角色替换成 Plan Review、Code、Code Review 等更贴近该流程的角色。

## 2. 核心结论

### 2.1 首期不做可选 Workflow Template

首期目标是把基础功能做好，不做模板选择器，不做多套流程模板，也不在 UI 里暴露 `small-change`、`review-only`、`docs-only` 等选项。

首期只内置一条默认 Do-A-IDEM 基础流程，由主 Agent 的启动提示语、默认角色和人工门禁操作共同约束：

```text
discuss
→ plan
→ plan_review
→ human_plan_approval
→ code
→ code_review
→ human_verify
→ finalize
→ done
```

后续如果需要支持多流程，再把这条默认流程抽成可选 Workflow Template。

### 2.2 基础流程不关心 Agent 内部执行细节

Do-A-IDEM 流程只关心阶段边界、人工门禁和 Agent/Worker 的最终总结，不关心每个 Agent 或 Worker 在终端里如何拆解、如何执行、执行了哪些内部步骤。

首期继续保留现有 `goals[]`，但它只是兼容当前 Orchestrator 数据模型和运行记录，不作为 Do-A-IDEM 流程语义的一部分。Agent/Worker 是黑盒；流程层只消费它回传的 `summary`。

### 2.3 首期必须有 currentPhase

首期不做完整阶段状态机，但必须在 run 上有一个机器可读字段：

```ts
type DoAIdemPhase =
  | "discuss"
  | "plan"
  | "plan_review"
  | "human_plan_approval"
  | "code"
  | "code_review"
  | "human_verify"
  | "finalize"
  | "done";

interface OrchestratorRunPackage {
  currentPhase?: DoAIdemPhase | null;
  humanGateVerdicts?: HumanGateVerdict[];
}

interface HumanGateVerdict {
  id: string;
  phase: "human_plan_approval" | "human_verify";
  verdict: "approved" | "rejected";
  reason: string | null;
  at: string;
}
```

`currentPhase` 只回答“当前流程卡在哪一步”，不记录每个阶段的内部过程，不保存 Agent/Worker 产物，也不替代主 Agent 决策。

人工门禁的最小规则：

- `currentPhase=human_plan_approval` 时，run 应进入 `status=need_human`，UI 展示计划审批操作。
- `currentPhase=human_verify` 时，run 应进入 `status=need_human`，UI 展示人工验收操作。
- 人工门禁结论必须结构化写入 `humanGateVerdicts[]`，不能只靠 `injectPrompt` 自由文本。
- `rejected` 必须带 `reason`，用于 UI 后续稳定展示“为什么拒绝”。
- 只有在 `currentPhase=human_verify` 时收到明确的人工“通过验收”动作，后端才允许把 `currentPhase` 改为 `finalize`。

这样门禁不再只是 prompt 建议，而是有最小后端约束。

### 2.4 非人工阶段由后端按固定规则自动推进

采用方案 A：主 Agent 不直接写 `currentPhase`，也不新增 agent-facing orchestrator CLI。后端根据已有 dispatch / worker result / human gate 事件按固定规则推进阶段。

这不是智能决策：后端不判断 Agent 输出内容好坏，只根据“哪个角色的 worker result 已回到 run”推进固定流程。

首期固定规则：

- run 创建后初始化为 `currentPhase=plan`。
- 主 Agent 派发 `plan_reviewer` 后，后端把 `currentPhase` 推进到 `plan_review`。
- `plan_reviewer` 的 worker result 回到 run 后，后端把 `currentPhase` 推进到 `human_plan_approval`，并设置 `status=need_human`。
- Human Plan Approval 通过后，human gate API 把 `currentPhase` 推进到 `code`，并恢复 `status=running`。
- 主 Agent 派发 `code_agent` 后，后端保持或设置 `currentPhase=code`。
- `code_agent` 的 worker result 回到 run 后，后端把 `currentPhase` 推进到 `code_review`。
- `code_reviewer` 的 worker result 回到 run 后，后端把 `currentPhase` 推进到 `human_verify`，并设置 `status=need_human`。
- Human Verify 通过后，human gate API 把 `currentPhase` 推进到 `finalize`，并恢复 `status=running`。
- finalize 完成后进入 `done`。

如果 worker result 的 `role` 不是上述内置 Do-A-IDEM 角色，后端不自动推进阶段，只记录 summary 和 timeline。

### 2.5 finalize 合并 commit / submit / done

`commit`、`submit`、`done` 不应建成三个独立 worker 阶段。它们属于同一个收尾阶段：

```text
finalize
  - 在一个终端里完成提交和提交结果记录
  - 成功后标记 run done
```

`finalize` 可以由主 Agent 在自己的终端完成，也可以由用户指定一个终端或 commit agent 完成。关键约束是：只有 `human_verify` 通过后才能进入 `finalize`。

### 2.6 human_verify 是人工验收门禁，不是 Agent 自动工作阶段

`human_verify` 的作用是把最终质量责任交给人确认，防止 Code Review 完成后系统自动提交。

人在这一阶段做：

- 查看各 Agent/Worker 回传的 summary。
- 做必要的端到端验证，例如打开 Web/Electron/App、跑浏览器流程、检查 UI 或真实功能。
- 给出验收结论：通过、不通过、补充验证或提问。

Agent 在这一阶段只做辅助：

- 汇总本次改动、验证结果和残余风险。
- 给出建议人工验证项。
- 等待人工结论。
- 如果人工不通过，把反馈转成下一轮 `code` 或 `code_review` 任务。
- 如果人工通过，进入 `finalize`。

因此 `human_verify` 不应设计成简单“下一步”按钮，而应设计成“人工验收结论输入点”。

## 3. 首期基础流程

首期默认流程：

```text
discuss
→ plan
→ plan_review
→ human_plan_approval
→ code
→ code_review
→ human_verify
→ finalize
→ done
```

说明：

- `discuss`: 用户和主 Agent 澄清需求。可发生在 Orchestrator run 之前，也可作为 run 的第一阶段记录。
- `plan`: 主 Agent / Plan Agent 形成计划总结。
- `plan_review`: Plan Review Agent 审查计划，返回 review summary。
- `human_plan_approval`: 人工确认计划是否可执行。
- `code`: Code Agent 执行任务并返回 summary。
- `code_review`: Code Review Agent 审查主 Agent 指定的内容并返回 summary。
- `human_verify`: 人工端到端验收，输入通过/不通过/补充验证结论。
- `finalize`: 在一个终端里完成 commit、submit、done 收尾。
- `done`: run 进入完成态，不再派发后续工作。

## 4. 阶段规则

### 4.1 discuss

- 关注点：用户原始需求、主 Agent 与用户的澄清记录。
- 结果：需求总结。
- 通过条件：主 Agent 判断需求足以写计划，或用户明确要求直接写计划。
- 回退：用户继续补充需求。

### 4.2 plan

- 执行者：主 Agent 或 Plan Agent。
- 结果：计划 summary。
- 通过条件：主 Agent 认为计划足以进入审查。
- 回退：如果 Plan Review 或人工审批提出修改意见，回到本阶段修订计划。

### 4.3 plan_review

- 执行者：Plan Review Agent。
- 结果：review summary。
- 通过条件：主 Agent 根据 review summary 判断可以进入人工审批。
- 回退：如果 review summary 表示需要修改，回到 `plan`。

### 4.4 human_plan_approval

- 执行者：人工。
- 关注点：计划 summary 和 review summary。
- 结果：人工审批结论。
- 通过条件：人工点击通过，或输入明确的批准指令。
- 回退：人工拒绝或要求修改时，回到 `plan`。

### 4.5 code

- 执行者：Code Agent。
- 结果：实现 summary。
- 通过条件：主 Agent 根据 Code Agent summary 判断可以进入 Code Review。
- 回退：Code Review 或 Human Verify 不通过时，回到本阶段修复。

### 4.6 code_review

- 执行者：Code Review Agent。
- 结果：review summary。
- 通过条件：主 Agent 根据 review summary 判断可以进入人工验收。
- 回退：如果 review summary 表示需要修改，回到 `code`。

### 4.7 human_verify

- 执行者：人工，Agent 只辅助。
- 关注点：各阶段 summary、Code Review summary、运行中的应用或真实环境。
- 结果：人工验收结论。
- 通过条件：人工明确通过。
- 回退：人工不通过时，带原因回到 `code`；如果只是要求重新审查，可回到 `code_review`。

建议 UI 操作：

```text
[通过，进入提交]
[不通过，返回修改]
[补充验证/提问]
```

人工不通过时必须记录原因，例如：

```text
移动端打开终端后 composer 遮挡底部 tab，需要修复后再验证。
```

### 4.8 finalize

- 执行者：主 Agent、指定终端或 commit agent。
- 关注点：人工验收通过结论和提交要求。
- 结果：finalize summary。
- 通过条件：提交/推送/提交变更动作成功，并返回 summary。
- 回退：提交失败时停在 `finalize`，由同一个终端修复提交问题；如果发现产品问题，回到 `code`。

约束：

- 该阶段不再启动新的 review 闭环，除非提交失败暴露出代码问题。
- 不建议由后端直接执行 Git；优先向主 Agent 或指定终端发送提交任务，由 Agent 完成 commit/submit。

### 4.9 done

- 执行者：系统状态更新。
- 关注点：`finalize` 成功 summary。
- 结果：run 状态为 `done`。
- 通过条件：最终 summary 可追踪。

## 5. 数据结构建议

### 5.1 首期新增 currentPhase，但不做 phaseInstances

首期不要在 `OrchestratorRunPackage` 上新增 `workflowTemplateId`、`phaseInstances` 或可选模板定义。只新增最小 `currentPhase`：

```ts
export type DoAIdemPhase =
  | "discuss"
  | "plan"
  | "plan_review"
  | "human_plan_approval"
  | "code"
  | "code_review"
  | "human_verify"
  | "finalize"
  | "done";

export interface OrchestratorRunPackage {
  currentPhase?: DoAIdemPhase | null;
  humanGateVerdicts?: HumanGateVerdict[];
}

export interface HumanGateVerdict {
  id: string;
  phase: "human_plan_approval" | "human_verify";
  verdict: "approved" | "rejected";
  reason: string | null;
  at: string;
}
```

继续复用现有字段：

- `roles[]`: 本次 run 可用 worker 角色。
- `goals[]`: 兼容现有 Orchestrator 运行记录；不作为 Do-A-IDEM 流程语义。
- `timeline[]`: 记录派发、worker result、人工注入和状态变化。
- `humanInbox[]`: 记录人工给主 Agent 的指令。
- `humanGateVerdicts[]`: 记录人工门禁结论；这是 UI 展示审批/验收结果的结构化来源。

`currentPhase` 是唯一的流程阶段来源。timeline 只做审计记录，不承担流程状态。
`injectPrompt` 继续用于给主 Agent 发送补充说明，不承担人工门禁 verdict 的持久化。

### 5.2 默认角色替换

当前默认角色是 `coder`、`reviewer`、`tester`。首期改为更贴近 Do-A-IDEM 的角色集合：

```ts
const DEFAULT_ROLES = [
  {
    id: "plan_reviewer",
    name: "计划审查",
    terminal: { command: "codex", args: [] },
    prompt:
      "你是 Plan Review Agent。审查主 Agent 给出的计划，并只返回 summary。流程层不会关心你的内部执行细节。",
  },
  {
    id: "code_agent",
    name: "代码执行",
    terminal: { command: "codex", args: [] },
    prompt:
      "你是 Code Agent。按主 Agent 指令完成实现，并只返回 summary。不要接管主控流程。",
  },
  {
    id: "code_reviewer",
    name: "代码审查",
    terminal: { command: "codex", args: [] },
    prompt:
      "你是 Code Review Agent。审查主 Agent 指定的内容，并只返回 summary。流程层不会关心你的内部执行细节。",
  },
];
```

说明：

- Plan Agent 首期由主 Agent 承担，不单独作为 worker 默认角色。
- `tester` 首期不作为默认角色保留；测试/验证属于 Code Agent 的黑盒内部行为，流程层只消费 summary。
- 后续如果需要专门测试 worker，再新增 `test_agent`，不要在首期扩大范围。

### 5.3 Summary

首期流程层只消费 Agent/Worker 回传的 `summary`，不定义也不读取其他输出内容。

## 6. API 和服务层计划

### 6.1 shared 协议

文件范围：

- `packages/shared/src/orchestrator.ts`

计划：

- 保留现有 `goals[]`，不要把它删除或替换。
- 新增 `DoAIdemPhase` 和 `OrchestratorRunPackage.currentPhase?: DoAIdemPhase | null`。
- 新增 `HumanGateVerdict` 和 `OrchestratorRunPackage.humanGateVerdicts?: HumanGateVerdict[]`。
- 首期不新增额外输出 schema。
- 如需要统一 worker 结果，只保留 `summary` 字段作为流程层消费对象。

验证：

- `pnpm --filter ./packages/shared typecheck`

### 6.2 后端默认角色和基础门禁

文件范围：

- `backend/src/orchestrator/service.ts`
- 可新增 `backend/src/orchestrator/workflow/*`
- `backend/src/routes/orchestrator.ts`

计划：

- 替换 `DEFAULT_ROLES`，把当前 `coder/reviewer/tester` 改为 `plan_reviewer/code_agent/code_reviewer`。
- 调整主 Agent startup prompt，明确首期基础流程和各角色用途。
- 新增后端内部 `advanceCurrentPhaseForEvent(run, event)` 一类确定性推进逻辑；不暴露 agent-facing `setRunPhase`。
- 新增最小人工门禁 API，例如 `POST /api/orchestrator/runs/:runId/human-gate`：
  - body: `{ phase, verdict, reason? }`
  - `phase` 必须等于当前 `currentPhase`。
  - `rejected` 必须带非空 `reason`。
  - `approved + human_verify` 推进到 `finalize`。
  - `approved + human_plan_approval` 推进到 `code`。
  - `rejected + human_plan_approval` 回退到 `plan`。
  - `rejected + human_verify` 回退到 `code`。
- “补充验证/提问”不是 verdict，继续使用 `injectPrompt`，不写入 `humanGateVerdicts[]`。
- 后端只做确定性门禁校验，不做智能判断：
  - 非人工阶段根据 dispatch / worker result 的固定规则推进 `currentPhase`。
  - 进入 `human_plan_approval` 或 `human_verify` 时同步设置 `status=need_human`。
  - 人工拒绝时按当前 phase 回退到 `plan` 或 `code`。
  - 进入 `finalize` 只能由人工验收通过动作触发。
  - `done` 只能从 `finalize` 进入。
- 后端不做智能判断；主 Agent 根据 summary 和人工输入决定下一步。

验证：

- `pnpm --filter ./backend typecheck`
- `pnpm --filter ./backend lint`
- 使用真实 API 冒烟创建 run，确认 `currentPhase` 初始化、人工门禁 phase、默认角色和 startup prompt 符合 Do-A-IDEM 基础流程。

### 6.3 前端 Orchestrator 面板

文件范围：

- `frontend/src/components/terminal/terminal-orchestrator-panel.tsx`
- `frontend/src/services/terminal.ts`

计划：

- 配置态暂不增加 workflow template 选择。
- 默认展示新的 Do-A-IDEM 角色，并允许用户选择/复用终端。
- 运行态用 `currentPhase` 渲染当前阶段，不从 timeline 文本推断阶段。
- Human gate 阶段展示明确操作：
  - Plan 审批：通过 / 拒绝并要求修订。
  - Human Verify：通过进入提交 / 不通过返回修改 / 补充验证。
  - 拒绝时原因输入必填，并通过 human gate API 写入 `humanGateVerdicts[]`。
  - “补充验证/提问”继续走 `injectPrompt`，不写入 `humanGateVerdicts[]`。
- 首期不做额外面板；流程层只展示 summary 和 timeline。

验证：

- `pnpm --filter ./frontend typecheck`
- 涉及浏览器操作时使用 `$playwright-cli` 验证配置态、运行态和 human gate 操作。

### 6.4 CLI 边界

文件范围：

- `packages/runweave-cli/src/index.ts`
- `packages/runweave-cli/src/commands/*`
- `packages/runweave-cli/src/client/*`

计划：

- 首期不强制新增 `rw run`。
- 如果后续要给主 Agent 更稳定的流程控制面，可新增 `rw workflow` 或 `rw run` 命令。
- 任何新增 CLI 都应复用现有 auth/base-url/profile 机制。
- 继续保留 `rw terminal send --agent` 作为 worker 派发的基础能力。

验证：

- `pnpm --filter ./packages/runweave-cli typecheck`
- `pnpm --filter ./packages/runweave-cli lint`
- 使用真实 CLI 冒烟验证命令输出和错误码。

## 7. UI 跟踪视图建议

运行态建议分成四块：

1. 当前阶段：读取 `currentPhase`，展示 `discuss -> plan -> plan_review -> human_plan_approval -> code -> code_review -> human_verify -> finalize -> done` 中的当前位置。
2. 当前门禁：如果 `currentPhase` 是 human gate，展示操作按钮和原因输入框。
3. Summary：展示各 Agent/Worker 回传的最终总结。
4. Timeline：保留当前 timeline，记录派发、回灌、人工注入和状态变化。

原则：

- 当前阶段回答“流程现在卡在哪”。
- Summary 回答“各 Agent/Worker 最终给出的结论是什么”。
- Timeline 回答“什么时候发生了什么”。

## 8. 非目标

- 不把 Do-A-IDEM 写死成系统唯一流程。
- 首期不做可选 workflow template 和 template selector。
- 首期不新增完整 phase instance 状态机。
- 不删除现有 `goals[]`。
- 不让后端做智能决策或替代主 Agent。
- 不让 Code Review Agent 自动越过人工验收。
- 不让 `human_verify` 退化成无意义的“下一步”按钮。
- 不默认由后端直接执行 Git commit、push 或 submit。
- 不新增非 E2E 单测文件。

## 9. 分阶段实施建议

### M1: 最小 currentPhase

- 在 `packages/shared/src/orchestrator.ts` 增加 `DoAIdemPhase` 和 `currentPhase`。
- create run 时初始化 `currentPhase=plan`。
- 后端写 run 时持久化 `currentPhase`。

验收：

- 新建 run 返回的 JSON 中包含 `currentPhase`。
- 刷新页面后 `currentPhase` 仍能从 `.runweave/runs/<runId>.json` 恢复。

### M2: 默认角色替换

- 替换 `backend/src/orchestrator/default-roles.ts` 默认角色。
- 主 Agent 默认 startup prompt 说明基础 Do-A-IDEM 流程。
- 角色配置态默认选中 `plan_reviewer/code_agent/code_reviewer`。

验收：

- 新建 run 时默认角色不再是 `coder/reviewer/tester`。
- 主 Agent 启动提示能清楚说明 Plan Review、Code、Code Review 和人工门禁。

### M3: 最小人工门禁

- 进入 `human_plan_approval` / `human_verify` 时设置 `status=need_human`。
- 新增 `humanGateVerdicts[]` 持久化人工结论。
- 新增 human gate API，结构化写入 approved/rejected。
- 补充验证/提问继续走 `injectPrompt`。
- UI 根据 `currentPhase` 渲染对应人工卡点。
- 通过 `human_verify` 后才允许进入 `finalize`。

验收：

- `currentPhase=human_plan_approval` 时 UI 展示计划审批。
- `currentPhase=human_verify` 时 UI 展示人工验收。
- 拒绝操作没有 reason 时，前端禁用提交或后端返回 400。
- 拒绝后 run JSON 中能看到对应 `humanGateVerdicts[]` 记录。
- 未通过 `human_verify` 时，后端拒绝进入 `finalize`。

### M4: 非人工阶段自动推进

- 后端在 dispatch / worker result 处理路径中按固定规则推进 `currentPhase`。
- 派发 `plan_reviewer` 后进入 `plan_review`。
- 收到 `plan_reviewer` summary 后进入 `human_plan_approval`。
- human gate 通过计划后进入 `code`。
- 收到 `code_agent` summary 后进入 `code_review`。
- 收到 `code_reviewer` summary 后进入 `human_verify`。
- 非内置角色的 worker result 不推进阶段。

验收：

- 主 Agent 不需要调用任何 set phase 命令。
- 真实 run 中 `currentPhase` 能随内置角色 dispatch / summary 自动变化。
- 非内置角色完成时只记录 summary，不改变 `currentPhase`。

### M5: Summary 回传

- 通过 prompt 约束各 Agent/Worker 回传清晰 summary。
- timeline 记录 summary 回灌和人工输入。

验收：

- 主 Agent 能基于 summary 决定继续、回退、请求人工或进入下一阶段。
- UI 能看到各 Agent/Worker 的 summary。

### M6: Finalize 收尾阶段

- Human Verify 通过后进入 `finalize`。
- 主 Agent 或指定终端完成 commit/submit/done。
- 记录 finalize summary。

验收：

- `finalize` 在一个终端内完成。
- 成功后 run 状态变为 `done`。
- 失败时停在 `finalize` 或按原因回到 `code`。

## 10. 验证矩阵

| 变更范围          | 验证方式                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------- |
| shared 协议       | 新增 `currentPhase` 后执行 `pnpm --filter ./packages/shared typecheck`                                        |
| backend phase/API | `pnpm --filter ./backend typecheck && pnpm --filter ./backend lint`，再跑真实 API 冒烟                        |
| frontend 面板     | `pnpm --filter ./frontend typecheck`，浏览器验证使用 `$playwright-cli`                                        |
| CLI               | `pnpm --filter ./packages/runweave-cli typecheck && pnpm --filter ./packages/runweave-cli lint`，再跑真实 CLI |
| 端到端流程        | 使用 `$playwright-cli` 执行 Do-A-IDEM 基础流程冒烟                                                            |
| 文档-only 变更    | `git diff --check`                                                                                            |

## 11. 开放问题

这些问题不阻塞第一版计划，但后续模板化前需要产品确认：

1. `discuss` 是否作为正式 phase 落盘，还是只把开始 run 前的沟通结果写入 `task` / `requirement.md`。
2. `finalize` 默认由主 Agent 执行，还是允许用户在 run 配置态指定提交终端。
3. 后续是否需要可选 Workflow Template，以及是否提供 `small-change`、`review-only`、`docs-only` 等轻量模板。
