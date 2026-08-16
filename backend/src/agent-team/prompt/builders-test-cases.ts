import type { AgentTeamRun } from "@runweave/shared/agent-team";

export function buildMainTestCaseGenerationPrompt(params: {
  run: AgentTeamRun;
  planFilePath?: string | null;
  testCaseValidationError?: string | null;
}): string {
  const { run, planFilePath, testCaseValidationError } = params;
  const sourceText = planFilePath
    ? testCaseValidationError
      ? `输入文件（测试案例解析未通过）：${planFilePath}`
      : `计划文件：${planFilePath}`
    : `任务描述：${run.task}`;
  const missingSourceInstructions = testCaseValidationError
    ? [
        `已尝试将输入文件作为测试案例解析，但未通过：${testCaseValidationError}`,
        "如果该文件本来就是测试案例，优先修复原文件使其可解析，不要创建内容重复的新文档。",
        "只有确认该文件确实只是计划时，才调用 $toolkit:write-test-cases 生成新的测试案例文档。",
      ]
    : [
        "当前缺少可追溯测试案例文件。",
        "请先调用 $toolkit:write-test-cases 生成测试案例文档。",
      ];
  return [
    "你是本 Agent Team run 的主 Agent。",
    "",
    `Run: ${run.runId}`,
    `Session: ${run.terminalSessionId}`,
    `ProjectId: ${run.projectId}`,
    "",
    ...missingSourceInstructions,
    "在测试案例文件可解析前，禁止进入 worker split，也禁止使用默认泛化 acceptance。",
    "测试案例就绪后再提交 worker 拆分提案。",
    "生成前先读取输入来源；若来源已出现可追溯 case ID 前缀，所有生成 case 必须继承该前缀，不得另造领域前缀；只有来源未给出 case ID 前缀时才按主题新建。",
    "",
    "输入来源：",
    sourceText,
    "",
    "接续要求：",
    "- 测试案例文档写完后，调用 POST /api/agent-team/runs/:runId/propose-split，payload 带 generatedTestCaseFilePath，并使用 code、code_review、behavior_verify 三类 worker。",
    "- 如果无法生成可解析测试案例文件，停止并向用户说明“缺少可追溯测试案例文件”，不要提交 split。",
  ].join("\n");
}

export function formatBehaviorValidationAuthorityInstructions(
  run: AgentTeamRun,
): string[] {
  const testCaseSha256 =
    run.verification?.testCaseSha256 ??
    run.verification?.generatedTestCaseSha256 ??
    null;
  const authority =
    run.verification?.acceptanceSource === "task_generated"
      ? "验收合同：Agent Team Backend 已固化本 dispatch 的结构化 Case"
      : "测试计划校验：Agent Team Backend 已校验并固化本 dispatch 的结构化 Case";
  return [
    `${authority}；testCaseSha256=${testCaseSha256 ?? "null"}。`,
    "直接执行 prompt 分配的 Case；如有原始 YAML，不要重新解析，不要探测或运行目标仓库的测试计划格式校验命令。仓库没有 validator 不属于 environment blocker。",
  ];
}
