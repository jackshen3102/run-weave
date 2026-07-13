import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type {
  AgentTeamActiveWorkerDispatch,
  AgentTeamExportOutboxHistory,
  AgentTeamOutboxHistoryRecord,
  AgentTeamRun,
} from "@runweave/shared/agent-team";
import type { AgentTeamResolvedOutbox } from "../outbox-resolver";
import type { AgentTeamPaths } from "./agent-team-paths";

export class AgentTeamOutboxHistoryStore {
  constructor(private readonly paths: AgentTeamPaths) {}

  async archive(options: {
    run: AgentTeamRun;
    dispatch: AgentTeamActiveWorkerDispatch;
    resolvedOutbox: AgentTeamResolvedOutbox;
    cwd?: string | null;
  }): Promise<{ path: string; record: AgentTeamOutboxHistoryRecord }> {
    const { run, dispatch, resolvedOutbox } = options;
    if (resolvedOutbox.mtimeMs === null) {
      throw new Error("outbox mtime is unavailable");
    }
    const contentSha256 = createHash("sha256")
      .update(resolvedOutbox.rawContent)
      .digest("hex");
    const dispatchId =
      dispatch.dispatchId ?? createLegacyDispatchId(run, dispatch);
    const archivePath = this.paths.outboxHistoryPath(
      run.projectId,
      run.runId,
      run.loop.round,
      {
        role: dispatch.role,
        panelId: dispatch.panelId,
        tmuxPaneId: dispatch.tmuxPaneId,
        dispatchId,
        contentSha256,
      },
      options.cwd ?? run.terminal.cwd,
    );
    const record: AgentTeamOutboxHistoryRecord = {
      schemaVersion: 1,
      runId: run.runId,
      round: run.loop.round,
      dispatchId,
      role: dispatch.role,
      panelId: dispatch.panelId,
      tmuxPaneId: dispatch.tmuxPaneId,
      requestedAt: dispatch.requestedAt,
      recordedAt: new Date().toISOString(),
      sourcePath: resolvedOutbox.path,
      sourceMtimeMs: resolvedOutbox.mtimeMs,
      contentSha256,
      rawContent: resolvedOutbox.rawContent,
      outbox: resolvedOutbox.outbox,
    };
    const existing = await createImmutableJsonFile(archivePath, record);
    return { path: archivePath, record: existing ?? record };
  }

  async list(
    projectId: string | null,
    runId: string,
    cwd?: string | null,
  ): Promise<AgentTeamExportOutboxHistory[]> {
    const root = this.paths.outboxHistoryDir(projectId, runId, cwd);
    let roundDirectories;
    try {
      roundDirectories = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return [];
      }
      throw error;
    }
    const paths = (
      await Promise.all(
        roundDirectories
          .filter((entry) => entry.isDirectory())
          .map(async (entry) => {
            const directory = path.join(root, entry.name);
            const files = await readdir(directory, { withFileTypes: true });
            return files
              .filter((file) => file.isFile() && file.name.endsWith(".json"))
              .map((file) => path.join(directory, file.name));
          }),
      )
    ).flat();
    return Promise.all(
      paths.sort().map(async (archivePath) => {
        try {
          const record = JSON.parse(
            await readFile(archivePath, "utf8"),
          ) as AgentTeamOutboxHistoryRecord;
          if (!isHistoryRecord(record, runId)) {
            throw new Error("invalid outbox history schema");
          }
          return { path: archivePath, record };
        } catch (error) {
          return {
            path: archivePath,
            record: null,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
  }
}

async function createImmutableJsonFile(
  archivePath: string,
  record: AgentTeamOutboxHistoryRecord,
): Promise<AgentTeamOutboxHistoryRecord | null> {
  await mkdir(path.dirname(archivePath), { recursive: true });
  const temporaryPath = `${archivePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  try {
    await link(temporaryPath, archivePath);
    return null;
  } catch (error) {
    if (errorCode(error) !== "EEXIST") {
      throw error;
    }
    const existing = JSON.parse(
      await readFile(archivePath, "utf8"),
    ) as AgentTeamOutboxHistoryRecord;
    if (
      !isHistoryRecord(existing, record.runId) ||
      existing.dispatchId !== record.dispatchId ||
      existing.contentSha256 !== record.contentSha256 ||
      existing.rawContent !== record.rawContent
    ) {
      throw new Error(`outbox history collision at ${archivePath}`);
    }
    return existing;
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function createLegacyDispatchId(
  run: AgentTeamRun,
  dispatch: AgentTeamActiveWorkerDispatch,
): string {
  const digest = createHash("sha256")
    .update(
      [
        run.runId,
        dispatch.role,
        dispatch.panelId ?? "",
        dispatch.tmuxPaneId ?? "",
        dispatch.requestedAt,
      ].join("\0"),
    )
    .digest("hex")
    .slice(0, 20);
  return `legacy-${digest}`;
}

function isHistoryRecord(
  value: AgentTeamOutboxHistoryRecord,
  runId: string,
): boolean {
  return (
    value?.schemaVersion === 1 &&
    value.runId === runId &&
    typeof value.dispatchId === "string" &&
    typeof value.contentSha256 === "string" &&
    typeof value.rawContent === "string" &&
    Boolean(value.outbox)
  );
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
}
