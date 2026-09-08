import type { WebContents } from "electron";
import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type {
  BrowserTool,
  BrowserToolCall,
  BrowserToolResult,
} from "@runweave/shared/terminal-browser-webmcp";
import { runPageToolOperation, type PageToolRequest } from "./page.js";

async function evaluate<T>(
  contents: WebContents,
  request: PageToolRequest,
): Promise<BrowserToolResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectInvalidated: (error: Error) => void;
  const invalidated = new Promise<never>((_, reject) => {
    rejectInvalidated = reject;
  });
  const onNavigation = (
    _event: Electron.Event,
    _url: string,
    inPlace: boolean,
    mainFrame: boolean,
  ): void => {
    if (mainFrame && !inPlace)
      rejectInvalidated(
        new Error(
          "Page navigated during tool operation; observe the new document",
        ),
      );
  };
  const onDestroyed = (): void =>
    rejectInvalidated(new Error("Page closed during tool operation"));
  contents.on("did-start-navigation", onNavigation);
  contents.on("destroyed", onDestroyed);
  try {
    return await Promise.race([
      invalidated,
      contents.executeJavaScript(
        `(${runPageToolOperation.toString()})(${JSON.stringify(request)})`,
      ) as Promise<BrowserToolResult<T>>,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Page operation timed out")),
          17_000,
        );
      }),
    ]);
  } catch (error) {
    const executing = request.operation === "call";
    return {
      ok: false,
      error: {
        code: executing ? "EXECUTION_UNKNOWN" : "STALE_TOOL",
        message: error instanceof Error ? error.message : String(error),
        execution: executing ? "unknown" : "not-started",
      },
    };
  } finally {
    clearTimeout(timer);
    contents.off("did-start-navigation", onNavigation);
    contents.off("destroyed", onDestroyed);
  }
}

function validateArguments(
  schema: Record<string, unknown>,
  args: Record<string, unknown>,
): BrowserToolResult<null> {
  try {
    if (JSON.stringify(schema).length > 64 * 1024) {
      throw new Error("Tool schema exceeds 64 KiB");
    }
    // No schema downloads, coercion, defaults or silent removal of properties.
    const options = { strict: true, allErrors: false };
    const ajv =
      schema.$schema === "http://json-schema.org/draft-07/schema#"
        ? new Ajv(options)
        : new Ajv2020(options);
    addFormats(ajv);
    const validate = ajv.compile(schema);
    if ("$async" in validate && validate.$async)
      throw new Error("Async schemas are not supported");
    if (!validate(args)) {
      return {
        ok: false,
        error: {
          code: "INVALID_ARGUMENTS",
          message: ajv.errorsText(validate.errors),
          execution: "not-started",
        },
      };
    }
    return { ok: true, value: null };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "UNSUPPORTED_SCHEMA",
        message: error instanceof Error ? error.message : String(error),
        execution: "not-started",
      },
    };
  }
}

export async function runBrowserToolCommand(
  contents: WebContents,
  request: BrowserToolCall | null,
  onExecution: (
    name: string,
    status: "running" | "succeeded" | "unknown",
  ) => void,
): Promise<BrowserToolResult<unknown>> {
  if (!request) return evaluate(contents, { operation: "list" });
  const inspected = await evaluate<BrowserTool>(contents, {
    operation: "inspect",
    toolId: request.toolId,
  });
  if (!inspected.ok) return inspected;
  const validated = validateArguments(
    inspected.value.inputSchema,
    request.arguments,
  );
  if (!validated.ok) return validated;
  onExecution(inspected.value.name, "running");
  const result = await evaluate(contents, {
    operation: "call",
    toolId: request.toolId,
    arguments: request.arguments,
    schema: JSON.stringify(inspected.value.inputSchema),
  });
  onExecution(inspected.value.name, result.ok ? "succeeded" : "unknown");
  return result;
}
