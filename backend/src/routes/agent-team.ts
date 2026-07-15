import { Router } from "express";
import { z } from "zod";
import { AgentTeamError } from "../agent-team/errors";
import type { AgentTeamService } from "../agent-team/service";
import { AGENT_TEAM_RUN_ID_PATTERN } from "../agent-team/run-id";
import { logger } from "../logging";

const agentTeamRouteLogger = logger.child({ component: "agent-team-route" });

const runIdSchema = z
  .string()
  .trim()
  .min(1)
  .regex(
    AGENT_TEAM_RUN_ID_PATTERN,
    "runId may contain only letters, numbers, underscores, and hyphens",
  );
const runParamsSchema = z.object({ runId: runIdSchema }).strict();

const workerRoleEnum = z.enum(["code", "code_review", "behavior_verify"]);
const workerDraftSchema = z
  .object({ role: workerRoleEnum, intent: z.string().trim().min(1) })
  .strict();
const optionalPathSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? null : value),
  z.string().trim().min(1).nullable().optional(),
);
const acceptanceDraftSchema = z
  .object({
    caseId: z.string().trim().min(1).nullable().optional(),
    text: z.string().trim().min(1),
    sourceCaseId: z.string().trim().min(1).nullable().optional(),
    sourceFilePath: z.string().trim().min(1).nullable().optional(),
    sourceHeading: z.string().trim().min(1).nullable().optional(),
    tags: z.array(z.string().trim().min(1)).optional(),
    dependsOn: z.array(z.string().trim().min(1)).optional(),
  })
  .strict();
const terminalSchema = z
  .object({
    command: z.string().trim().min(1).optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().trim().min(1).nullable().optional(),
    runtimePreference: z.enum(["auto", "tmux", "pty"]).optional(),
  })
  .strict();

const createRunSchema = z
  .object({
    projectId: z.string().trim().min(1),
    terminalSessionId: z.string().trim().min(1),
    task: z.string().trim().optional(),
    planFilePath: optionalPathSchema,
    testCaseFilePath: optionalPathSchema,
    options: z
      .object({
        autoApproveSplit: z.boolean().optional(),
        reviewCheckpointMode: z.enum(["disabled", "local_commit"]).optional(),
        maxRepairAttempts: z.number().int().min(1).max(5).optional(),
      })
      .strict()
      .optional(),
    terminal: terminalSchema.optional(),
  })
  .strict();

const proposeSchema = z
  .object({
    source: z.enum(["user", "agent"]).optional(),
    summary: z.string().trim().min(1).optional(),
    workers: z.array(workerDraftSchema).optional(),
    acceptance: z.array(acceptanceDraftSchema).optional(),
    planFilePath: optionalPathSchema,
    testCaseFilePath: optionalPathSchema,
    generatedTestCaseFilePath: optionalPathSchema,
  })
  .strict();

const splitGateSchema = z
  .object({
    verdict: z.enum(["confirmed", "rejected"]),
    workers: z.array(workerDraftSchema).optional(),
    acceptance: z.array(acceptanceDraftSchema).optional(),
    planFilePath: optionalPathSchema,
    testCaseFilePath: optionalPathSchema,
    generatedTestCaseFilePath: optionalPathSchema,
  })
  .strict();

const resumeSchema = z.object({ note: z.string().trim().min(1) }).strict();
const agentInterventionSchema = z
  .object({
    action: z.enum(["dispatch", "refresh_acceptance"]),
    note: z.string().trim().min(1),
    role: workerRoleEnum,
    caseIds: z.array(z.string().trim().min(1)).min(1).max(100).optional(),
    generatedTestCaseFilePath: optionalPathSchema,
    checkpointAllowedDirtyPaths: z
      .array(z.string().trim().min(1))
      .min(1)
      .max(100)
      .optional(),
    checkpointExpectedHeadCommit: z
      .string()
      .trim()
      .regex(/^[0-9a-f]{40}$/)
      .optional(),
    checkpointRebasedCommit: z
      .string()
      .trim()
      .regex(/^[0-9a-f]{40}$/)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.action === "dispatch" &&
      value.generatedTestCaseFilePath != null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["generatedTestCaseFilePath"],
        message: "dispatch 不接受 generatedTestCaseFilePath",
      });
    }
    if (
      value.role !== "behavior_verify" &&
      (value.checkpointAllowedDirtyPaths != null ||
        value.checkpointExpectedHeadCommit != null ||
        value.checkpointRebasedCommit != null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["role"],
        message: "只有 behavior_verify 可声明 checkpoint 例外",
      });
    }
  });
const completeSchema = z
  .object({ note: z.string().trim().min(1).optional() })
  .strict();
const findingDispositionSchema = z
  .object({
    invariantKey: z.string().trim().min(1),
    disposition: z.enum(["blocking", "out_of_scope", "waived"]),
    caseIds: z.array(z.string().trim().min(1)).optional(),
    reason: z.string().trim().min(1),
  })
  .strict();
const focusSchema = z.object({ panelId: z.string().trim().min(1) }).strict();
const exportQuerySchema = z
  .object({
    history: z.enum(["none", "tail", "full"]).optional(),
    tail: z.coerce.number().int().positive().max(5000).optional(),
    includeSessionOther: z
      .enum(["true", "false"])
      .optional()
      .transform((value) =>
        value === undefined ? undefined : value === "true",
      ),
    includeOutboxes: z
      .enum(["true", "false"])
      .optional()
      .transform((value) =>
        value === undefined ? undefined : value === "true",
      ),
  })
  .strict();

export function createAgentTeamRouter(
  agentTeamService: AgentTeamService,
): Router {
  const router = Router();

  router.get("/runs", async (req, res) => {
    const projectId =
      typeof req.query.projectId === "string" ? req.query.projectId.trim() : "";
    if (!projectId) {
      res.status(400).json({ message: "Missing projectId" });
      return;
    }
    const terminalSessionId =
      typeof req.query.terminalSessionId === "string"
        ? req.query.terminalSessionId.trim()
        : "";
    if (terminalSessionId) {
      const run = await agentTeamService.getRunByTerminalSession(
        projectId,
        terminalSessionId,
      );
      res.json({ runs: run ? [run] : [] });
      return;
    }
    res.json({ runs: await agentTeamService.listRuns(projectId) });
  });

  router.get("/runs/:runId", async (req, res) => {
    const params = runParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ message: "Invalid request params" });
      return;
    }
    const run = await agentTeamService.getRun(params.data.runId);
    if (!run) {
      res.status(404).json({ message: "Agent-team run not found" });
      return;
    }
    res.json(run);
  });

  router.get("/runs/:runId/export", async (req, res) => {
    const params = runParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ message: "Invalid request params" });
      return;
    }
    const parsed = exportQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request query",
        errors: parsed.error.flatten(),
      });
      return;
    }
    await handleServiceCall(res, () =>
      agentTeamService.exportRun(params.data.runId, {
        history: parsed.data.history,
        tailLines: parsed.data.tail,
        includeSessionOther: parsed.data.includeSessionOther,
        includeOutboxes: parsed.data.includeOutboxes,
      }),
    );
  });

  router.post("/runs", async (req, res) => {
    const parsed = createRunSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request body",
        errors: parsed.error.flatten(),
      });
      return;
    }
    await handleServiceCall(res, () => agentTeamService.startRun(parsed.data));
  });

  router.post("/runs/:runId/propose-split", async (req, res) => {
    const params = runParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ message: "Invalid request params" });
      return;
    }
    const parsed = proposeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request body",
        errors: parsed.error.flatten(),
      });
      return;
    }
    await handleServiceCall(res, () =>
      agentTeamService.proposeSplit(params.data.runId, parsed.data),
    );
  });

  router.post("/runs/:runId/split-gate", async (req, res) => {
    const params = runParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ message: "Invalid request params" });
      return;
    }
    const parsed = splitGateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request body",
        errors: parsed.error.flatten(),
      });
      return;
    }
    await handleServiceCall(res, () =>
      agentTeamService.submitSplitGate(params.data.runId, parsed.data),
    );
  });

  router.post("/runs/:runId/resume", async (req, res) => {
    const params = runParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ message: "Invalid request params" });
      return;
    }
    const parsed = resumeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request body",
        errors: parsed.error.flatten(),
      });
      return;
    }
    await handleServiceCall(res, () =>
      agentTeamService.resumeRun(params.data.runId, parsed.data),
    );
  });

  router.post("/runs/:runId/intervene", async (req, res) => {
    const params = runParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ message: "Invalid request params" });
      return;
    }
    const parsed = agentInterventionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request body",
        errors: parsed.error.flatten(),
      });
      return;
    }
    await handleServiceCall(res, () =>
      agentTeamService.interveneRun(params.data.runId, parsed.data),
    );
  });

  router.post("/runs/:runId/complete", async (req, res) => {
    const params = runParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ message: "Invalid request params" });
      return;
    }
    const parsed = completeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request body",
        errors: parsed.error.flatten(),
      });
      return;
    }
    await handleServiceCall(res, () =>
      agentTeamService.completeRun(params.data.runId, parsed.data),
    );
  });

  router.post("/runs/:runId/finding-disposition", async (req, res) => {
    const params = runParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ message: "Invalid request params" });
      return;
    }
    const parsed = findingDispositionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request body",
        errors: parsed.error.flatten(),
      });
      return;
    }
    await handleServiceCall(res, () =>
      agentTeamService.decideFinding(params.data.runId, parsed.data),
    );
  });

  router.post("/runs/:runId/focus-pane", async (req, res) => {
    const params = runParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ message: "Invalid request params" });
      return;
    }
    const parsed = focusSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request body",
        errors: parsed.error.flatten(),
      });
      return;
    }
    await handleServiceCall(res, () =>
      agentTeamService.focusPane(params.data.runId, parsed.data.panelId),
    );
  });

  return router;
}

async function handleServiceCall(
  res: {
    status: (code: number) => { json: (body: unknown) => void };
    json: (body: unknown) => void;
  },
  action: () => Promise<unknown>,
): Promise<void> {
  try {
    res.json(await action());
  } catch (error) {
    if (error instanceof AgentTeamError) {
      res.status(error.statusCode).json({
        message: error.message,
        ...(error.details !== undefined ? { details: error.details } : {}),
      });
      return;
    }
    agentTeamRouteLogger.error("agent-team.request.failed", {
      message: "Agent-team request failed",
      error: error instanceof Error ? error.message : String(error),
    });
    res
      .status(500)
      .json({ message: "Agent-team request failed", error: String(error) });
  }
}
