import { z } from "zod";
export {
  resolveTerminalCreateDefaults,
  TerminalCreateDefaultsError,
} from "../../../terminal/application/create-defaults";
export {
  buildTerminalInputOperationId,
  TERMINAL_INTERRUPT_ESCAPE_INPUT,
} from "../../../terminal/application/input-operation";

export const createTerminalSessionSchema = z
  .object({
    projectId: z.string().trim().min(1).optional(),
    command: z.string().trim().min(1).optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().trim().min(1).optional(),
    inheritFromTerminalSessionId: z.string().trim().min(1).optional(),
    runtimePreference: z.enum(["auto", "tmux", "pty"]).optional(),
  })
  .strict();

export const updateTerminalSessionSchema = z
  .object({
    alias: z.string().trim().max(80).nullable().optional(),
    pinned: z.boolean().optional(),
    panelSplitEnabled: z.boolean().optional(),
    acknowledgedCompletionRevision: z.number().int().nonnegative().optional(),
  })
  .strict();

export const sendTerminalInputSchema = z
  .object({
    data: z.string(),
    mode: z
      .enum([
        "raw",
        "line",
        "codex_slash_command",
        "prompt_paste",
        "prompt_replace",
        "tmux_exit_copy_mode",
      ])
      .optional(),
    submit: z.boolean().optional(),
    submitKey: z.enum(["Enter", "Tab", "M-Enter"]).optional(),
    recordQuickInput: z.boolean().optional(),
    operationId: z.string().trim().min(1).optional(),
    quickInputSource: z
      .enum([
        "web_terminal_quick_input",
        "web_git_submit",
        "web_browser_annotation",
        "api_terminal_input",
      ])
      .optional(),
    panelId: z.string().trim().min(1).optional(),
    panelAlias: z.string().trim().min(1).optional(),
    role: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.submitKey === undefined ||
      (input.mode === "prompt_replace" && input.submit === true),
    { message: "submitKey requires prompt_replace with submit=true" },
  );

export const sendTerminalInterruptSchema = z
  .object({
    operationId: z.string().trim().min(1).optional(),
    panelId: z.string().trim().min(1).optional(),
    panelAlias: z.string().trim().min(1).optional(),
    role: z.string().trim().min(1).optional(),
  })
  .strict();

export function sanitizeTerminalError(error: unknown): string {
  const hookToken = process.env.RUNWEAVE_HOOK_TOKEN?.trim();
  const raw = String(error);
  const withoutKnownToken = hookToken
    ? raw.replaceAll(hookToken, "[redacted]")
    : raw;
  return withoutKnownToken.replace(
    /RUNWEAVE_HOOK_TOKEN=[^\s'"]+/g,
    "RUNWEAVE_HOOK_TOKEN=[redacted]",
  );
}
