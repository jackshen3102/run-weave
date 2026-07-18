import { parseDocument } from "yaml";
import { z } from "zod";
import { AgentTeamError } from "./errors";

export const AGENT_TEAM_TEST_PLAN_SUFFIX = ".testplan.yaml";
export const AGENT_TEAM_TEST_PLAN_MAX_CASES = 20;

const CASE_ID_PATTERN = /^([A-Z][A-Z0-9-]*)-(\d{3})$/;
const nonEmptyStringSchema = z.string().trim().min(1);

const testPlanCaseSchema = z
  .object({
    id: nonEmptyStringSchema.regex(CASE_ID_PATTERN),
    name: nonEmptyStringSchema,
    required: z.boolean(),
    description: nonEmptyStringSchema,
    preconditions: z.array(nonEmptyStringSchema).min(1),
    steps: z.array(nonEmptyStringSchema).min(1),
  })
  .strict();

const testPlanSchema = z
  .object({
    version: z.literal(1),
    name: nonEmptyStringSchema,
    description: nonEmptyStringSchema,
    cases: z.array(testPlanCaseSchema).min(1).max(AGENT_TEAM_TEST_PLAN_MAX_CASES),
  })
  .strict()
  .superRefine((testPlan, context) => {
    const firstMatch = CASE_ID_PATTERN.exec(testPlan.cases[0]?.id ?? "");
    const expectedPrefix = firstMatch?.[1] ?? null;
    testPlan.cases.forEach((testCase, index) => {
      const match = CASE_ID_PATTERN.exec(testCase.id);
      if (!match) {
        return;
      }
      if (match[1] !== expectedPrefix) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cases", index, "id"],
          message: `case ID 必须统一使用前缀 ${expectedPrefix}`,
        });
      }
      if (Number(match[2]) !== index + 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cases", index, "id"],
          message: `case ID 必须按文档顺序连续编号，当前位置应为 ${String(index + 1).padStart(3, "0")}`,
        });
      }
    });
    if (!testPlan.cases.some((testCase) => testCase.required)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cases"],
        message: "至少需要一个 required: true 的 case",
      });
    }
  });

export type AgentTeamTestPlan = z.infer<typeof testPlanSchema>;
export type AgentTeamTestPlanCase = AgentTeamTestPlan["cases"][number];

export function parseAgentTeamTestPlan(
  yaml: string,
  sourceFilePath: string,
): AgentTeamTestPlan {
  const document = parseDocument(yaml, {
    prettyErrors: false,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new AgentTeamError(
      400,
      `测试案例文件 YAML 无法解析：${sourceFilePath}：${document.errors[0]?.message ?? "未知错误"}`,
    );
  }

  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw new AgentTeamError(
      400,
      `测试案例文件 YAML 无法解析：${sourceFilePath}：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = testPlanSchema.safeParse(value);
  if (!result.success) {
    const details = result.error.issues
      .slice(0, 8)
      .map((issue) => {
        const location = issue.path.length > 0 ? issue.path.join(".") : "root";
        return `${location}: ${issue.message}`;
      })
      .join("；");
    throw new AgentTeamError(
      400,
      `测试案例文件不符合最小 YAML 规范：${sourceFilePath}：${details}`,
    );
  }
  return result.data;
}
