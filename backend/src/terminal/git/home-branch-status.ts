import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import type { AppHomeBranchStatus } from "@runweave/shared/terminal/session";

const exec = promisify(execFile);
const TTL = 10 * 60_000;
type Snapshot = Omit<AppHomeBranchStatus, "terminalSessionId" | "cwd">;
type Entry<T> = { at: number; value?: T; pending?: Promise<T>; failed?: boolean };

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd, timeout: 8_000, maxBuffer: 512 * 1024,
    env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never", GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=5" },
  });
  return stdout.trim();
}

/** Request-owned work only; no timers. Shared per router, including across mobile clients. */
export class HomeBranchStatusService {
  private readonly snapshots = new Map<string, Entry<Snapshot>>();
  private readonly remotes = new Map<string, Entry<{ base: string; oid: string; checkedAt: string }>>();
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  private async limited<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= 4) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try { return await work(); }
    finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }

  private entry<T>(map: Map<string, Entry<T>>, key: string): Entry<T> {
    let entry = map.get(key);
    if (!entry) {
      // Bound completed cache entries; in-flight entries must retain their coalescing identity.
      if (map.size >= 512) {
        for (const [id, value] of map) {
          if (!value.pending) { map.delete(id); if (map.size < 512) break; }
        }
      }
      entry = { at: 0 };
      map.set(key, entry);
    }
    return entry;
  }

  async status(terminalSessionId: string, cwd: string, refresh = false): Promise<AppHomeBranchStatus> {
    const entry = this.entry(this.snapshots, cwd);
    const remoteExpired = entry.value?.state === "ready" && entry.value.checkedAt
      && Date.now() - Date.parse(entry.value.checkedAt) >= TTL;
    if (!entry.pending && (!entry.value || remoteExpired || Date.now() - entry.at >= (refresh ? 2_000 : TTL))) {
      entry.pending = this.limited(() => this.compare(cwd, refresh)).catch((): Snapshot =>
        entry.value?.behind !== undefined
          ? { ...entry.value, state: "stale" } : { state: "unavailable" },
      ).then((value) => { entry.value = value; entry.at = Date.now(); return value; })
        .finally(() => { entry.pending = undefined; });
    }
    const snapshot = entry.pending ? await entry.pending : entry.value!;
    return { terminalSessionId, cwd, ...snapshot };
  }

  private async compare(cwd: string, refresh: boolean): Promise<Snapshot> {
    // A missing directory or inaccessible Git repository is unknown, not an empty comparison.
    try { await git(cwd, ["rev-parse", "--show-toplevel"]); }
    catch (error) {
      if (String((error as { stderr?: string }).stderr).includes("not a git repository")) {
        return { state: "not-repository" };
      }
      throw error;
    }
    if (await git(cwd, ["rev-parse", "--is-shallow-repository"]) === "true") {
      return { state: "unavailable" };
    }
    const common = await realpath(await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
    const remotes = (await git(cwd, ["remote"])).split("\n").filter(Boolean);
    const remote = remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : undefined;
    if (!remote) return { state: "unavailable" };
    const url = await git(cwd, ["remote", "get-url", remote]);
    const entry = this.entry(this.remotes, `${common}\0${remote}\0${url}`);
    if (!entry.pending && (!entry.at || Date.now() - entry.at >= (refresh ? 2_000 : TTL))) {
      entry.pending = (async () => {
        const head = await git(cwd, ["ls-remote", "--symref", remote, "HEAD"]);
        const base = /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(head)?.[1];
        if (!base) throw new Error("Remote default branch unavailable");
        await git(cwd, ["fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head",
          remote, `+refs/heads/${base}:refs/remotes/${remote}/${base}`]);
        const oid = await git(cwd, ["rev-parse", "--verify", `refs/remotes/${remote}/${base}^{commit}`]);
        const value = { base, oid, checkedAt: new Date().toISOString() };
        entry.value = value;
        entry.failed = false;
        return value;
      })().catch((error: unknown) => { entry.failed = true; throw error; }).finally(() => { entry.at = Date.now(); entry.pending = undefined; });
    }
    const base = entry.pending ? await entry.pending : entry.value;
    if (!base || entry.failed) throw new Error("Remote default branch unavailable");
    const head = await git(cwd, ["rev-parse", "--verify", "HEAD^{commit}"]);
    // Reject unrelated histories rather than suggesting a meaningless rebase count.
    await git(cwd, ["merge-base", head, base.oid]);
    const behind = Number(await git(cwd, ["rev-list", "--count", `${head}..${base.oid}`]));
    if (!Number.isSafeInteger(behind) || behind < 0) throw new Error("Invalid Git count");
    return { state: "ready", baseBranch: base.base, behind, checkedAt: base.checkedAt };
  }
}
