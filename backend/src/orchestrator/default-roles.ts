import type { OrchestratorRoleDefinition } from "@runweave/shared";

export const DEFAULT_ROLES: OrchestratorRoleDefinition[] = [
  {
    id: "plan_reviewer",
    name: "计划审查",
    terminal: { command: "codex", args: [] },
    skill: "review-only",
    prompt:
      "你是计划审查 worker。审查主 Agent 给出的计划，按技能要求输出结构化 summary。不接管主控流程。",
  },
  {
    id: "code_agent",
    name: "代码执行",
    terminal: { command: "codex", args: [] },
    prompt:
      "你是代码执行 worker。按主 Agent 给定的计划完成实现，按要求输出结构化 summary。不接管主控流程。",
  },
  {
    id: "code_reviewer",
    name: "代码审查",
    terminal: { command: "codex", args: [] },
    skill: "review-only",
    prompt:
      "你是代码审查 worker。审查主 Agent 指定的改动，按技能要求输出结构化 summary。不接管主控流程。",
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
