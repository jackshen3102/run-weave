import type { Router } from "express";
import { z } from "zod";
import {
  TERMINAL_CLIPBOARD_FILE_MAX_BYTES,
  type CreateTerminalClipboardFileRequest,
} from "@runweave/shared/terminal/input";
import type { TerminalSessionManager } from "../../../terminal/manager/manager";
import { saveTerminalClipboardFile } from "../../../terminal/attachments/clipboard-file";
import { logger } from "../../../logging/index";

const schema = z.object({
  fileName: z.string().min(1).max(255).refine((name) =>
    name !== "." && name !== ".." && !/[\\/]/.test(name)
    && Array.from(name).every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    && Buffer.byteLength(name, "utf8") <= 255),
  dataBase64: z.string(),
});

export function registerTerminalClipboardFileRoutes(router: Router, manager: TerminalSessionManager): void {
  router.post("/session/:id/clipboard-file", async (req, res) => {
    const parsed = schema.safeParse(req.body as CreateTerminalClipboardFileRequest);
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid file attachment", errors: parsed.error.flatten() });
      return;
    }
    const session = manager.getSession(req.params.id);
    if (!session) { res.status(404).json({ message: "Terminal session not found" }); return; }
    if (session.status !== "running") { res.status(409).json({ message: "Terminal session is not running" }); return; }
    const data = Buffer.from(parsed.data.dataBase64, "base64");
    if (data.length > TERMINAL_CLIPBOARD_FILE_MAX_BYTES) {
      res.status(413).json({ message: "File exceeds 100 MiB limit" }); return;
    }
    if (data.toString("base64") !== parsed.data.dataBase64) {
      res.status(400).json({ message: "Invalid file data" }); return;
    }
    try {
      res.status(201).json(await saveTerminalClipboardFile(session.id, parsed.data.fileName, data));
    } catch (error) {
      logger.error("terminal.clipboard-file.store.failed", { terminalSessionId: session.id, error });
      res.status(500).json({ message: "Failed to store file attachment" });
    }
  });
}
