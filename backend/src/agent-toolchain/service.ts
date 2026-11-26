import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import type {
  InboxLiveCheckFact,
  InboxLiveCheckResult,
  InboxLiveCheckState,
} from "@runweave/shared/knowledge-inbox";
import type { RuntimeStatusItem } from "@runweave/shared/runtime-status";
import type { EvolutionRepositoryScopes } from "../evolution/repository-scope";
import { resolveRepositoryIdentity } from "../repository/identity";

const PROBE_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 64 * 1_024;
const PASSED_TTL_MS = 60_000;
const BLOCKED_TTL_MS = 15_000;
const MAX_DIRECTORY_FILES = 5_000;
const MAX_DIRECTORY_BYTES = 64 * 1_024 * 1_024;

interface CachedResult {
  result: InboxLiveCheckResult;
  expiresAt: number;
}

interface ProcessResult {
  status: "ok" | "missing" | "failed" | "timeout" | "too_large";
  stdout: string;
}

interface PluginListEntry {
  pluginId?: unknown;
  version?: unknown;
  source?: { path?: unknown };
  marketplaceSource?: { source?: unknown; sourceType?: unknown };
}

/** Owns bounded, read-only checks for the current Backend node. */
export class AgentToolchainService {
  private closed = false;
  private readonly running = new Map<string, Promise<InboxLiveCheckResult>>();
  private readonly cache = new Map<string, CachedResult>();
  private readonly children = new Set<ReturnType<typeof spawn>>();

  constructor(
    private readonly repositories: EvolutionRepositoryScopes | null,
  ) {}

  async toolkit(): Promise<InboxLiveCheckResult> {
    return this.run("toolkit-cache-consistency", () =>
      this.inspectToolkitCache(),
    );
  }

  async resolveRepositoryRoot(repositoryId: string): Promise<string | null> {
    if (!this.repositories) return null;
    const repository = (await this.repositories.list()).find(
      (item) => item.repositoryId === repositoryId && item.available,
    );
    if (!repository?.paths[0]) return null;
    const identity = await resolveRepositoryIdentity(repository.paths[0]).catch(
      () => null,
    );
    return identity?.repositoryId === repositoryId
      ? identity.worktreeRoot
      : null;
  }

  async runtimeStatusItems(now = Date.now()): Promise<RuntimeStatusItem[]> {
    const toolkit = await this.toolkit();
    return [
      this.runtimeItem(
        "backend.agent-toolchain.toolkit",
        "Toolkit 内容一致性",
        toolkit,
        now,
      ),
    ];
  }

  async dispose(): Promise<void> {
    this.closed = true;
    for (const child of this.children) {
      try {
        if (process.platform !== "win32" && child.pid) {
          process.kill(-child.pid, "SIGKILL");
        } else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
    await Promise.allSettled(this.running.values());
  }

  private run(
    key: string,
    operation: () => Promise<InboxLiveCheckResult>,
  ): Promise<InboxLiveCheckResult> {
    if (this.closed) {
      return Promise.resolve(
        this.result("blocked", "Agent 工具链检查已关闭", [], BLOCKED_TTL_MS),
      );
    }
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return Promise.resolve(cached.result);
    }
    const active = this.running.get(key);
    if (active) return active;
    const result = operation()
      .catch(() =>
        this.result("blocked", "现场检查未能得出结论", [], BLOCKED_TTL_MS),
      )
      .then((value) => {
        this.cache.set(key, {
          result: value,
          expiresAt:
            value.observedAt +
            (value.state === "blocked" || value.state === "failed"
              ? BLOCKED_TTL_MS
              : PASSED_TTL_MS),
        });
        return value;
      })
      .finally(() => this.running.delete(key));
    this.running.set(key, result);
    return result;
  }

  private async inspectToolkitCache(): Promise<InboxLiveCheckResult> {
    const command = await this.command("codex", [
      "plugin",
      "list",
      "--marketplace",
      "runweave",
      "--json",
    ]);
    if (command.status === "missing") {
      return this.result(
        "unsupported",
        "当前节点未安装 Codex CLI",
        [],
        PASSED_TTL_MS,
      );
    }
    if (command.status !== "ok") {
      return this.processFailure("读取 Codex Toolkit 安装状态失败", command);
    }
    let entry: PluginListEntry | undefined;
    try {
      const parsed = JSON.parse(command.stdout) as { installed?: unknown };
      entry = Array.isArray(parsed.installed)
        ? (parsed.installed as PluginListEntry[]).find(
            (item) => item.pluginId === "toolkit@runweave",
          )
        : undefined;
    } catch {
      return this.result(
        "blocked",
        "Codex plugin list 返回了无法识别的结果",
        [],
        BLOCKED_TTL_MS,
      );
    }
    if (!entry || typeof entry.version !== "string") {
      return this.result(
        "unsupported",
        "当前节点未安装 Runweave Toolkit",
        [],
        PASSED_TTL_MS,
      );
    }
    const sourcePath = entry.source?.path;
    const marketplacePath = entry.marketplaceSource?.source;
    if (typeof sourcePath !== "string" || typeof marketplacePath !== "string") {
      return this.result(
        "blocked",
        "Toolkit 来源信息不完整",
        [{ id: "toolkit.version", label: "版本", value: entry.version }],
        BLOCKED_TTL_MS,
      );
    }
    try {
      const [source, marketplace] = await Promise.all([
        realpath(sourcePath),
        realpath(marketplacePath),
      ]);
      if (!isWithin(source, marketplace)) {
        return this.result(
          "failed",
          "Toolkit 安装来源不属于已登记 marketplace",
          [{ id: "toolkit.version", label: "版本", value: entry.version }],
          BLOCKED_TTL_MS,
        );
      }
      const codexHome =
        process.env.CODEX_HOME?.trim() || path.join(homedir(), ".codex");
      const cache = path.join(
        codexHome,
        "plugins",
        "cache",
        "runweave",
        "toolkit",
        entry.version,
      );
      const [cachePath, cacheRoot] = await Promise.all([
        realpath(cache),
        realpath(
          path.join(codexHome, "plugins", "cache", "runweave", "toolkit"),
        ),
      ]);
      if (!isWithin(cachePath, cacheRoot)) {
        return this.result(
          "failed",
          "Toolkit cache 不属于受管目录",
          [{ id: "toolkit.version", label: "版本", value: entry.version }],
          BLOCKED_TTL_MS,
        );
      }
      const comparison = await compareDirectories(source, cachePath);
      const facts: InboxLiveCheckFact[] = [
        { id: "toolkit.version", label: "版本", value: entry.version },
        {
          id: "toolkit.source",
          label: "来源类型",
          value:
            typeof entry.marketplaceSource?.sourceType === "string"
              ? safeText(entry.marketplaceSource.sourceType, 80)
              : "unknown",
        },
        {
          id: "toolkit.files",
          label: "检查文件数",
          value: String(comparison.files),
        },
        {
          id: "toolkit.differences",
          label: "内容差异数",
          value: String(comparison.differences),
        },
      ];
      return this.result(
        comparison.differences === 0 ? "passed" : "failed",
        comparison.differences === 0
          ? "Toolkit source 与 cache 内容一致"
          : "Toolkit source 与 cache 内容不一致",
        facts,
        comparison.differences === 0 ? PASSED_TTL_MS : BLOCKED_TTL_MS,
      );
    } catch {
      return this.result(
        "blocked",
        "无法读取 Toolkit source 或 cache",
        [{ id: "toolkit.version", label: "版本", value: entry.version }],
        BLOCKED_TTL_MS,
      );
    }
  }

  private command(
    binary: string,
    args: string[],
    cwd?: string,
  ): Promise<ProcessResult> {
    return new Promise((resolve) => {
      let stdout = "";
      let bytes = 0;
      let finished = false;
      let forcedStatus: ProcessResult["status"] | null = null;
      const child = spawn(binary, args, {
        cwd,
        env: probeEnvironment(),
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.children.add(child);
      const finish = (status: ProcessResult["status"]): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        this.children.delete(child);
        resolve({ status, stdout: status === "ok" ? stdout.trim() : "" });
      };
      const stop = (status: ProcessResult["status"]): void => {
        if (finished || forcedStatus) return;
        forcedStatus = status;
        try {
          if (process.platform !== "win32" && child.pid) {
            process.kill(-child.pid, "SIGKILL");
          } else child.kill("SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      const timeout = setTimeout(() => stop("timeout"), PROBE_TIMEOUT_MS);
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) stop("too_large");
        else stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) stop("too_large");
      });
      child.once("error", (error: NodeJS.ErrnoException) => {
        finish(
          error.code === "ENOENT" ? "missing" : (forcedStatus ?? "failed"),
        );
      });
      child.once("close", (code) =>
        finish(forcedStatus ?? (code === 0 ? "ok" : "failed")),
      );
    });
  }

  private processFailure(
    summary: string,
    command: ProcessResult,
    facts: InboxLiveCheckFact[] = [],
  ): InboxLiveCheckResult {
    const reason =
      command.status === "timeout"
        ? "现场检查超过 15 秒，未得出结论"
        : command.status === "too_large"
          ? "现场检查输出超过安全上限"
          : summary;
    return this.result("blocked", reason, facts, BLOCKED_TTL_MS);
  }

  private result(
    state: InboxLiveCheckState,
    summary: string,
    facts: InboxLiveCheckFact[],
    validForMs: number,
  ): InboxLiveCheckResult {
    return {
      runId: randomUUID(),
      state,
      observedAt: Date.now(),
      summary: safeText(summary, 240),
      facts: facts.slice(0, 12).map((fact) => ({
        id: safeText(fact.id, 80),
        label: safeText(fact.label, 80),
        value: safeText(fact.value, 240),
      })),
      validForMs,
    };
  }

  private runtimeItem(
    id: string,
    label: string,
    result: InboxLiveCheckResult,
    now: number,
  ): RuntimeStatusItem {
    return {
      id,
      capabilityId: "agent-toolchain",
      label,
      state:
        result.state === "passed"
          ? "healthy"
          : result.state === "failed"
            ? "unhealthy"
            : result.state === "unsupported"
              ? "unconfigured"
              : "blocked",
      summary: result.summary,
      observedAt: result.observedAt || now,
      dependsOn: ["backend.process"],
      recovery: null,
      facts: result.facts.map((fact) => ({
        ...fact,
        kind: "text" as const,
        copyable: false,
      })),
      navigation: null,
    };
  }
}

function probeEnvironment(): NodeJS.ProcessEnv {
  const keys = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "CODEX_HOME",
    "PNPM_HOME",
    "COREPACK_HOME",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
  ];
  return Object.fromEntries(
    keys.flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]],
    ),
  );
}

function safeText(value: string, max: number): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  })
    .join("")
    .trim()
    .slice(0, max);
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

async function compareDirectories(
  source: string,
  cache: string,
): Promise<{ files: number; differences: number }> {
  const [left, right] = await Promise.all([
    directoryManifest(source),
    directoryManifest(cache),
  ]);
  const names = new Set([...left.keys(), ...right.keys()]);
  let differences = 0;
  for (const name of names) {
    if (left.get(name) !== right.get(name)) differences += 1;
  }
  return { files: names.size, differences };
}

async function directoryManifest(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  let bytes = 0;
  const visit = async (relative = ""): Promise<void> => {
    const entries = await readdir(path.join(root, relative), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const name = path.join(relative, entry.name);
      const target = path.join(root, name);
      if (entry.isDirectory()) {
        await visit(name);
        continue;
      }
      if (result.size >= MAX_DIRECTORY_FILES) {
        throw new Error("toolkit_directory_file_limit");
      }
      const stat = await lstat(target);
      if (!stat.isFile()) {
        throw new Error("toolkit_directory_non_file");
      }
      bytes += stat.size;
      if (bytes > MAX_DIRECTORY_BYTES) {
        throw new Error("toolkit_directory_size_limit");
      }
      const digest = createHash("sha256")
        .update(await readFile(target))
        .digest("hex");
      result.set(name, `${stat.mode & 0o111}:${digest}`);
    }
  };
  await visit();
  return result;
}
