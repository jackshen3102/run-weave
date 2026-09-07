import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RecordPage } from "@runweave/shared/suiji";
import { ServiceError } from "../errors";

export function result(value: Record<string, unknown>): CallToolResult {
  return {
    structuredContent: value,
    content: [{ type: "text", text: JSON.stringify(value) }],
  };
}

export function summaries(page: RecordPage) {
  return {
    items: page.items.map(({ body, ...record }) => {
      const scalars = [...body];
      return {
        ...record,
        excerpt: scalars.slice(0, 300).join(""),
        excerptIsFullBody: scalars.length <= 300,
      };
    }),
    nextCursor: page.nextCursor,
  };
}

export async function executeTool(
  tool: string,
  requestId: string,
  run: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const start = Date.now();
  let code = "OK";
  try {
    return await run();
  } catch (error) {
    const e =
      error instanceof ServiceError
        ? error
        : new ServiceError(
            503,
            "DEPENDENCY_UNAVAILABLE",
            "服务暂时不可用；写入结果不确定时保留原幂等键与完整参数，等待用户重试",
          );
    code = e.code;
    return {
      ...result({
        ok: false,
        error: {
          code: e.code,
          message: e.message,
          retryable: e.status === 503 || e.status === 429,
          ...(e.details ? { details: e.details } : {}),
        },
        requestId,
      }),
      isError: true,
    };
  } finally {
    console.log(
      JSON.stringify({
        event: "mcp_tool",
        tool,
        requestId,
        code,
        durationMs: Date.now() - start,
      }),
    );
  }
}
