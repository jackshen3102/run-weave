import { Router } from "express";
import { z } from "zod";
import type {
  CreateOrchestratorRunRequest,
  DispatchOrchestratorGoalRequest,
  InjectOrchestratorPromptRequest,
  OrchestratorRunStatus,
  SubmitOrchestratorHumanGateRequest,
  SubmitOrchestratorRoundConfirmationRequest,
} from "@runweave/shared";
import {
  OrchestratorError,
  type OrchestratorService,
} from "../orchestrator/service";
import { ORCHESTRATOR_RUN_ID_PATTERN } from "../orchestrator/run-id";
import { logger } from "../logging";

const orchestratorRouteLogger = logger.child({ component: "orchestrator-route" });
const runIdSchema = z
  .string()
  .trim()
  .min(1)
  .regex(
    ORCHESTRATOR_RUN_ID_PATTERN,
    "runId may contain only letters, numbers, underscores, and hyphens",
  );
const runParamsSchema = z.object({ runId: runIdSchema }).strict();

const terminalSchema = z
  .object({
    command: z.string().trim().min(1).optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().trim().min(1).nullable().optional(),
    runtimePreference: z.enum(["auto", "tmux", "pty"]).optional(),
  })
  .strict();

const bindingSchema = z
  .object({
    mode: z.enum(["new", "reuse"]),
    sessionId: z.string().trim().min(1).nullable().optional(),
  })
  .strict();

const roleSchema = z
  .object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    binding: bindingSchema,
    terminal: terminalSchema,
    prompt: z.string(),
    skill: z.string().trim().min(1).optional(),
  })
  .strict();

const createRunSchema = z
  .object({
    runId: runIdSchema.optional(),
    projectId: z.string().trim().min(1),
    task: z.string().trim().min(1),
    orchestrator: z
      .object({
        role: z.literal("orchestrator").optional(),
        binding: bindingSchema,
        startupPrompt: z.string().trim().min(1),
        terminal: terminalSchema,
      })
      .strict(),
    roles: z.array(roleSchema).min(1),
    options: z
      .object({
        requireHumanConfirmationEachRound: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const dispatchSchema = z
  .object({
    runId: runIdSchema,
    roleId: z.string().trim().min(1),
    goalId: z.string().trim().min(1),
    query: z.string().trim().min(1),
    desc: z.string().trim().min(1).optional(),
    sessionId: z.string().trim().min(1).nullable().optional(),
    newSession: z.boolean().optional(),
  })
  .strict();

const saveRolesSchema = z
  .object({
    roles: z.array(
      z
        .object({
          id: z.string().trim().min(1),
          name: z.string().trim().min(1),
          terminal: terminalSchema,
          prompt: z.string(),
          skill: z.string().trim().min(1).optional(),
        })
        .strict(),
    ),
  })
  .strict();

const injectSchema = z
  .object({ text: z.string().trim().min(1) })
  .strict();

const statusSchema = z
  .object({
    status: z.enum(["running", "paused", "need_human", "done", "failed"]),
  })
  .strict();

const humanGateSchema = z
  .object({
    phase: z.enum(["human_plan_approval", "human_verify"]),
    verdict: z.enum(["approved", "rejected"]),
    reason: z.string().trim().min(1).nullable().optional(),
  })
  .strict();

const roundConfirmationSchema = z
  .object({
    confirmationId: z.string().trim().min(1),
    verdict: z.enum(["approved", "rejected"]),
    reason: z.string().trim().min(1).nullable().optional(),
  })
  .strict();

export function createOrchestratorRouter(
  orchestratorService: OrchestratorService,
): Router {
  const router = Router();

  router.get("/roles", async (_req, res) => {
    res.json({ roles: await orchestratorService.listRoles() });
  });

  router.put("/roles", async (req, res) => {
    const parsed = saveRolesSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
      return;
    }
    res.json({ roles: await orchestratorService.saveRoles(parsed.data.roles) });
  });

  router.get("/runs", async (req, res) => {
    const projectId =
      typeof req.query.projectId === "string" ? req.query.projectId.trim() : "";
    if (!projectId) {
      res.status(400).json({ message: "Missing projectId" });
      return;
    }
    res.json({ runs: await orchestratorService.listRuns(projectId) });
  });

  router.get("/runs/:runId", async (req, res) => {
    const params = runParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ message: "Invalid request params", errors: params.error.flatten() });
      return;
    }
    const run = await orchestratorService.getRun(params.data.runId);
    if (!run) {
      res.status(404).json({ message: "Orchestrator run not found" });
      return;
    }
    res.json(run);
  });

  router.post("/runs", async (req, res) => {
    const parsed = createRunSchema.safeParse(req.body as CreateOrchestratorRunRequest);
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
      return;
    }
    await handleServiceCall(res, () => orchestratorService.createRun(parsed.data));
  });

  router.post("/runs/preview", async (req, res) => {
    const parsed = createRunSchema.safeParse(req.body as CreateOrchestratorRunRequest);
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
      return;
    }
    await handleServiceCall(res, () =>
      orchestratorService.previewStartupPrompt(parsed.data),
    );
  });

  router.post("/dispatch", async (req, res) => {
    const parsed = dispatchSchema.safeParse(req.body as DispatchOrchestratorGoalRequest);
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
      return;
    }
    await handleServiceCall(res, () => orchestratorService.dispatchGoal(parsed.data));
  });

  router.post("/runs/:runId/inject", async (req, res) => {
    const params = runParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ message: "Invalid request params", errors: params.error.flatten() });
      return;
    }
    const parsed = injectSchema.safeParse(req.body as InjectOrchestratorPromptRequest);
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
      return;
    }
    await handleServiceCall(res, () =>
      orchestratorService.injectPrompt(params.data.runId, parsed.data.text),
    );
  });

  router.post("/runs/:runId/human-gate", async (req, res) => {
    const params = runParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ message: "Invalid request params", errors: params.error.flatten() });
      return;
    }
    const parsed = humanGateSchema.safeParse(
      req.body as SubmitOrchestratorHumanGateRequest,
    );
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
      return;
    }
    await handleServiceCall(res, () =>
      orchestratorService.submitHumanGate(params.data.runId, parsed.data),
    );
  });

  router.post("/runs/:runId/round-confirmation", async (req, res) => {
    const params = runParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ message: "Invalid request params", errors: params.error.flatten() });
      return;
    }
    const parsed = roundConfirmationSchema.safeParse(
      req.body as SubmitOrchestratorRoundConfirmationRequest,
    );
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
      return;
    }
    await handleServiceCall(res, () =>
      orchestratorService.submitRoundConfirmation(
        params.data.runId,
        parsed.data,
      ),
    );
  });

  router.patch("/runs/:runId/status", async (req, res) => {
    const params = runParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ message: "Invalid request params", errors: params.error.flatten() });
      return;
    }
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
      return;
    }
    await handleServiceCall(res, () =>
      orchestratorService.setRunStatus(
        params.data.runId,
        parsed.data.status as OrchestratorRunStatus,
      ),
    );
  });

  return router;
}

async function handleServiceCall(
  res: { status: (code: number) => { json: (body: unknown) => void }; json: (body: unknown) => void },
  action: () => Promise<unknown>,
): Promise<void> {
  try {
    res.json(await action());
  } catch (error) {
    if (error instanceof OrchestratorError) {
      res.status(error.statusCode).json({ message: error.message });
      return;
    }
    orchestratorRouteLogger.error("orchestrator.request.failed", {
      message: "Orchestrator request failed",
      error: sanitizeTerminalError(error),
    });
    res.status(500).json({ message: "Orchestrator request failed", error: String(error) });
  }
}

function sanitizeTerminalError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
