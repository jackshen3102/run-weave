# Agent Team 证据门禁修复闭环实施计划

## 结论

这次暴露出的核心问题不是“测试必须一次性跑完”，也不是“实现前必须先写完整 invariant matrix”，而是两个更具体的状态机缺口：

1. Code Agent 的修复交接没有证据门禁。当前 bounce prompt 只传失败 case 和 evidence summary，并写着“无需自己重跑审查或验收”；code outbox 只要 `status=completed`，backend 就直接派发 `code_review`。backend 不知道 Code Agent 是否先复现、是否用同一场景验证、是否只做了猜测性修改。
2. 当前自动熔断没有统计“同一验收目标修了多少次”。`noProgressCount` 会被任意 `hadDiff=true` 清零；`recheckAttempt` 只统计 verifier 长时间不更新 outbox 的超时重试。因此它们都不能作为修复重试 M 次后的人工中断条件。

本计划保留现有 fail-fast 和 selective rerun，不要求每轮全量跑完。新增的是“证据合格后才能交给下游门禁”和“按稳定修复目标计数的重试预算”。

## 目标

- behavior 或 runtime review 失败回弹后，Code Agent 在改源码前必须通过真实入口复现；修复后必须原样重跑同一场景。
- 纯结构/Git/静态契约类 review finding 不强行启动真实产品环境，但必须复跑 reviewer 给出的原命令、harness 或提供可复核的静态契约证据。
- backend 只接受结构化且与当前 bounce 对应的修复交接；缺失、过期或阻塞的交接不能推进到 `code_review`。
- 同一修复目标最多允许 3 次 Code Agent 修复交接；第 3 次修复后仍失败则进入 `need_human`。
- 第 2 次及以后处理同一修复目标时，必须先解释上一种修复机制为何失败，并重新判断状态所有权、事件边界和数据模型；不把“又产生了 diff”视为修复进展。
- 保留现有 verifier fail-fast：任一必跑 case 真实失败即可停止，下轮只跑失败、未执行、依赖和受影响范围。

## 非目标

- 不要求首次实现前预先穷举完整 invariant matrix。
- 不把每次 bounce 都扩大为全量测试或完整 48 项 verifier。
- 不用固定函数名或“同一函数修改次数”作为熔断依据；backend 无法可靠证明两次修改是否属于同一机制。
- 不复用 `noProgressCount`、`consecutiveFail` 或 `recheckAttempt` 表达修复次数。
- 不新增单元测试文件，不改动 Agent Team UI。
- 不让 orchestration 正确性依赖某个 agent provider 是否认识 `$toolkit:reproduce-before-fix`；skill 是 Codex 的执行方法，backend 的结构化协议才是 provider-neutral 合约。

## 代码与过程证据

- `backend/src/agent-team/prompt-builders.ts` 的 `buildBounceBackPrompt` 目前只包含 case/evidence，并明确说 Code Agent 无需自己重跑审查或验收，没有区分“自证修复”与“独立门禁复验”。
- `backend/src/agent-team/service-workflow-policy.ts` 的 `shouldDispatchNextSerialWorker` 只检查 code outbox 为 `completed`；`backend/src/agent-team/service-completion.ts` 随后直接派发 `code_review`。
- `packages/shared/src/agent-team.ts` 的 `AgentTeamWorkerOutbox` 没有修复前复现、invariant、同场景回归或受影响检查字段。历史 code outbox 虽然自发写了大量顶层 `evidence`，该字段不属于共享 schema，backend 也不据此做交接判断。
- `backend/src/agent-team/loop.ts` 把 pass 数上升或任意 `hadDiff` 都视为 progress；历史 run `.runweave/agent-team/atr_e6debba5_20260713031055.json` 在 Round 17～27 多次把 `case_14` 抛回 code，日志仍持续为 `noProgress=0/3`。
- `backend/src/agent-team/service-recheck.ts` 的 `MAX_RECHECK_ATTEMPTS=2` 只处理 verifier 未更新 outbox 的超时，不代表 Code Agent 已经修复了两次。
- 历史 review 的多项 P1 都汇总到通用 `case_14`。只按 caseId 计数会把不同 finding 混成一次；只按现有文本 fingerprint 计数又会把同一 invariant 的不同表象拆开。

## 核心设计

### 1. 稳定修复目标 `repairKey`

backend 为每次回弹生成不可由 Code Agent 覆盖的 `repairKey`：

- behavior failure：`behavior_verify:<caseId>`。验收 case 本身就是稳定目标；同一 case 即使症状变化，连续多轮仍未通过也应消耗同一预算。
- code review finding：`code_review:<invariantKey>`。P0/P1 `remainingFindings` 新增必填 `invariantKey` 和 `verificationMode: "runtime" | "structural"`。标题、summary、文件行号变化时，只要违反的是同一 invariant，仍属于同一修复目标。
- 一个 review outbox 有多个阻断 finding 时，生成多个 repairKey；Code Agent 必须逐项交接。

兼容策略：历史 outbox 仍可读取和导出；新 dispatch 的 P0/P1 finding 缺少 `invariantKey` 或 `verificationMode` 时，不回弹 code，先要求 reviewer 修正一次结构化 outbox。仍缺失则 `need_human`，禁止退化为通用 `case_14` 无限循环。

### 2. Code Agent 修复交接协议

在 `AgentTeamWorkerOutbox` 增加 `fixVerifications`，每个当前 repairKey 一项：

```ts
interface AgentTeamFixVerification {
  repairKey: string;
  invariant: string;
  reproduction: {
    mode: "real_product" | "review_harness" | "static_contract";
    status:
      | "reproduced"
      | "confirmed"
      | "not_reproduced"
      | "boundary"
      | "blocked";
    scenarioId?: string | null;
    validationSessionId?: string | null;
    evidence: AgentTeamAcceptanceEvidence[];
  };
  verification: {
    status: "pass" | "fail" | "blocked";
    sameScenario: boolean;
    evidence: AgentTeamAcceptanceEvidence[];
  };
  impactedChecks: Array<{
    label: string;
    dimension:
      | "positive"
      | "negative"
      | "temporal"
      | "concurrent"
      | "regression";
    status: "pass" | "fail" | "skipped";
    summary: string;
    evidence: AgentTeamAcceptanceEvidence[];
  }>;
  strategyAssessment?: string | null;
}
```

业务规则：

- behavior failure 或 `verificationMode=runtime` 的 review finding：bounce prompt 显式要求 Codex worker 调用 `$toolkit:reproduce-before-fix`。无该 skill 的 provider 执行同等协议；backend 只检查 `real_product + reproduced + scenarioId + Before evidence`，不尝试猜测 agent 是否真的调用了技能。
- Runweave runtime 修复还必须记录 `validationSessionId`，并在 `verification` 中提供同一 scenario 的 After evidence；这与 `$toolkit:runweave-change-validation` 的交接契约一致。
- `verificationMode=structural`：允许 `review_harness` 或 `static_contract`，但必须复跑 reviewer evidence 中的原命令/原 harness（若存在），并提供修复后证据。mock/harness 不能冒充 runtime finding 的真实复现。
- `not_reproduced`、`boundary`、`blocked`、`verification=fail|blocked` 都表示“不允许继续修改或提交门禁”，backend 进入 `need_human`，并保留证据说明。
- `impactedChecks` 不是强制全量矩阵。Code Agent 必须列出正/负/时序/并发/回归中与本 invariant 有关的最小集合；不适用的维度可不执行。任一必跑项失败即停止，不继续消耗 token 跑后续项。
- 第 2 次及以后处理同一 repairKey 时，`strategyAssessment` 必填，至少说明上一轮机制为何失败，以及本轮是否需要调整状态所有权、事件边界或数据模型。它不武断禁止局部分支，但禁止没有机制解释地继续叠加启发式。

Code Agent 不能用 `acceptanceResults` 给自己通过验收；`fixVerifications` 只证明“可以交给独立 gate 复验”，最终 pass 仍只能来自 `code_review` / `behavior_verify`。

### 3. backend 交接门禁

`dispatchNextSerialWorkerFromCompletion` 在 bounced code completion 时先执行交接校验：

1. outbox freshness、pane identity 和当前 dispatch 仍沿用现有校验。
2. `fixVerifications` 必须恰好覆盖当前所有 active repairKey，不能缺失，也不能用旧 repairKey 冒充。
3. 按 failure 类型验证 reproduction/verification 规则和非空 evidence。
4. 缺字段或 schema 错误时只允许一次“补交证据”prompt，且不允许再改源码；第二次仍无效则 `need_human`。
5. 合格后才派发 `code_review`；此时把对应 repair cycle 的 `attempts` 加 1。

初始 code 实现没有 active repairKey，不要求 `fixVerifications`，继续走现有 `code -> code_review` 流程。

### 4. 独立的修复预算

在 `AgentTeamLoop` 持久化 active repair cycles，并在 run 创建时固定 `maxRepairAttempts`：

```ts
interface AgentTeamRepairCycle {
  repairKey: string;
  sourceRole: "code_review" | "behavior_verify";
  caseIds: string[];
  invariant: string;
  attempts: number;
  maxAttempts: number;
  firstFailedRound: number;
  lastFailedRound: number;
  lastFailureSummary: string;
}
```

- 默认 `maxRepairAttempts=3`，create-run API 可选范围 1～5；v1 不增加 UI 配置。
- 首次失败创建 cycle，派发第 1 次修复；每次合格 code handoff 后 `attempts += 1`。
- gate 通过后关闭对应 cycle；新 invariant 建立独立 cycle。
- 同一 repairKey 在 `attempts=3` 后再次失败，不再 bounce，直接 `need_human`。
- `hadDiff`、passCount 变化、verifier timeout retry 都不能清空 repair attempts。
- `noProgressCount` 继续只做全局 liveness 兜底；`recheckAttempt` 继续只做 verifier outbox timeout，日志中明确区分三个计数器。
- 人工 resume 清空 active budget，但把完整 cycle 快照写入 `humanNotes`/logs，避免历史消失。

默认值选择 3 的理由：1 次容易把偶发误判升级人工，2 次不足以覆盖“复现证据不完整后修正一次”的常见情况；3 次允许初次修复、一次机制修正、一次架构重评。第 4 次仍失败时，继续自动改代码的边际收益已经低于人工重新定义 invariant/数据模型的成本。

### 5. 人工接管信息

自动中断时，run JSON 至少保留：

- repairKey、invariant、来源 gate/case/finding；
- 3 次 code handoff 的 reproduction、verification、strategyAssessment 和证据引用；
- 每次 review/behavior 的失败 summary；
- 当前 checkpoint/HEAD、active dispatch 和未提交路径；
- 明确原因：复现阻塞、协议不合格，或 3 次合格修复后仍失败。

人工不需要先翻 pane scrollback 才能理解为什么被中断。

## 修改范围与职责

- `packages/shared/src/agent-team.ts`
  - 增加 finding 的 `invariantKey` / `verificationMode`、`AgentTeamFixVerification`、repair cycle 和 `maxRepairAttempts` 类型。
- `backend/src/routes/agent-team.ts`
  - create-run options 接受并限制 `maxRepairAttempts` 为 1～5。
- `backend/src/agent-team/prompt-builders.ts`
  - bounce prompt 按 runtime/structural 和 attempt 生成不同要求；明确“自证修复”不等于“自行通过独立门禁”；补交协议 prompt。
  - review prompt 要求每个 P0/P1 finding 给出稳定 invariantKey 和 verificationMode。
- `backend/src/agent-team/outbox-resolver.ts`
  - 规范化新 finding 字段和 `fixVerifications`，保留历史 outbox 读取能力。
- `backend/src/agent-team/service-acceptance-policy.ts`
  - 从 gate outbox 解析 blocking finding、生成稳定 repairKey，并拒绝新 dispatch 下不可计数的 review finding。
- `backend/src/agent-team/loop.ts`
  - 管理 repair cycle 的创建、合格交接计数、通过关闭和预算耗尽判断；不改变 fail-fast/debounce 语义。
- `backend/src/agent-team/service-completion.ts`
  - 在 code completion 到 code_review 之间增加结构化交接门禁和一次补交机会。
- `backend/src/agent-team/service-execution.ts`
  - bounce 前检查 repair budget；预算耗尽时冻结 workers 并进入 `need_human`。
- `backend/src/agent-team/service-lifecycle.ts`
  - 初始化默认预算；人工 resume 归档 cycle 后重置 active budget。
- `scripts/verify-agent-team-review-checkpoints.mjs`
  - 增加协议、repairKey、三次预算、重启幂等、旧 outbox 兼容等可执行检查；不新增单元测试文件。

局部 helper 的文件拆分可由执行者按现有 service 结构决定，但不得把 shared 合约放进 `packages/common`。

## 实施顺序

1. 先落共享协议、normalizer 和历史兼容读取。
2. 给 reviewer finding 增加 invariantKey/verificationMode，并让 bounce 持久化 active repair cycle。
3. 加 code fixVerifications 交接校验；在校验完成前禁止派发下游 gate。
4. 加独立 repair attempt 预算和 `need_human` handoff；保持 `noProgress`/`recheckAttempt` 原职责。
5. 更新 prompts，最后补齐 verify script 覆盖；避免先写 prompt、后补 backend 强制。

## 验收

详细用例见 `docs/testing/agent-team-evidence-gated-repair-loop-test-cases.md`。

必跑命令按顺序执行，任一失败即停：

```bash
pnpm agent-team:verify-review-checkpoints
pnpm typecheck
pnpm lint
git diff --check
```

通过标准：

- bounced Code Agent 缺少真实复现/同场景 After 证据时，backend 不派发 code_review。
- 纯 structural finding 不被错误要求启动真实产品环境，但原 reviewer harness/契约证据必须闭环。
- 同一 behavior case 或 review invariant 在 3 次合格修复后仍失败，自动进入 `need_human`；任意 diff 不能重置计数。
- 不同 invariant 互不污染预算；通用 review caseId 不能把不同 finding 混为一个计数器。
- verifier 仍可 fail-fast，下一轮仍按失败/未执行/依赖/受影响范围选择性复验。
- backend 重启、迟到 outbox、重复 completion 不重复增加 repair attempt 或重复派发 worker。

## 风险与回滚

- 风险：reviewer 输出的 invariantKey 不稳定会逃逸计数。缓解：prompt 给出命名规则，backend 在同一 active cycle 中回显已有 key；第二轮优先复用，不允许 Code Agent 自定义。
- 风险：证据 schema 过重导致格式错误。缓解：只对 bounced code 强制，允许一次无源码修改的补交；normalizer 给出精确缺失字段。
- 风险：把环境阻塞误当代码失败。缓解：`blocked` 单独进入人工，不消耗下一次修复预算，也不继续修改。
- 风险：旧 run 恢复。缓解：新字段全部带默认值；旧 outbox 可读，但新一轮 P0/P1 bounce 必须升级为新 finding contract。
- 回滚：关闭新修复交接门禁时可退回现有串行 dispatch；共享字段保持可选，不需要迁移或删除历史 run JSON。
