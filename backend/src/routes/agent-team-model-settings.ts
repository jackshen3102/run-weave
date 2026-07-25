import type { Router } from "express";
import { z } from "zod";
import type { AgentTeamService } from "../agent-team/service";
import { handleAgentTeamServiceCall } from "./agent-team-route-support";

const reasoningEffortSchema = z.string().trim().min(1).nullable();
const roleModelConfigSchema = z.discriminatedUnion("provider", [
  z
    .object({
      provider: z.literal("codex"),
      model: z.string().trim().min(1),
      reasoningEffort: reasoningEffortSchema,
      fast: z.boolean(),
    })
    .strict(),
  z
    .object({
      provider: z.literal("traex"),
      model: z.string().trim().min(1),
      reasoningEffort: reasoningEffortSchema,
      max: z.boolean(),
    })
    .strict(),
]);
const saveModelSettingsSchema = z
  .object({
    roles: z
      .object({
        main: roleModelConfigSchema,
        code: roleModelConfigSchema,
        code_review: roleModelConfigSchema,
        behavior_verify: roleModelConfigSchema,
      })
      .strict(),
  })
  .strict();

export function registerAgentTeamModelSettingsRoutes(
  router: Router,
  agentTeamService: AgentTeamService,
): void {
  router.get("/model-settings", async (_req, res) => {
    await handleAgentTeamServiceCall(res, () =>
      agentTeamService.getModelSettings(),
    );
  });

  router.put("/model-settings", async (req, res) => {
    const parsed = saveModelSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request body",
        errors: parsed.error.flatten(),
      });
      return;
    }
    await handleAgentTeamServiceCall(res, () =>
      agentTeamService.saveModelSettings(parsed.data),
    );
  });
}
