import path from "node:path";

export const REVIEWERS = [
  {
    id: "codex",
    command: "codex",
    model: "gpt-5.6-sol",
  },
  {
    id: "gpt54",
    command: "traex",
    model: "gpt-5.4",
  },
  {
    id: "openrouter",
    command: "traex",
    model: "openrouter-3o",
  },
];

export const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    caseId: { type: "string" },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          requirementIds: {
            type: "array",
            items: { type: "string" },
          },
          severity: {
            type: "string",
            enum: ["P0", "P1", "P2", "P3"],
          },
          file: { type: "string" },
          line: {
            anyOf: [{ type: "integer" }, { type: "null" }],
          },
          problem: { type: "string" },
          impact: { type: "string" },
          evidence: { type: "string" },
          confidence: {
            type: "integer",
            minimum: 0,
            maximum: 100,
          },
        },
        required: [
          "id",
          "requirementIds",
          "severity",
          "file",
          "line",
          "problem",
          "impact",
          "evidence",
          "confidence",
        ],
      },
    },
  },
  required: ["caseId", "summary", "findings"],
};

export function validateManifest(value, manifestDir) {
  if (!value || typeof value !== "object" || !Array.isArray(value.cases)) {
    throw new Error("manifest must contain a cases array");
  }
  if (value.cases.length === 0) {
    throw new Error("manifest cases must not be empty");
  }
  const caseIds = new Set();
  return {
    cases: value.cases.map((testCase, index) => {
      if (!testCase || typeof testCase !== "object") {
        throw new Error(`cases[${index}] must be an object`);
      }
      if (
        typeof testCase.id !== "string" ||
        !testCase.id.trim() ||
        caseIds.has(testCase.id)
      ) {
        throw new Error(`cases[${index}].id must be unique and non-empty`);
      }
      caseIds.add(testCase.id);
      if (
        !Array.isArray(testCase.requirements) ||
        testCase.requirements.length === 0
      ) {
        throw new Error(
          `case ${testCase.id} must contain at least one requirement`,
        );
      }
      const requirementIds = new Set();
      const requirements = testCase.requirements.map(
        (requirement, requirementIndex) => {
          if (
            !requirement ||
            typeof requirement.id !== "string" ||
            !requirement.id.trim() ||
            requirementIds.has(requirement.id) ||
            typeof requirement.text !== "string" ||
            !requirement.text.trim()
          ) {
            throw new Error(
              `case ${testCase.id} requirement ${requirementIndex} is invalid`,
            );
          }
          requirementIds.add(requirement.id);
          return {
            id: requirement.id,
            text: requirement.text,
          };
        },
      );
      if (
        typeof testCase.patchPath !== "string" ||
        !testCase.patchPath.trim()
      ) {
        throw new Error(`case ${testCase.id}.patchPath is required`);
      }
      return {
        id: testCase.id,
        requirements,
        requirementIds,
        patchPath: path.resolve(manifestDir, testCase.patchPath),
      };
    }),
  };
}

export function buildPrompt(testCase, patchText) {
  return [
    "You are one independent code-review cell.",
    "Review only the supplied patch against the supplied requirements.",
    "Do not assume a requirement is violated merely because it is listed.",
    "Report P0/P1 only for a concrete executable path that violates a requirement or introduces an equally concrete blocking defect.",
    "Use P2/P3 for non-blocking risks. Return findings: [] when the patch is correct.",
    "Use exact supplied requirement IDs. Use [] only for a concrete defect outside the supplied requirements.",
    "Do not use tools, repository access, prior reviewer output, or external context.",
    "Return exactly one JSON object matching the output schema.",
    "",
    `CASE_ID: ${testCase.id}`,
    `REQUIREMENTS: ${JSON.stringify(testCase.requirements)}`,
    "",
    "PATCH:",
    patchText,
  ].join("\n");
}

export function validateReview(review, testCase) {
  if (
    !review ||
    typeof review !== "object" ||
    Array.isArray(review) ||
    review.caseId !== testCase.id ||
    typeof review.summary !== "string" ||
    !Array.isArray(review.findings)
  ) {
    throw new Error("review output has an invalid top-level shape");
  }
  for (const finding of review.findings) {
    if (
      !finding ||
      typeof finding !== "object" ||
      typeof finding.id !== "string" ||
      !Array.isArray(finding.requirementIds) ||
      !["P0", "P1", "P2", "P3"].includes(finding.severity) ||
      typeof finding.file !== "string" ||
      !(Number.isInteger(finding.line) || finding.line === null) ||
      typeof finding.problem !== "string" ||
      typeof finding.impact !== "string" ||
      typeof finding.evidence !== "string" ||
      !Number.isInteger(finding.confidence) ||
      finding.confidence < 0 ||
      finding.confidence > 100
    ) {
      throw new Error(`finding ${finding?.id ?? "unknown"} is invalid`);
    }
    for (const requirementId of finding.requirementIds) {
      if (!testCase.requirementIds.has(requirementId)) {
        throw new Error(
          `finding ${finding.id} used unknown requirement ${requirementId}`,
        );
      }
    }
  }
}

export function aggregateCase(testCase, receipts) {
  const highSeverities = new Set(["P0", "P1"]);
  const byRequirement = new Map();
  const unmappedSevere = [];
  for (const receipt of receipts.filter((item) => item.ok)) {
    for (const finding of receipt.review.findings.filter((item) =>
      highSeverities.has(item.severity),
    )) {
      if (finding.requirementIds.length === 0) {
        unmappedSevere.push({
          reviewerId: receipt.reviewerId,
          finding,
        });
        continue;
      }
      for (const requirementId of finding.requirementIds) {
        const reviewers = byRequirement.get(requirementId) ?? new Map();
        if (!reviewers.has(receipt.reviewerId)) {
          reviewers.set(receipt.reviewerId, finding);
        }
        byRequirement.set(requirementId, reviewers);
      }
    }
  }
  const candidates = [...byRequirement.entries()].map(
    ([requirementId, reviewers]) => ({
      requirementId,
      independentVotes: reviewers.size,
      reviewers: [...reviewers.keys()],
      proposals: [...reviewers.entries()].map(([reviewerId, finding]) => ({
        reviewerId,
        finding,
      })),
    }),
  );
  return {
    caseId: testCase.id,
    validReviewerCount: receipts.filter((item) => item.ok).length,
    majorityCandidates: candidates.filter(
      (candidate) => candidate.independentVotes >= 2,
    ),
    singletonCandidates: candidates.filter(
      (candidate) => candidate.independentVotes === 1,
    ),
    unmappedSevere,
  };
}
