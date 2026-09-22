import { Router } from "express";
import type { AttachmentService } from "../storage/attachments";
import type { LocalFileStore } from "../storage/local-files";
import { receiveUpload } from "../http/upload";
import { keySchema } from "../schema";

/** Mounted behind the same per-request MCP authentication as JSON-RPC. */
export function mcpUploads(
  attachments: AttachmentService,
  store: LocalFileStore,
) {
  const router = Router();
  router.post("/uploads", (req, res, next) => {
    void (async () => {
      const key = keySchema.parse(req.get("Idempotency-Key"));
      const upload = await receiveUpload(req, store);
      try {
        res
          .status(201)
          .json(
            await attachments.upload(
              {
                ownerId: res.locals.mcpOwner,
                actor: "agent",
                key,
                requestId: res.locals.requestId,
              },
              upload.staged,
              upload.name,
              upload.mime,
            ),
          );
      } finally {
        await store.discard(upload.staged.key);
      }
    })().catch(next);
  });
  return router;
}
