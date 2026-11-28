import type { Router } from "express";
import { z } from "zod";
import type { TerminalQuestionsService } from "../../terminal/questions/service";
import type { TerminalMobileReplies } from "../../terminal/completion/mobile-replies";
import { QuestionConflict } from "../../terminal/questions/gateway";
import { sendTerminalPanelRouteError } from "./panels/common";
import type { AuthService } from "../../auth/service";
import { readBearerToken } from "../../auth/middleware";

const answerSchema = z.object({
  panelId: z.string().min(1), generation: z.string().uuid(), threadId: z.string().min(1),
  turnId: z.string().min(1), itemId: z.string().min(1), operationId: z.string().uuid(),
  answers: z.record(z.string().min(1), z.object({ answers: z.array(z.string().min(1).max(20_000)).length(1) }).strict()).refine((answers) => Object.keys(answers).length <= 100),
}).strict();

const refSchema = z.string().uuid();
const notificationIdSchema = z.string().regex(/^[0-9a-f]{64}$/i);

export function registerTerminalQuestionRoutes(
  router: Router,
  service: TerminalQuestionsService | undefined,
  auth?: AuthService,
  getMobileReplies?: () => TerminalMobileReplies | undefined,
): void {
  router.get("/replies/notifications/:notificationId", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const notificationId = notificationIdSchema.safeParse(req.params.notificationId);
    const installation = refSchema.safeParse(req.header("x-runweave-installation-id"));
    if (!notificationId.success || !installation.success) { res.status(400).json({ code: "invalid_request" }); return; }
    const identity = auth?.verifyAccessToken(readBearerToken(req) ?? "");
    const result = identity && getMobileReplies?.()?.resolveNotification?.(
      notificationId.data.toLowerCase(),
      installation.data,
      identity.sessionId,
    );
    if (!result) { res.status(404).json({ code: "reply_not_found" }); return; }
    res.json(result);
  });
  router.get("/questions/notifications/:questionRef", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const ref = refSchema.safeParse(req.params.questionRef);
    const installation = refSchema.safeParse(req.header("x-runweave-installation-id"));
    if (!ref.success || !installation.success) { res.status(400).json({ code: "invalid_request" }); return; }
    const identity = auth?.verifyAccessToken(readBearerToken(req) ?? "");
    try {
      const result = identity && await service?.notifications?.resolve(ref.data.toLowerCase(), installation.data, identity.sessionId);
      if (!result) { res.status(404).json({ code: "question_not_found" }); return; }
      res.json(result);
    } catch {
      res.status(503).json({ code: "questions_unavailable" });
    }
  });
  const fail = (res: Parameters<typeof sendTerminalPanelRouteError>[0], error: unknown) => {
    if (error instanceof QuestionConflict) res.status(409).json({ code: "question_changed", message: error.message });
    else if (!sendTerminalPanelRouteError(res, error)) res.status(503).json({ code: "questions_unavailable", message: "回复辅助暂不可用，请回原终端操作" });
  };
  router.get("/session/:id/questions", async (req, res) => {
    if (!service) { res.status(503).json({ code: "questions_unavailable", message: "回复辅助暂不可用" }); return; }
    const panelId = req.query.panelId;
    if (panelId !== undefined && (typeof panelId !== "string" || !panelId)) { res.status(400).json({ code: "invalid_request" }); return; }
    try { res.json(await service.read(req.params.id, panelId)); } catch (error) { fail(res, error); }
  });
  router.post("/session/:id/questions/:requestId/answer", async (req, res) => {
    if (!service) { res.status(503).json({ code: "questions_unavailable" }); return; }
    const parsed = answerSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ code: "invalid_request", message: "问题答案参数无效" }); return; }
    try { res.json(await service.answer(req.params.id, req.params.requestId, parsed.data)); } catch (error) { fail(res, error); }
  });
}
