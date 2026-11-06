import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkReportService } from "../work-reports/service";
import type { Mutation } from "../records/mutations";
import { keySchema, uuid } from "../schema";
import * as schema from "../work-reports/schema";
import { executeTool, result } from "./results";

export function registerWorkReports(server: McpServer, service: WorkReportService, owner: string, requestId: string) {
  const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const context = (key: string): Mutation => ({ ownerId: owner, actor: "agent", key, requestId });
  server.registerTool("find_work_report", { description: "按七个自然日的起止日期读取已保存周报；不存在返回null。", inputSchema: schema.period, annotations: read },
    input => executeTool("find_work_report", requestId, async () => result({ report: await service.find(owner, input) })));
  server.registerTool("get_work_report", { description: "读取工作周报完整正文、来源事实版本及覆盖快照。", inputSchema: z.object({ reportId: uuid }).strict(), annotations: read },
    ({ reportId }) => executeTool("get_work_report", requestId, async () => result({ report: await service.get(owner, reportId) })));
  server.registerTool("publish_work_report", { description: "按明确授权保存过去七个自然日周报到工作页。必须读取该范围全部事实和当前feedRevision；同周期唯一，版本冲突或人工编辑时停止；未知结果仅核对原请求，不换键重试。", inputSchema: z.object({ idempotencyKey: keySchema, input: schema.publish }).strict(), annotations: { ...read, readOnlyHint: false } },
    ({ idempotencyKey, input }) => executeTool("publish_work_report", requestId, async () => result(await service.publish(context(idempotencyKey), input))));
}
