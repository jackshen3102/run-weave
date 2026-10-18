import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { SIDE_CHAT_TEXT_MAX_BYTES } from "@runweave/shared/side-chat";
import type { SideChatService } from "../side-chat/service";
import { SideChatError } from "../side-chat/error";
const id = z.string().trim().min(1).max(200);
const write = z.object({ operationId: id, expectedVersion: z.number().int().positive() }).strict();
const source = z.object({ terminalSessionId: id, panelId: id, expectedPrimaryThreadId: id, lastCompletedTurnId: id }).strict();
const create = z.object({ operationId: id, source }).strict();
const send = write.extend({ text: z.string().refine(text => text.trim().length > 0 && Buffer.byteLength(text, "utf8") <= SIDE_CHAT_TEXT_MAX_BYTES) }).strict();
const empty = z.object({}).strict();
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new SideChatError(400, "INVALID_REQUEST", "旁聊请求参数无效（正文须为非空文字，最多 64 KiB）"); return result.data;
}
export function createSideChatRouter(service: SideChatService): Router {
  const router = Router();
  const handle = (action: (req: Request, res: Response) => unknown) => (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    void Promise.resolve().then(() => action(req, res)).catch((error: unknown) => {
      res.status(error instanceof SideChatError ? error.status : 503).json({
        code: error instanceof SideChatError ? error.code : "SIDE_CHAT_UNAVAILABLE",
        message: error instanceof SideChatError ? error.message : "旁聊暂不可用，请保留草稿并刷新状态",
        ...(error instanceof SideChatError && error.details ? { details: error.details } : {}),
      });
    });
  };
  router.get("/capabilities", handle(async (req, res) => {
    const query = parse(z.object({ terminalSessionId: id, panelId: id.optional() }).strict(), req.query);
    res.json(await service.capabilities(query.terminalSessionId, query.panelId));
  }));
  router.post("/", handle(async (req, res) => { parse(empty, req.query); const body = parse(create, req.body); res.status(201).json(await service.create(body.operationId, body.source)); }));
  router.get("/:id", handle((req, res) => { parse(empty, req.query); res.json(service.snapshot(parse(id, req.params.id))); }));
  router.get("/:id/messages", handle((req, res) => {
    const query = parse(z.object({ beforeSequence: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(50).optional() }).strict(), req.query);
    res.json(service.messages(parse(id, req.params.id), query.beforeSequence, query.limit));
  }));
  router.get("/:id/operations/:operationId", handle((req, res) => { parse(empty, req.query); res.json(service.operation(parse(id, req.params.id), parse(id, req.params.operationId))); }));
  router.post("/:id/turns", handle((req, res) => { parse(empty, req.query); res.status(202).json(service.send(parse(id, req.params.id), parse(send, req.body))); }));
  router.post("/:id/turns/:turnId/stop", handle((req, res) => { parse(empty, req.query); res.status(202).json(service.stop(parse(id, req.params.id), parse(id, req.params.turnId), parse(write, req.body))); }));
  router.post("/:id/end", handle((req, res) => { parse(empty, req.query); res.status(202).json(service.end(parse(id, req.params.id), parse(write, req.body))); }));
  return router;
}
