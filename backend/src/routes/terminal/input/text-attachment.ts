import type { Router, Response } from "express";
import { z } from "zod";
import type { TerminalSessionManager } from "../../../terminal/manager/manager";
import type { TerminalTextAttachmentDelivery } from "../../../terminal/attachments/text-attachment-delivery";
import { TextAttachmentError } from "../../../terminal/attachments/text-attachment-service";

export function sendTextAttachmentError(res: Response, error: unknown): void {
  if (error instanceof TextAttachmentError) {
    res.status(error.status).json({ message: error.message });
    return;
  }
  const code = (error as NodeJS.ErrnoException).code;
  res.status(code === "ENOSPC" || code === "EDQUOT" ? 507 : 409).json({
    message:
      code === "ENOSPC" || code === "EDQUOT"
        ? "磁盘空间不足，原文已保留"
        : "附件操作未确认，原文已保留；请查询结果或核对终端",
  });
}
const targetSchema = z
  .object({
    operationId: z.string().min(1).max(180),
    panelId: z.string().min(1).max(200),
    expectedThreadId: z.string().min(1).max(200).nullable().optional(),
  })
  .strict();
const createSchema = targetSchema
  .extend({ purpose: z.enum(["composer", "tui"]), text: z.string() })
  .strict();

export function registerTerminalTextAttachmentRoutes(
  router: Router,
  manager: TerminalSessionManager,
  delivery: TerminalTextAttachmentDelivery,
): void {
  const base = "/session/:id/text-attachments";
  router.use(base, (req, res, next) => {
    if (!manager.getSession(req.params.id)) {
      res.status(404).json({ message: "Terminal session not found" });
      return;
    }
    next();
  });
  router.get(`${base}/capability`, async (req, res) => {
    res.json(
      await delivery.capability(
        req.params.id,
        typeof req.query.panelId === "string" ? req.query.panelId : "",
      ),
    );
  });
  router.post(base, async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "无效附件参数" });
      return;
    }
    try {
      res.status(201).json(await delivery.create(req.params.id, parsed.data));
    } catch (error) {
      sendTextAttachmentError(res, error);
    }
  });
  router.get(`${base}/operations/:operationId`, async (req, res) => {
    try {
      const { fingerprint: _fingerprint, ...operation } =
        await delivery.files.operation(req.params.id, req.params.operationId);
      void _fingerprint;
      res.json(operation);
    } catch (error) {
      sendTextAttachmentError(res, error);
    }
  });
  router.post(`${base}/:attachmentId/insert`, async (req, res) => {
    const parsed = targetSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "无效插入参数" });
      return;
    }
    try {
      res.json(
        await delivery.insert(
          req.params.id,
          req.params.attachmentId,
          parsed.data,
        ),
      );
    } catch (error) {
      sendTextAttachmentError(res, error);
    }
  });
  router.get(`${base}/:attachmentId/content`, async (req, res) => {
    try {
      const content = await delivery.files.read(
        req.params.id,
        req.params.attachmentId,
      );
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.type("text/plain; charset=utf-8").send(content);
    } catch (error) {
      sendTextAttachmentError(res, error);
    }
  });
  router.get(`${base}/:attachmentId`, async (req, res) => {
    try {
      res.json(
        await delivery.files.get(req.params.id, req.params.attachmentId),
      );
    } catch (error) {
      sendTextAttachmentError(res, error);
    }
  });
  router.post(`${base}/:attachmentId/retain`, async (req, res) => {
    try {
      await delivery.files.retain(req.params.id, req.params.attachmentId);
      res.status(204).send();
    } catch (error) {
      sendTextAttachmentError(res, error);
    }
  });
  router.delete(`${base}/:attachmentId`, async (req, res) => {
    try {
      await delivery.files.release(req.params.id, req.params.attachmentId);
      res.status(204).send();
    } catch (error) {
      sendTextAttachmentError(res, error);
    }
  });
}
