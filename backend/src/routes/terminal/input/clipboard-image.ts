import type { Router } from "express";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { CreateTerminalClipboardImageRequest, CreateTerminalClipboardImageResponse } from "@runweave/shared/terminal/input";
import { logger } from "../../../logging/index";
import type { TerminalSessionManager } from "../../../terminal/manager/manager";
import { saveBrowserCommentEvidence } from "../../../terminal/attachments/browser-comment-evidence";
import {
  TERMINAL_CLIPBOARD_IMAGE_MAX_BYTES,
  TERMINAL_CLIPBOARD_IMAGE_MAX_MIB,
} from "../../../terminal/preview/clipboard-image";

const terminalClipboardLogger = logger.child({ component: "terminal" });

const createTerminalClipboardImageSchema = z.object({
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  dataBase64: z.string().min(1),
  browserComment: z.object({
    id: z.string().min(1).max(200), index: z.number().int().min(1).max(50),
    comment: z.string().trim().min(1).max(4000),
    target: z.object({
      elementId: z.string().max(200).optional(),
      pageUrl: z.string().max(10000), frameLabel: z.string().max(1000),
      targetText: z.string().max(10000), targetSelector: z.string().max(10000), targetPath: z.string().max(10000),
      nodePosition: z.object({ x: z.number().finite(), y: z.number().finite() }),
      viewport: z.object({ width: z.number().positive(), height: z.number().positive() }),
      rect: z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().nonnegative(), height: z.number().nonnegative() }),
      devicePixelRatio: z.number().positive(),
    }),
  }).optional(),
});

function resolveClipboardImageExtension(mimeType: string): string {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      throw new Error(`Unsupported clipboard image mime type: ${mimeType}`);
  }
}

function buildClipboardImageFileName(
  now: Date,
  extension: string,
  randomHex = randomBytes(3).toString("hex"),
): string {
  const date = now.toISOString().slice(0, 10).replaceAll("-", "");
  const time = now.toISOString().slice(11, 19).replaceAll(":", "");
  return `runweave-terminal-image-${date}-${time}-${randomHex}.${extension}`;
}

export function registerTerminalClipboardImageRoutes(
  router: Router,
  terminalSessionManager: TerminalSessionManager,
): void {
  router.post("/session/:id/clipboard-image", async (req, res) => {
    const parsed = createTerminalClipboardImageSchema.safeParse(
      req.body as CreateTerminalClipboardImageRequest,
    );
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request body",
        errors: parsed.error.flatten(),
      });
      return;
    }

    const session = terminalSessionManager.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ message: "Terminal session not found" });
      return;
    }

    try {
      const extension = resolveClipboardImageExtension(parsed.data.mimeType);
      const fileName = buildClipboardImageFileName(new Date(), extension);
      const terminalTempDir = path.join(
        os.tmpdir(),
        "runweave-terminal-images",
      );
      const filePath = path.join(terminalTempDir, fileName);
      const imageBuffer = Buffer.from(parsed.data.dataBase64, "base64");
      if (imageBuffer.length > TERMINAL_CLIPBOARD_IMAGE_MAX_BYTES) {
        terminalClipboardLogger.warn("terminal.clipboard-image.too-large", {
          message: "Terminal clipboard image exceeded size limit",
          terminalSessionId: session.id,
          bytes: imageBuffer.length,
          limitBytes: TERMINAL_CLIPBOARD_IMAGE_MAX_BYTES,
        });
        res.status(413).json({
          message: `Clipboard image exceeds ${TERMINAL_CLIPBOARD_IMAGE_MAX_MIB} MiB limit`,
        });
        return;
      }

      if (parsed.data.browserComment) {
        if (parsed.data.mimeType !== "image/png" || !imageBuffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
          res.status(400).json({ message: "Browser comment evidence requires a PNG screenshot" });
          return;
        }
        res.status(201).json(await saveBrowserCommentEvidence(session.id, parsed.data.browserComment, imageBuffer));
        return;
      }

      await mkdir(terminalTempDir, { recursive: true });
      await writeFile(filePath, imageBuffer);

      const payload: CreateTerminalClipboardImageResponse = {
        fileName,
        filePath,
      };
      res.status(201).json(payload);
    } catch (error) {
      terminalClipboardLogger.error("terminal.clipboard-image.store.failed", {
        message: "Store terminal clipboard image failed",
        terminalSessionId: req.params.id,
        error,
      });
      res.status(500).json({
        message: "Failed to store terminal clipboard image",
        error: String(error),
      });
    }
  });
}
