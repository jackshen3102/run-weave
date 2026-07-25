import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import { Router } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { readBearerToken } from "../auth/middleware";
import type { ActivityStore } from "../activity/activity-store";
import { canonicalJson, sha256 } from "../activity/canonical";
import type { AgentTeamService } from "../agent-team/service";
import type { AppServerHistoryGateway } from "../work-history/app-server-history-gateway";
import type { EvolutionContextPackStore } from "../evolution/context-pack-store";
import {
  type EvolutionToolGrant,
  EvolutionToolTokenRegistry,
} from "../evolution/tools/token-registry";
import { logger } from "../logging";
import { isLocalDirectRequest } from "../server/local-cdp-endpoint";
import {
  summarizeActivityFacts,
  summarizeDataQuality,
} from "./evolution-mcp-summary";

const CONTEXT_DESCRIBE_TOOL = "context.describe";
const ACTIVITY_SUMMARIZE_TOOL = "activity.summarize_facts";
const ACTIVITY_SEARCH_TOOL = "activity.search_facts";
const ACTIVITY_CONTENT_TOOL = "activity.get_content";
const EVIDENCE_METADATA_TOOL = "evidence.batch_get_metadata";
const HISTORY_THREAD_TOOL = "history.get_thread";
const HISTORY_RUN_TOOL = "history.get_agent_team_run";
const SOURCE_READ_TOOL = "source.read";
const SOURCE_SEARCH_TOOL = "source.search";
const MAX_SOURCE_BYTES = 256_000;

export function createEvolutionMcpRouter(options: {
  activityStore: ActivityStore | null;
  agentTeamService: AgentTeamService;
  appServerHistoryGateway: AppServerHistoryGateway;
  contextPackStore: EvolutionContextPackStore | null;
  tokenRegistry: EvolutionToolTokenRegistry;
}): Router {
  const router = Router();

  router.post("/", async (request, response) => {
    if (!isLocalDirectRequest(request)) {
      response.status(403).json({ error: "evolution_mcp_local_required" });
      return;
    }
    const token = readBearerToken(request);
    const grant = token ? options.tokenRegistry.resolve(token) : null;
    if (!token || !grant) {
      response.status(401).json({ error: "evolution_mcp_token_invalid" });
      return;
    }
    if (!options.contextPackStore) {
      response.status(503).json({ error: "evolution_unavailable" });
      return;
    }
    const manifest = await options.contextPackStore.getContextPackByRun(
      grant.runId,
    );
    if (!manifest) {
      response.status(409).json({ error: "evolution_context_pack_not_ready" });
      return;
    }

    const server = new McpServer({
      name: "runweave-evolution",
      version: "1.0.0",
    });
    if (grant.allowedTools.includes(CONTEXT_DESCRIBE_TOOL)) {
      server.registerTool(
        CONTEXT_DESCRIBE_TOOL,
        {
          description:
            "Describe the frozen Context Pack boundary and data quality for this analysis attempt.",
          inputSchema: z.object({}).strict(),
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        async () => {
          const authorized = options.tokenRegistry.consume(
            token,
            CONTEXT_DESCRIBE_TOOL,
          );
          const startedAt = performance.now();
          const payload = {
            runId: manifest.runId,
            analystRole: grant.analystRole,
            contextPackId: manifest.contextPackId,
            learningScopeId: manifest.learningScope.learningScopeId,
            profile: manifest.profile,
            baselineDigest: manifest.baselineDigest,
            createdAt: manifest.createdAt,
            deadlineAt: manifest.deadlineAt,
            digest: manifest.digest,
            sources: manifest.sources,
            evidenceCount: manifest.evidence.length,
            dataQuality: summarizeDataQuality(manifest.dataQualityIssues),
          };
          const text = JSON.stringify(payload);
          logToolCall(
            authorized,
            CONTEXT_DESCRIBE_TOOL,
            text.length,
            startedAt,
          );
          return { content: [{ type: "text" as const, text }] };
        },
      );
    }
    if (grant.allowedTools.includes(ACTIVITY_SUMMARIZE_TOOL)) {
      server.registerTool(
        ACTIVITY_SUMMARIZE_TOOL,
        {
          description:
            "Deterministically summarize every frozen Activity fact in one bounded response. Use this for full-range coverage, then inspect only representative Evidence IDs with activity.search_facts.",
          inputSchema: z.object({}).strict(),
          annotations: readOnlyAnnotations(),
        },
        async () => {
          const authorized = options.tokenRegistry.consume(
            token,
            ACTIVITY_SUMMARIZE_TOOL,
          );
          const startedAt = performance.now();
          const payload = summarizeActivityFacts(manifest);
          const text = JSON.stringify(payload);
          logToolCall(
            authorized,
            ACTIVITY_SUMMARIZE_TOOL,
            text.length,
            startedAt,
          );
          return { content: [{ type: "text" as const, text }] };
        },
      );
    }
    if (grant.allowedTools.includes(ACTIVITY_SEARCH_TOOL)) {
      server.registerTool(
        ACTIVITY_SEARCH_TOOL,
        {
          description:
            "Page through all frozen Activity evidence metadata from this run. Continue from nextCursor until it is null. Raw content is not returned.",
          inputSchema: z
            .object({
              evidenceIds: z.array(z.string().min(1)).max(100).optional(),
              cursor: z.number().int().min(0).default(0),
              limit: z.number().int().min(1).max(100).default(50),
            })
            .strict(),
          annotations: readOnlyAnnotations(),
        },
        async ({ evidenceIds, cursor, limit }) => {
          const authorized = options.tokenRegistry.consume(
            token,
            ACTIVITY_SEARCH_TOOL,
          );
          const startedAt = performance.now();
          const requested = evidenceIds ? new Set(evidenceIds) : null;
          const matching = manifest.evidence.filter(
            (evidence) =>
              evidence.source === "activity" &&
              (!requested || requested.has(evidence.evidenceId)),
          );
          const items = matching.slice(cursor, cursor + limit);
          const payload = {
            items,
            total: matching.length,
            nextCursor:
              cursor + items.length < matching.length
                ? cursor + items.length
                : null,
          };
          const text = JSON.stringify(payload);
          logToolCall(authorized, ACTIVITY_SEARCH_TOOL, text.length, startedAt);
          return { content: [{ type: "text" as const, text }] };
        },
      );
    }
    if (grant.allowedTools.includes(EVIDENCE_METADATA_TOOL)) {
      server.registerTool(
        EVIDENCE_METADATA_TOOL,
        {
          description:
            "Get frozen evidence hashes, availability, origin, and relationships by Evidence ID.",
          inputSchema: z
            .object({
              evidenceIds: z.array(z.string().min(1)).min(1).max(100),
            })
            .strict(),
          annotations: readOnlyAnnotations(),
        },
        async ({ evidenceIds }) => {
          const authorized = options.tokenRegistry.consume(
            token,
            EVIDENCE_METADATA_TOOL,
          );
          const startedAt = performance.now();
          const requested = new Set(evidenceIds);
          const payload = manifest.evidence.filter((evidence) =>
            requested.has(evidence.evidenceId),
          );
          const text = JSON.stringify(payload);
          logToolCall(
            authorized,
            EVIDENCE_METADATA_TOOL,
            text.length,
            startedAt,
          );
          return { content: [{ type: "text" as const, text }] };
        },
      );
    }
    if (
      grant.allowedTools.includes(ACTIVITY_CONTENT_TOOL) &&
      options.activityStore
    ) {
      const activityStore = options.activityStore;
      server.registerTool(
        ACTIVITY_CONTENT_TOOL,
        {
          description:
            "Read one still-available Activity content item referenced by this frozen run.",
          inputSchema: z.object({ contentId: z.string().uuid() }).strict(),
          annotations: readOnlyAnnotations(),
        },
        async ({ contentId }) => {
          const authorized = options.tokenRegistry.consume(
            token,
            ACTIVITY_CONTENT_TOOL,
          );
          const startedAt = performance.now();
          const evidence = manifest.evidence.find((item) =>
            item.contentRefs.some((content) => content.contentId === contentId),
          );
          const frozenContent = evidence?.contentRefs.find(
            (content) => content.contentId === contentId,
          );
          if (
            !evidence ||
            !frozenContent ||
            frozenContent.availability !== "available"
          ) {
            throw new Error("evolution_content_unavailable");
          }
          const content = await activityStore.content(contentId);
          if (
            !content ||
            content.availability !== "available" ||
            content.eventId !== evidence.sourceRecordId ||
            content.sha256 !== frozenContent.sha256
          ) {
            throw new Error("evolution_content_unavailable");
          }
          const text = JSON.stringify(content);
          logToolCall(
            authorized,
            ACTIVITY_CONTENT_TOOL,
            text.length,
            startedAt,
          );
          return { content: [{ type: "text" as const, text }] };
        },
      );
    }
    if (grant.allowedTools.includes(HISTORY_THREAD_TOOL)) {
      server.registerTool(
        HISTORY_THREAD_TOOL,
        {
          description:
            "Read one App Server thread that is frozen into this Context Pack.",
          inputSchema: z.object({ threadId: z.string().min(1) }).strict(),
          annotations: readOnlyAnnotations(),
        },
        async ({ threadId }) => {
          const authorized = options.tokenRegistry.consume(
            token,
            HISTORY_THREAD_TOOL,
          );
          const startedAt = performance.now();
          const evidence = manifest.evidence.find(
            (item) =>
              item.source === "app_server" && item.sourceRecordId === threadId,
          );
          if (!evidence) throw new Error("evolution_evidence_forbidden");
          const detail =
            await options.appServerHistoryGateway.getThreadDetail(threadId);
          if (sha256(canonicalJson(detail)) !== evidence.digest) {
            throw new Error("evolution_source_revision_changed");
          }
          const text = JSON.stringify(detail);
          logToolCall(authorized, HISTORY_THREAD_TOOL, text.length, startedAt);
          return { content: [{ type: "text" as const, text }] };
        },
      );
    }
    if (grant.allowedTools.includes(HISTORY_RUN_TOOL)) {
      server.registerTool(
        HISTORY_RUN_TOOL,
        {
          description:
            "Read one Agent Team run that is frozen into this Context Pack.",
          inputSchema: z.object({ runId: z.string().min(1) }).strict(),
          annotations: readOnlyAnnotations(),
        },
        async ({ runId }) => {
          const authorized = options.tokenRegistry.consume(
            token,
            HISTORY_RUN_TOOL,
          );
          const startedAt = performance.now();
          const evidence = manifest.evidence.find(
            (item) =>
              item.source === "agent_team" && item.sourceRecordId === runId,
          );
          if (!evidence) throw new Error("evolution_evidence_forbidden");
          const run = await options.agentTeamService.getRun(runId);
          if (!run || sha256(canonicalJson(run)) !== evidence.digest) {
            throw new Error("evolution_source_revision_changed");
          }
          const text = JSON.stringify(run);
          logToolCall(authorized, HISTORY_RUN_TOOL, text.length, startedAt);
          return { content: [{ type: "text" as const, text }] };
        },
      );
    }
    if (grant.allowedTools.includes(SOURCE_READ_TOOL)) {
      server.registerTool(
        SOURCE_READ_TOOL,
        {
          description:
            "Read one repository baseline file captured by this Context Pack.",
          inputSchema: z.object({ evidenceId: z.string().min(1) }).strict(),
          annotations: readOnlyAnnotations(),
        },
        async ({ evidenceId }) => {
          const authorized = options.tokenRegistry.consume(
            token,
            SOURCE_READ_TOOL,
          );
          const startedAt = performance.now();
          const source = manifest.evidence.find(
            (item) =>
              item.evidenceId === evidenceId &&
              item.source === "repository" &&
              item.origin.path,
          );
          if (!source?.origin.path) {
            throw new Error("evolution_evidence_forbidden");
          }
          const bytes = await readFile(source.origin.path);
          if (
            bytes.byteLength > MAX_SOURCE_BYTES ||
            sha256(bytes) !== source.digest
          ) {
            throw new Error("evolution_source_revision_changed");
          }
          const text = JSON.stringify({
            evidenceId,
            path: source.origin.path,
            sha256: source.digest,
            text: bytes.toString("utf8"),
          });
          logToolCall(authorized, SOURCE_READ_TOOL, text.length, startedAt);
          return { content: [{ type: "text" as const, text }] };
        },
      );
    }
    if (grant.allowedTools.includes(SOURCE_SEARCH_TOOL)) {
      server.registerTool(
        SOURCE_SEARCH_TOOL,
        {
          description:
            "Search only repository baseline files captured by this Context Pack.",
          inputSchema: z
            .object({
              query: z.string().trim().min(1).max(200),
              limit: z.number().int().min(1).max(50).default(20),
            })
            .strict(),
          annotations: readOnlyAnnotations(),
        },
        async ({ query, limit }) => {
          const authorized = options.tokenRegistry.consume(
            token,
            SOURCE_SEARCH_TOOL,
          );
          const startedAt = performance.now();
          const normalizedQuery = query.toLowerCase();
          const hits: Array<{
            evidenceId: string;
            path: string;
            line: number;
            text: string;
          }> = [];
          for (const source of manifest.evidence) {
            if (
              source.source !== "repository" ||
              !source.origin.path ||
              hits.length >= limit
            ) {
              continue;
            }
            const bytes = await readFile(source.origin.path);
            if (
              bytes.byteLength > MAX_SOURCE_BYTES ||
              sha256(bytes) !== source.digest
            ) {
              continue;
            }
            for (const [index, line] of bytes
              .toString("utf8")
              .split(/\r?\n/u)
              .entries()) {
              if (line.toLowerCase().includes(normalizedQuery)) {
                hits.push({
                  evidenceId: source.evidenceId,
                  path: source.origin.path,
                  line: index + 1,
                  text: line.slice(0, 500),
                });
                if (hits.length >= limit) break;
              }
            }
          }
          const text = JSON.stringify(hits);
          logToolCall(authorized, SOURCE_SEARCH_TOOL, text.length, startedAt);
          return { content: [{ type: "text" as const, text }] };
        },
      );
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      logger.warn("evolution.mcp.request.failed", {
        component: "evolution",
        message: "Evolution MCP request failed",
        runId: grant.runId,
        attemptId: grant.attemptId,
        analystRole: grant.analystRole,
        error,
      });
      if (!response.headersSent) {
        response.status(500).json({ error: "evolution_mcp_request_failed" });
      }
    } finally {
      await server.close().catch(() => undefined);
    }
  });

  router.all("/", (_request, response) => {
    response.setHeader("Allow", "POST");
    response.status(405).json({ error: "evolution_mcp_method_not_allowed" });
  });

  return router;
}

function readOnlyAnnotations() {
  return {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
}

function logToolCall(
  grant: EvolutionToolGrant,
  tool: string,
  responseBytes: number,
  startedAt: number,
): void {
  logger.info("evolution.mcp.tool.completed", {
    component: "evolution",
    message: "Evolution MCP tool completed",
    runId: grant.runId,
    attemptId: grant.attemptId,
    analystRole: grant.analystRole,
    tool,
    responseBytes,
    durationMs: Math.round(performance.now() - startedAt),
    resultCode: "ok",
  });
}
