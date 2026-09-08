import type {
  BrowserTool,
  BrowserToolErrorCode,
  BrowserToolResult,
} from "@runweave/shared/terminal-browser-webmcp";

export interface PageToolRequest {
  operation: "list" | "inspect" | "call";
  toolId?: string;
  arguments?: Record<string, unknown>;
  schema?: string;
}

interface NativeTool {
  name: string;
  description: string;
  origin: string;
  window: Window;
  inputSchema: string | Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

interface ModelContext extends EventTarget {
  getTools(): Promise<NativeTool[]>;
  executeTool(
    tool: NativeTool,
    input: string,
    options: { signal: AbortSignal },
  ): Promise<string | null>;
}

interface PageToolState {
  tools: Map<string, { native: NativeTool; descriptor: BrowserTool }>;
  revision: number;
}

/** Serialized into the top-level document. Keep all runtime helpers inside. */
export async function runPageToolOperation(
  request: PageToolRequest,
): Promise<BrowserToolResult<unknown>> {
  const fail = (
    code: BrowserToolErrorCode,
    message: string,
    execution: "not-started" | "unknown" = "not-started",
  ): BrowserToolResult<never> => ({
    ok: false,
    error: { code, message, execution },
  });
  const context = (document as Document & { modelContext?: ModelContext })
    .modelContext;
  if (!context?.getTools || !context.executeTool) {
    return request.operation === "list"
      ? { ok: true, value: { supported: false, tools: [] } }
      : fail("WEBMCP_UNAVAILABLE", "WebMCP is unavailable in this document");
  }
  const host = window as Window & { __runweaveWebMcp?: PageToolState };
  if (!host.__runweaveWebMcp) {
    const initial: PageToolState = { tools: new Map(), revision: 0 };
    host.__runweaveWebMcp = initial;
    context.addEventListener("toolchange", () => {
      initial.tools.clear();
      initial.revision++;
    });
  }
  const state = host.__runweaveWebMcp;
  const revision = state.revision;
  const nativeTools = (await context.getTools()).filter(
    (tool) => tool.window === window && tool.origin === location.origin,
  );
  if (revision !== state.revision) {
    return fail("STALE_TOOL", "Tools changed during discovery; list again");
  }

  if (request.operation === "list") {
    if (nativeTools.length > 128) {
      return fail("UNSUPPORTED_SCHEMA", "At most 128 page tools are supported");
    }
    const descriptors: BrowserTool[] = [];
    for (const native of nativeTools) {
      const schema =
        typeof native.inputSchema === "string"
          ? JSON.parse(native.inputSchema)
          : native.inputSchema;
      const previous = [...state.tools.values()].find(
        ({ descriptor }) =>
          descriptor.name === native.name &&
          JSON.stringify(descriptor.inputSchema) === JSON.stringify(schema),
      );
      const descriptor: BrowserTool = {
        toolId: previous?.descriptor.toolId ?? crypto.randomUUID(),
        name: native.name,
        description: native.description,
        origin: native.origin,
        inputSchema: schema,
        annotations: native.annotations,
      };
      state.tools.set(descriptor.toolId, { native, descriptor });
      descriptors.push(descriptor);
    }
    const currentIds = new Set(descriptors.map((tool) => tool.toolId));
    for (const id of state.tools.keys()) {
      if (!currentIds.has(id)) state.tools.delete(id);
    }
    return { ok: true, value: { supported: true, tools: descriptors } };
  }

  const entry = state.tools.get(request.toolId ?? "");
  const live =
    entry && nativeTools.find((tool) => tool.name === entry.native.name);
  const liveSchema =
    live &&
    (typeof live.inputSchema === "string"
      ? JSON.parse(live.inputSchema)
      : live.inputSchema);
  if (
    !entry ||
    !live ||
    JSON.stringify(liveSchema) !== JSON.stringify(entry.descriptor.inputSchema)
  ) {
    return fail("STALE_TOOL", "Tool is no longer current; list tools again");
  }
  if (request.operation === "inspect") {
    return { ok: true, value: entry.descriptor };
  }
  if (request.schema !== JSON.stringify(liveSchema)) {
    return fail("STALE_TOOL", "Tool schema changed before execution");
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(
          "Tool exceeded 15 seconds; its effects may still complete",
        );
        reject(error);
        controller.abort(error);
      }, 15_000);
    });
    const output = await Promise.race([
      context.executeTool(entry.native, JSON.stringify(request.arguments), {
        signal: controller.signal,
      }),
      timeout,
    ]);
    if (output === null) {
      return fail(
        "EXECUTION_UNKNOWN",
        "Tool navigated; observe the page before continuing",
        "unknown",
      );
    }
    return { ok: true, value: { output } };
  } catch (error) {
    return fail(
      "EXECUTION_UNKNOWN",
      error instanceof Error ? error.message : String(error),
      "unknown",
    );
  } finally {
    clearTimeout(timer);
  }
}
