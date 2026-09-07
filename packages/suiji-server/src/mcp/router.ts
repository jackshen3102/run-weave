import { Router } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type pg from "pg";
import type { Config } from "../config";
import type { RecordService } from "../records/service";
import type { AttachmentService } from "../storage/attachments";
import { authenticateMcp } from "./auth";
import { createMcpServer } from "./server";

export function createMcpRouter(
  pool: pg.Pool,
  records: RecordService,
  attachments: AttachmentService,
  config: Config,
) {
  const router = Router();
  router.all("/", (req, res, next) => {
    if (!config.SUIJI_MCP_TOKEN_SHA256) {
      res.status(404).json({ error: "MCP_DISABLED" });
      return;
    }
    // M2 has no browser client or CORS contract; CLI clients send no Origin.
    if (req.headers.origin !== undefined) {
      res.status(403).json({ error: "MCP_ORIGIN_NOT_ALLOWED" });
      return;
    }
    void (async () => {
      const owner = await authenticateMcp(
        pool,
        config,
        req.headers.authorization,
      );
      if (req.method !== "POST") {
        res
          .set("Allow", "POST")
          .status(405)
          .json({ error: "MCP_METHOD_NOT_ALLOWED" });
        return;
      }
      const server = createMcpServer(
        records,
        attachments,
        owner,
        res.locals.requestId,
        config.SUIJI_APP_VERSION,
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.once("close", () => {
        void server.close().catch(() => undefined);
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        await server.close().catch(() => undefined);
        throw error;
      }
    })().catch(next);
  });
  return router;
}
