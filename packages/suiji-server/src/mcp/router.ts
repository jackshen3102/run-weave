import { browseEnabled } from "../browse/domain";
import { BrowseService } from "../browse/service";
import { createBrowseMcpServer } from "./browse";
import type { WorkRecordService } from "../work-records/service";
import type { FollowupService } from "../followups/service";
import type { LocalFileStore } from "../storage/local-files";
import { mcpUploads } from "./uploads";
import { SUIJI_LIMITS, SUIJI_PROTOCOL_VERSION } from "@runweave/shared/suiji";
import { Router } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type pg from "pg";
import type { Config } from "../config";
import type { RecordService } from "../records/service";
import type { AttachmentService } from "../storage/attachments";
import { authenticateMcp, McpAuthenticationUnavailable } from "./auth";
import { createMcpServer } from "./server";

export function createMcpRouter(
  pool: pg.Pool,
  records: RecordService,
  attachments: AttachmentService,
  config: Config,
  followups: FollowupService,
  store: LocalFileStore,
  workRecords: WorkRecordService,
) {
  const router = Router();
  router.use((req, res, next) => {
    if (!config.SUIJI_MCP_ENABLED) {
      res.status(404).json({ error: "MCP_DISABLED" });
      return;
    }
    // M2 has no browser client or CORS contract; CLI clients send no Origin.
    if (req.headers.origin !== undefined) {
      res.status(403).json({ error: "MCP_ORIGIN_NOT_ALLOWED" });
      return;
    }
    void authenticateMcp(pool, req.headers.authorization).then(context => {
      if ((context.domain === "browse" ? "/browse" : context.domain === "work" ? "/work" : req.path === "/uploads" ? "/uploads" : "/") !== req.path) {
        res.status(403).json({ error: "MCP_DOMAIN_NOT_ALLOWED" });
        return;
      }
      res.locals.mcpOwner = context.ownerId;
      res.locals.mcpCredentialId = context.credentialId;
      next();
    }, error => {
      if (error instanceof McpAuthenticationUnavailable) {
        res.status(503).json({ error: "MCP_UNAVAILABLE" });
        return;
      }
      next(error);
    });
  });
  router.use(mcpUploads(attachments, store));
  router.all(["/", "/browse", "/work"], (req, res, next) => {
    void (async () => {
      const owner = res.locals.mcpOwner as string;
      if (req.method !== "POST") {
        res
          .set("Allow", "POST")
          .status(405)
          .json({ error: "MCP_METHOD_NOT_ALLOWED" });
        return;
      }
      const server = req.path === "/browse" ? createBrowseMcpServer(new BrowseService(pool), owner, res.locals.requestId, config.SUIJI_APP_VERSION, attachments, async () => ({ ownerId: owner, serverId: (await pool.query("SELECT server_id FROM server_identity")).rows[0].server_id, protocolVersion: SUIJI_PROTOCOL_VERSION, features: { browse: await browseEnabled(pool,owner) } })) : createMcpServer(
        records,
        attachments,
        owner,
        res.locals.requestId,
        config.SUIJI_APP_VERSION,
        followups,
        async () => {
          const identity = await pool.query("SELECT server_id FROM server_identity");
          const schema = await pool.query("SELECT count(*)::int AS version FROM suiji_migrations");
          return { ownerId: owner, serverId: identity.rows[0].server_id,
            protocolVersion: SUIJI_PROTOCOL_VERSION, appVersion: config.SUIJI_APP_VERSION,
            schemaVersion: schema.rows[0].version, limits: SUIJI_LIMITS, features: { materials: true, workMaterials: false, followups: true, changes: true, workRecords: true, workReports: true, workSources: true, workBrowserHistory: false, workScreenTimeline: true } };
        },
        workRecords,
        req.path === "/work",
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
