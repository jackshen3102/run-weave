import type { OrchestratorRoleDefinition } from "@runweave/shared";

export const DEFAULT_ROLES: OrchestratorRoleDefinition[] = [
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

const LEGACY_DEFAULT_ROLES: OrchestratorRoleDefinition[] = [
  {
    id: "coder",
    name: "代码编写",
    terminal: { command: "codex", args: [] },
    prompt: "你是代码编写 worker。只完成主 Agent 指派的当前目标，结束时给出简洁总结。",
  },
  {
    id: "reviewer",
    name: "代码审查",
    terminal: { command: "codex", args: [] },
    prompt: "你是代码审查 worker。审查指定改动，输出问题、风险和建议。",
  },
  {
    id: "tester",
    name: "测试",
    terminal: { command: "codex", args: [] },
    prompt: "你是测试 worker。按主 Agent 要求运行验证并汇报结果。",
  },
];

export function isLegacyDefaultRoleSet(
  roles: OrchestratorRoleDefinition[],
): boolean {
  return JSON.stringify(roles) === JSON.stringify(LEGACY_DEFAULT_ROLES);
}
