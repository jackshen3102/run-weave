import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadAcceptanceCasesFromTestPlan } from "../backend/src/agent-team/acceptance-case-loader";
import { AgentTeamError } from "../backend/src/agent-team/errors";

let projectRoot = "";
let testingDirectory = "";

void main();

async function main(): Promise<void> {
  projectRoot = await mkdtemp(path.join(os.tmpdir(), "runweave-testplan-"));
  testingDirectory = path.join(projectRoot, "docs/testing");
  try {
    await mkdir(testingDirectory, { recursive: true });
    await writeFixture(
      "valid.testplan.yaml",
      `version: 1
name: 测试计划格式验证
description: 验证 required case 会进入 Agent Team，optional case 只保留在源文件中。
cases:
  - id: TPF-001
    name: 必选用例
    required: true
    description: 执行后可以观察到正确结果。
    preconditions:
      - 测试环境可用。
    steps:
      - 执行动作并确认结果符合描述。
  - id: TPF-002
    name: 可选用例
    required: false
    description: 仅在全量回归时执行。
    preconditions:
      - 扩展环境可用。
    steps:
      - 执行动作并确认扩展结果符合描述。
`,
    );
    const loaded = await loadAcceptanceCasesFromTestPlan({
      projectRoot,
      requestedPath: "docs/testing/valid.testplan.yaml",
    });
    assert.equal(loaded.cases.length, 1);
    assert.equal(loaded.cases[0]?.caseId, "TPF-001");

    await writeFixture(
      "legacy-test-cases.md",
      "### TPF-001 旧 Markdown 用例\n\n步骤：不再支持。\n",
    );
    await expectRejected(
      "旧 Markdown 后缀",
      "docs/testing/legacy-test-cases.md",
      ".testplan.yaml",
    );

    await writeFixture(
      "extra-field.testplan.yaml",
      `version: 1
name: 非法扩展字段
description: 不允许扩展 schema。
cases:
  - id: TPF-001
    name: 非法用例
    required: true
    priority: high
    description: 包含未定义字段。
    preconditions:
      - 环境可用。
    steps:
      - 执行动作并确认结果。
`,
    );
    await expectRejected(
      "未定义字段",
      "docs/testing/extra-field.testplan.yaml",
      "Unrecognized key",
    );

    await writeFixture(
      "non-contiguous.testplan.yaml",
      `version: 1
name: 非连续 ID
description: ID 必须连续。
cases:
  - id: TPF-001
    name: 第一条
    required: true
    description: 第一条描述。
    preconditions:
      - 环境可用。
    steps:
      - 执行第一条并确认结果。
  - id: TPF-003
    name: 第三条
    required: true
    description: 第三条描述。
    preconditions:
      - 环境可用。
    steps:
      - 执行第三条并确认结果。
`,
    );
    await expectRejected(
      "非连续 ID",
      "docs/testing/non-contiguous.testplan.yaml",
      "连续编号",
    );

    await writeFixture(
      "too-many-cases.testplan.yaml",
      `version: 1
name: 超过上限
description: 单个计划不能超过二十条用例。
cases:
${Array.from(
  { length: 21 },
  (_, index) => `  - id: TPF-${String(index + 1).padStart(3, "0")}
    name: 用例 ${index + 1}
    required: true
    description: 用于验证单个计划的记录上限。
    preconditions:
      - 环境可用。
    steps:
      - 执行动作并确认结果。`,
).join("\n")}
`,
    );
    await expectRejected(
      "超过二十条用例",
      "docs/testing/too-many-cases.testplan.yaml",
      "20",
    );

    console.log("test plan format verification passed");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

async function writeFixture(fileName: string, content: string): Promise<void> {
  await writeFile(path.join(testingDirectory, fileName), content, "utf8");
}

async function expectRejected(
  label: string,
  requestedPath: string,
  expectedMessage: string,
): Promise<void> {
  try {
    await loadAcceptanceCasesFromTestPlan({ projectRoot, requestedPath });
    assert.fail(`${label} 应被拒绝`);
  } catch (error) {
    assert.ok(
      error instanceof AgentTeamError,
      `${label} 应返回 AgentTeamError`,
    );
    assert.match(error.message, new RegExp(escapeRegExp(expectedMessage)));
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
