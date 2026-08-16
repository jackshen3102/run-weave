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
      ...(item.skip?.blockerFingerprint
        ? [
            `  blocker fingerprint：${item.skip.blockerFingerprint}（scope=${item.skip.blockerScope ?? "unknown"}）`,
          ]
        : []),
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
    `- 公共环境阻塞修复后，从同 fingerprint 的 Case 中选验收顺序最前的一条作为恢复探针，执行 rw agent-team intervene ${run.runId} --action dispatch --role behavior_verify --cases <代表 Case> --note <原因>；探针证实环境恢复后，后端会失效同 fingerprint 的旧观察并按 Case 顺序串行续跑。`,
    `- 确需修改验收合同时，编辑项目内完整测试案例文件，再执行 rw agent-team intervene ${run.runId} --action refresh_acceptance --role <code_review|behavior_verify> --cases <受影响 Case> --generated-test-case-file <文件> --note <原因>。`,
    "- 未声明的 Case 必须保持既有状态和证据，禁止全量重跑。",
    "- 这是主 Agent 恢复任务，不是人工审批；除非出现拆分审批或 P0/P1 finding 范围裁决，不得仅因 need_human 状态向用户请求确认。",
    "- 证据不足时保持现场不变并继续只读诊断，直到能选择合法恢复动作。",
  ].join("\n");
}

export function buildHumanGateMainPrompt(run: AgentTeamRun): string {
  if (run.frameworkRepair?.result === "blocked") {
    return [
      `[Agent Team ${run.runId}] Run 已进入框架修复阻塞。`,
      `原因：${run.frameworkRepair.reason}`,
      `旧 dispatch：${run.frameworkRepair.target.invalidatedDispatch.dispatchId ?? "unknown"}（已失效）`,
      "这是主 Agent 自动恢复流程，不请求用户选择。完成框架修复、更新应用并重启 Backend 后，只能选择继续原 Run 或重新运行。",
      `先执行 rw agent-team framework-repair status ${run.runId} 检查恢复条件。`,
      `canContinue=true 时执行 rw agent-team framework-repair continue ${run.runId}；否则在 recovery actions 允许时执行 rw agent-team framework-repair rerun ${run.runId}。`,
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
  if (run.phase === "proposal") {
    return [
      `[Agent Team ${run.runId}] run 已进入 Human Gate。`,
      `阶段：${run.phase}`,
      `原因：${run.loop.lastReason ?? run.logs.at(-1) ?? "未记录"}`,
      "当前是拆分提案门禁：请向用户说明提案并等待确认或拒绝，不得代替用户审批。",
      "本通知不授权绕过 Human Gate。",
    ].join("\n");
  }
  if (run.pendingFindingDecision) {
    return [
      `[Agent Team ${run.runId}] run 已进入 Human Gate。`,
      `阶段：${run.phase}`,
      `当前是 P0/P1 finding 范围裁决：${run.pendingFindingDecision.reason}`,
      "必须请求用户 disposition，不得由 Agent 代替人工裁决。",
      "本通知不授权绕过 Human Gate。",
    ].join("\n");
  }

  return [
    `[Agent Team ${run.runId}] run 已进入 Agent Recovery Gate，请检查当前状态并自动推进允许的下一步。`,
    `阶段：${run.phase}`,
    `原因：${run.loop.lastReason ?? run.logs.at(-1) ?? "未记录"}`,
    "当前不是拆分审批或 finding 范围裁决；先只读检查 Run、源码边界和验收合同，再由主 Agent 选择最小合法恢复动作。",
    `仅环境或依赖已恢复时，执行 rw agent-team intervene ${run.runId} --action dispatch --role <code|code_review|behavior_verify> --cases <受影响 Case> --note <原因>。`,
    `验收合同已经修订时，执行 rw agent-team intervene ${run.runId} --action refresh_acceptance --role <code_review|behavior_verify> --cases <受影响 Case> --generated-test-case-file <文件> --note <原因>。`,
    "框架修复现场存在时，按 framework-repair status 的 canContinue/actions 自动选择 continue 或 rerun。",
    "不得修改 Run JSON、伪造旧 outbox 或绕过安全校验；也不得仅因状态名为 need_human 就向用户请求确认。",
  ].join("\n");
}
