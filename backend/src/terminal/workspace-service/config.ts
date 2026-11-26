import { constants } from "node:fs";
import { TextDecoder } from "node:util";
import { lstat, open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  WORKSPACE_SERVICE_CONFIG_FILE_NAME,
  type WorkspaceServiceConfigState,
  type WorktreeSetupDefinition,
} from "@runweave/shared/terminal/workspace-service";
import { readWindowsWorktreeConfig } from "./windows-config-reader";
import { workspaceServiceError } from "./errors";

const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_SERVICES = 12;

const healthCheckSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(2_048)
      .refine((value) => isValidHealthCheckPath(value), {
        message: "healthCheck.path must be a local absolute path",
      }),
  })
  .strict();

const serviceSchema = z
  .object({
    command: z.string().trim().min(1).max(4_096),
    cwd: z.string().trim().min(1).max(512).optional(),
    healthCheck: healthCheckSchema.optional(),
  })
  .strict();

const configSchema = z
  .object({
    schemaVersion: z.literal(1),
    services: z.record(serviceSchema).default({}),
    worktree: z
      .object({ setup: serviceSchema.omit({ healthCheck: true }).optional() })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const entries = Object.entries(value.services);
    if (entries.length > MAX_SERVICES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["services"],
        message: `services cannot contain more than ${MAX_SERVICES} entries`,
      });
    }
    for (const [name] of entries) {
      if (!/^[a-z][a-z0-9-]{0,31}$/u.test(name)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["services", name],
          message: "service name must match ^[a-z][a-z0-9-]{0,31}$",
        });
      }
    }
  });

export interface WorkspaceServiceDefinition {
  name: string;
  command: string;
  cwd: string;
  cwdPath: string;
  healthCheckPath: string | null;
}

export type WorkspaceServiceConfigLoadResult =
  | {
      config: WorkspaceServiceConfigState & { status: "missing" };
      definitions: [];
    }
  | {
      config: WorkspaceServiceConfigState & { status: "invalid" };
      definitions: [];
    }
  | {
      config: WorkspaceServiceConfigState & {
        status: "valid";
        revision: string;
      };
      definitions: WorkspaceServiceDefinition[];
      setup?: WorktreeSetupDefinition & { cwdPath: string };
    };

function isValidHealthCheckPath(value: string): boolean {
  if (!value.startsWith("/")) return false;
  try {
    const parsed = new URL(value, "http://workspace.local");
    return (
      parsed.origin === "http://workspace.local" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}

function invalid(message: string): WorkspaceServiceConfigLoadResult {
  return {
    config: {
      status: "invalid",
      revision: null,
      error: workspaceServiceError("config_invalid", message),
    },
    definitions: [],
  };
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function formatZodError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "runweave.json is invalid";
  const location = issue.path.length > 0 ? issue.path.join(".") : "root";
  return `${location}: ${issue.message}`;
}

export class WorkspaceServiceConfigLoader {
  async load(
    contextPath: string,
    options: { forWorktreeSetup?: boolean } = {},
  ): Promise<WorkspaceServiceConfigLoadResult> {
    const rootPath = await realpath(contextPath).catch(() => null);
    if (!rootPath) {
      return invalid("Project Context path is unavailable");
    }
    const configPath = path.join(rootPath, WORKSPACE_SERVICE_CONFIG_FILE_NAME);
    let fileStats;
    try {
      fileStats = await lstat(configPath);
    } catch (error) {
      if (isMissingFileError(error)) {
        return {
          config: { status: "missing", revision: null, error: null },
          definitions: [],
        };
      }
      return invalid("runweave.json cannot be inspected");
    }
    if (!fileStats.isFile() || fileStats.isSymbolicLink()) {
      return invalid("runweave.json must be a regular file, not a symlink");
    }
    if (fileStats.size > MAX_CONFIG_BYTES) {
      return invalid(`runweave.json exceeds ${MAX_CONFIG_BYTES} bytes`);
    }

    let content: Buffer;
    if (options.forWorktreeSetup && !constants.O_NOFOLLOW) {
      if (process.platform !== "win32")
        return invalid("Safe configuration open is unavailable");
      try {
        content = await readWindowsWorktreeConfig(configPath, MAX_CONFIG_BYTES);
      } catch {
        return invalid("runweave.json cannot be opened safely");
      }
    } else {
      const noFollowFlag = constants.O_NOFOLLOW ?? 0;
      const handle = await open(
        configPath,
        constants.O_RDONLY | noFollowFlag | (constants.O_NONBLOCK ?? 0),
      ).catch(() => null);
      if (!handle) return invalid("runweave.json cannot be opened safely");

      try {
        const before = await handle.stat();
        if (
          !before.isFile() ||
          before.size > MAX_CONFIG_BYTES ||
          before.dev !== fileStats.dev ||
          before.ino !== fileStats.ino
        ) {
          return invalid("runweave.json is not a supported regular file");
        }
        content = await handle.readFile();
        const after = await handle.stat();
        if (
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          content.byteLength !== after.size
        ) {
          return invalid("runweave.json changed while it was being read");
        }
      } finally {
        await handle.close();
      }
    }

    let input: unknown;
    try {
      input = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(content),
      );
    } catch {
      return invalid("runweave.json must contain valid UTF-8 JSON");
    }
    const parsed = configSchema.safeParse(input);
    if (!parsed.success) return invalid(formatZodError(parsed.error));

    const definitions: WorkspaceServiceDefinition[] = [];
    for (const [name, service] of Object.entries(parsed.data.services).sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      const cwd = service.cwd ?? ".";
      if (path.isAbsolute(cwd)) {
        return invalid(`services.${name}.cwd must be relative`);
      }
      const cwdPath = await realpath(path.resolve(rootPath, cwd)).catch(
        () => null,
      );
      if (!cwdPath || !isPathInside(rootPath, cwdPath)) {
        return invalid(
          `services.${name}.cwd must stay inside the Project Context`,
        );
      }
      const cwdStats = await stat(cwdPath).catch(() => null);
      if (!cwdStats?.isDirectory()) {
        return invalid(`services.${name}.cwd must resolve to a directory`);
      }
      definitions.push({
        name,
        command: service.command,
        cwd,
        cwdPath,
        healthCheckPath: service.healthCheck?.path ?? null,
      });
    }

    let setup: (WorktreeSetupDefinition & { cwdPath: string }) | undefined;
    if (parsed.data.worktree?.setup) {
      const { command, cwd = "." } = parsed.data.worktree.setup;
      const cwdPath = await realpath(path.resolve(rootPath, cwd)).catch(
        () => null,
      );
      if (
        path.isAbsolute(cwd) ||
        path.win32.isAbsolute(cwd) ||
        !cwdPath ||
        !isPathInside(rootPath, cwdPath) ||
        !(await stat(cwdPath).catch(() => null))?.isDirectory()
      ) {
        return invalid(
          "worktree.setup.cwd must resolve to a directory inside the Worktree",
        );
      }
      setup = { command, cwd: path.normalize(cwd), cwdPath };
    }
    return {
      config: {
        status: "valid",
        revision: createHash("sha256").update(content).digest("hex"),
        error: null,
      },
      definitions,
      setup,
    };
  }
}
