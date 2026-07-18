import type {
  AgentTeamAcceptanceCase,
  AgentTeamRun,
} from "@runweave/shared/agent-team";

export function buildBlockedBehaviorMainPrompt(params: {
  run: AgentTeamRun;
  blockedCases: AgentTeamAcceptanceCase[];
}): string {
  const { run, blockedCases } = params;
  return [
    `[Agent Team ${run.runId}] behavior_verify 遇到阻塞，run 已暂停，请分析后选择最小恢复动作。`,
    "",
    ...blockedCases.flatMap((item) => [
      `- [${item.caseId}] ${item.sourceFilePath ?? "unknown"}${item.sourceHeading ? `｜${item.sourceHeading}` : ""}`,
      `  验收合同：${item.text}`,
      `  skip code：${item.skip?.code ?? "legacy"}`,
      ...(item.skip?.blockerCaseIds?.length
        ? [`  blocker Case：${item.skip.blockerCaseIds.join(", ")}`]
        : []),
      `  阻塞原因：${item.skipReason ?? "worker 未提供 skipReason"}`,
      ...(item.evidence.length > 0
        ? [
            `  证据：${item.evidence.map((evidence) => `${evidence.label}: ${evidence.summary}（ref=${evidence.ref}）`).join("；")}`,
          ]
        : ["  证据：无"]),
    ]),
    "",
    "恢复要求：",
    "- 先判断是环境问题、验收合同问题还是依赖/顺序问题，不要默认修改测试合同。",
    `- 环境或依赖修复后，执行 rw agent-team intervene ${run.runId} --action dispatch --role behavior_verify --cases <受影响 Case> --note <原因>。`,
    `- 确需修改验收合同时，编辑项目内完整测试案例文件，再执行 rw agent-team intervene ${run.runId} --action refresh_acceptance --role <code_review|behavior_verify> --cases <受影响 Case> --generated-test-case-file <文件> --note <原因>。`,
    "- 未声明的 Case 必须保持既有状态和证据，禁止全量重跑。",
    "- 无法安全判断时保持 need_human，并向用户说明需要的决策。",
  ].join("\n");
}

export function buildHumanGateMainPrompt(run: AgentTeamRun): string {
  if (run.frameworkRepair?.result === "blocked") {
    return [
      `[Agent Team ${run.runId}] Run 已进入框架修复阻塞。`,
      `原因：${run.frameworkRepair.reason}`,
      `旧 dispatch：${run.frameworkRepair.target.invalidatedDispatch.dispatchId ?? "unknown"}（已失效）`,
      "完成框架修复并重启 Backend 后，只能选择继续原 Run 或重新运行。",
      `先执行 rw agent-team framework-repair status ${run.runId} 检查恢复条件。`,
      `现场可信时执行 rw agent-team framework-repair continue ${run.runId}；否则执行 rw agent-team framework-repair rerun ${run.runId}。`,
      "不要使用通用 resume、agent intervention 或旧 outbox 绕过该门禁。",
    ].join("\n");
  }
  const blockedCases =
    run.loop.lastReason?.startsWith("behavior_verify 结构化跳过") ||
    run.loop.lastReason?.startsWith("behavior_verify 环境阻塞")
      ? run.acceptance.filter(
          (item) =>
            item.status === "pending" && item.lastRunStatus === "skipped",
        )
      : [];
  if (blockedCases.length > 0) {
    return buildBlockedBehaviorMainPrompt({ run, blockedCases });
  }

  return [
    `[Agent Team ${run.runId}] run 已进入 Human Gate，请检查当前状态并推进允许的下一步。`,
    `阶段：${run.phase}`,
    `原因：${run.loop.lastReason ?? run.logs.at(-1) ?? "未记录"}`,
    ...(run.phase === "proposal"
      ? [
          "当前是拆分提案门禁：请向用户说明提案并等待确认或拒绝，不得代替用户审批。",
        ]
      : []),
    ...(run.pendingFindingDecision
      ? [
          `当前是 P0/P1 finding 范围裁决：${run.pendingFindingDecision.reason}`,
          "必须请求用户 disposition，不得由 Agent 代替人工裁决。",
        ]
      : []),
    "先分析门禁原因；仅在现有权限允许且能安全恢复时执行修复或 Agent intervention。",
    "本通知不授权绕过 Human Gate。无法安全判断时，向用户说明所需决策。",
  ].join("\n");
}
