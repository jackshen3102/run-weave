import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  configurationPath,
  settingText,
  resolveConfigurationContext,
} from "@runweave/config-node";
import { Backend } from "./backend.js";
import { readChunk } from "./files.js";
import { Evidence } from "./evidence.js";

export interface FileSource {
  id: string;
  path: string;
  description: string;
}

export function fileSources(cwd: string, extra: string[]): FileSource[] {
  const home = os.homedir();
  return [
    {
      id: "logs",
      path:
        settingText("logging.backendDirectory") ??
        path.join(
          configurationPath("storage.browserProfileDirectory", "backend"),
          "logs/backend",
        ),
      description:
        "Backend JSONL logs; default rotation 3 days; file mtime is not event time",
    },
    {
      id: "codex",
      path: path.join(
        process.env.CODEX_HOME ?? path.join(home, ".codex"),
        "sessions",
      ),
      description:
        "Native Codex JSONL including tool calls/results; partial provider coverage",
    },
    {
      id: "pi",
      path: path.join(
        process.env.PI_CODING_AGENT_DIR ?? path.join(home, ".pi/agent"),
        "sessions",
      ),
      description: "Native Pi session JSONL",
    },
    {
      id: "claude",
      path: path.join(
        process.env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"),
        "projects",
      ),
      description: "Native Claude project histories",
    },
    {
      id: "workspace",
      path: cwd,
      description:
        "Local worktree files; Git HEAD/dirty state must be checked with run_command",
    },
    ...extra.map((p, i) => ({
      id: `extra${i + 1}`,
      path: p,
      description: "User-supplied local data location",
    })),
  ];
}

export async function listSources(backend: Backend, files: FileSource[]) {
  const endpoints = {
    health: "/health",
    projects: "/api/terminal/project",
    activity: "/api/activity/policy",
    status: "/api/runtime-status",
    threads: "/api/app-server/threads",
  };
  const remote = await Promise.all(
    Object.entries(endpoints).map(async ([id, route]) => {
      try {
        return {
          id,
          route,
          availability: "available",
          data: await backend.get(route, id === "threads" ? { limit: 10 } : {}),
        };
      } catch (error) {
        return {
          id,
          route,
          availability: "unavailable",
          reason: String(error),
        };
      }
    }),
  );
  const local = await Promise.all(
    files.map(async (source) => {
      try {
        await stat(source.path);
        return { ...source, availability: "available" };
      } catch {
        return { ...source, availability: "unavailable" };
      }
    }),
  );
  return {
    node: os.hostname(),
    instance: resolveConfigurationContext().instanceId,
    observedAt: new Date().toISOString(),
    backend: remote,
    files: local,
    notes: [
      "File locations belong to this MCP host; a remote Backend can be a different node.",
      "Activity default retention: facts 30 days, content 7 days; inspect actual policy.",
      "Status is current, not historical. Use raw files for native tool evidence.",
      "Other projects' production databases require actual connections; discover them with run_command.",
      "run_command has the host account's full read/write access. Query filters are not permissions.",
    ],
  };
}

export async function searchFiles(
  root: string,
  query: string,
  evidence: Evidence,
  maxFiles = 100,
) {
  const results: Array<{ id: string; title: string; url: string }> = [];
  let files = 0;
  let scannedBytes = 0;
  let entries = 0;
  let truncated = false;
  const errors: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    if (truncated) return;
    let children;
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      errors.push(String(error));
      return;
    }
    children.sort((a, b) => b.name.localeCompare(a.name));
    for (const child of children) {
      if (
        ++entries > 5000 ||
        files >= maxFiles ||
        results.length >= 25 ||
        scannedBytes >= 8 * 1024 * 1024
      ) {
        truncated = true;
        return;
      }
      if (
        ["node_modules", ".git", "dist"].includes(child.name) ||
        child.isSymbolicLink()
      )
        continue;
      const file = path.join(directory, child.name);
      if (child.isDirectory()) {
        await walk(file);
        if (truncated) return;
      } else if (
        child.isFile() &&
        /\.(jsonl|json|log|md|txt|ts|tsx|js|py|yaml|yml|sql)$/.test(child.name)
      ) {
        files++;
        try {
          const size = (await stat(file)).size;
          // Recent tails are useful for live logs and large native sessions.
          const offset = Math.max(0, size - 65_536);
          const chunk = await readChunk(file, offset, 65_536);
          scannedBytes += Buffer.byteLength(chunk.text);
          if (chunk.text.includes(query) || file.includes(query))
            results.push(await evidence.file(file, offset));
          if (offset > 0) errors.push(`tail_only: ${file}`);
        } catch (error) {
          errors.push(String(error));
        }
      }
    }
  };
  await walk(root);
  return {
    results,
    scannedFiles: files,
    scannedBytes,
    truncated,
    coverage: "bounded_keyword_search",
    errors: errors.slice(0, 20),
    note: "Search scans file tails in descending path order, not complete history. Use run_command with rg or fetch a specific file for exhaustive exploration.",
  };
}
