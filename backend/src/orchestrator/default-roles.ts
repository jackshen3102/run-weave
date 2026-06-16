import type { OrchestratorRoleDefinition } from "@runweave/shared";

export const DEFAULT_ROLES: OrchestratorRoleDefinition[] = [
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
