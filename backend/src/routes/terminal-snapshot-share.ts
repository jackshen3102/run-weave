import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Router } from "express";
import { parseTerminalSnapshotSharePath } from "@runweave/shared/terminal/snapshot-share";
import type { TerminalSnapshotHostService } from "../terminal/snapshot-share/host-service";
import { renderTerminalSnapshot, renderTerminalSnapshotMissing, terminalSnapshotShareHeaders } from "../terminal/snapshot-share/render";

export function createPublicTerminalSnapshotShareRouter(service: Pick<TerminalSnapshotHostService, "read">): Router {
  const router = Router();
  // Consume the whole mount, including malformed paths, before auth/bootstrap/SPA.
  // Only snapshot-scoped signature verification is allowed; no login/tunnel bootstrap.
  router.use(async (req, res) => {
    res.set(terminalSnapshotShareHeaders);
    let status = 404;
    if (req.method !== "GET" && req.method !== "HEAD") {
      status = 405;
      res.set("Allow", "GET, HEAD");
    } else {
      const access = parseTerminalSnapshotSharePath(`/share/terminal${req.url}`);
      if (access) {
        try {
          const record = await service.read(access);
          if (record && Date.now() < Date.parse(record.expiresAt)) {
            res.status(200);
            if (req.method === "HEAD") res.end();
            else {
              // Backpressure bounds HTML expansion; disconnect cancels the stream.
              await pipeline(Readable.from(renderTerminalSnapshot(record)), res);
            }
            return;
          }
        } catch {
          // Fail closed; never forward a bearer URL or record to the global logger.
          if (res.headersSent || res.destroyed) return;
        }
      }
    }
    // res.send would generate ETags and convert conditional requests to 304.
    const html = renderTerminalSnapshotMissing();
    res.status(status).set("Content-Length", String(Buffer.byteLength(html)));
    res.end(req.method === "HEAD" ? undefined : html);
  });
  return router;
}
