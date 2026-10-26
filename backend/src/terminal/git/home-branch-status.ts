import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import type { AppHomeBranchStatus } from "@runweave/shared/terminal/session";

import { BRANCH_UPDATES_LIMIT, type BranchUpdatesResponse, type BranchUpdatesTarget, type BranchUpdatesSnapshot } from "@runweave/shared/terminal/branch-updates";

export class BranchUpdatesTargetChangedError extends Error {
  constructor() { super("Branch updates target changed"); }
}

type Comparison =
  | { state: "ready"; head: string; remote: string; base: string; oid: string; checkedAt: string }
  | { state: "not-repository" | "unavailable"; reason?: BranchUpdatesResponse["reason"] };

const exec = promisify(execFile);
const TTL = 10 * 60_000;
const RECHECK_TTL = 2_000;
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
  private readonly updates = new Map<string, Entry<Omit<BranchUpdatesResponse, "target">>>();
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
    // Local HEAD can change while the remote snapshot is still fresh.
    if (!entry.pending && (!entry.value || remoteExpired || Date.now() - entry.at >= RECHECK_TTL)) {
      entry.pending = this.limited(() => this.compare(cwd, refresh)).catch((): Snapshot =>
        entry.value?.behind !== undefined
          ? { ...entry.value, state: "stale" } : { state: "unavailable" },
      ).then((value) => { entry.value = value; entry.at = Date.now(); return value; })
        .finally(() => { entry.pending = undefined; });
    }
    const snapshot = entry.pending ? await entry.pending : entry.value!;
    return { terminalSessionId, cwd, ...snapshot };
  }

  async branchUpdates(target: BranchUpdatesTarget, refresh = false): Promise<BranchUpdatesResponse> {
    const cwd = target.kind === "project" ? target.path : target.cwd;
    let directory: string;
    try { directory = await realpath(cwd); }
    catch { return { target, state: "unavailable" }; }
    const entry = this.entry(this.updates, directory);
    if (!entry.pending) {
      entry.pending = this.limited(async () => {
        let value: Omit<BranchUpdatesResponse, "target">;
        const startingHead = await git(directory, ["rev-parse", "--verify", "HEAD^{commit}"]).catch(() => null);
        const startingBranch = await this.currentBranch(directory).catch(() => undefined);
        try {
          const comparison = await this.comparison(directory, refresh);
          if (comparison.state !== "ready") return comparison;
          const currentBranch = await this.currentBranch(directory);
          if (startingHead !== comparison.head || startingBranch !== currentBranch) throw new BranchUpdatesTargetChangedError();
          const previous = entry.value?.snapshot;
          let snapshot: BranchUpdatesSnapshot;
          if (previous?.headOid === comparison.head && previous.baseOid === comparison.oid
            && previous.currentBranch === currentBranch) {
            snapshot = { ...previous, checkedAt: comparison.checkedAt };
          } else {
            const output = await git(directory, ["log", "--date-order", `--max-count=${BRANCH_UPDATES_LIMIT}`,
              "-z", "--format=%H%x00%s%x00%an%x00%cI", `${comparison.head}..${comparison.oid}`, "--"]);
            const fields = output.split("\0");
            if (fields.pop() !== "" || fields.length % 4) throw new Error("Invalid commit list");
            const items: BranchUpdatesSnapshot["items"] = [];
            for (let i = 0; i < fields.length; i += 4) {
              const [oid, subject, authorName, committedAt] = fields.slice(i, i + 4);
              if (oid === undefined || subject === undefined || authorName === undefined || committedAt === undefined
                || !/^[a-f0-9]{40,64}$/.test(oid) || !Number.isFinite(Date.parse(committedAt))) {
                throw new Error("Invalid commit metadata");
              }
              items.push({ oid, subject, authorName, committedAt });
            }
            snapshot = { headOid: comparison.head, currentBranch, baseRemote: comparison.remote,
              baseBranch: comparison.base, baseOid: comparison.oid, checkedAt: comparison.checkedAt, items };
          }
          value = { state: "ready", snapshot };
        } catch (error) {
          if (error instanceof BranchUpdatesTargetChangedError) throw error;
          const previous = entry.value?.snapshot;
          // Never relabel another HEAD or branch's cached titles as the current target.
          const [head, branch] = await Promise.all([
            git(directory, ["rev-parse", "--verify", "HEAD^{commit}"]).catch(() => null),
            this.currentBranch(directory).catch(() => undefined),
          ]);
          value = previous && head === previous.headOid && branch === previous.currentBranch
            ? { state: "stale", snapshot: previous, reason: "remote-unavailable" }
            : { state: "unavailable", reason: "remote-unavailable" };
        }
        if (await realpath(cwd).catch(() => null) !== directory
          || (value.snapshot && (await git(directory, ["rev-parse", "--verify", "HEAD^{commit}"]) !== value.snapshot.headOid
            || await this.currentBranch(directory) !== value.snapshot.currentBranch))) {
          throw new BranchUpdatesTargetChangedError();
        }
        return value;
      }).then((value) => {
        entry.value = value;
        if (value.state === "ready") { this.snapshots.delete(cwd); this.snapshots.delete(directory); }
        return value;
      })
        .finally(() => { entry.pending = undefined; });
    }
    const value = await entry.pending;
    if (await realpath(cwd).catch(() => null) !== directory) throw new BranchUpdatesTargetChangedError();
    return { target, ...value };
  }

  private async currentBranch(cwd: string): Promise<string | null> {
    try { return await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]); }
    catch (error) {
      if ((error as { code?: number }).code === 1) return null;
      throw error;
    }
  }

  private async compare(cwd: string, refresh: boolean): Promise<Snapshot> {
    const comparison = await this.comparison(cwd, refresh);
    if (comparison.state !== "ready") return { state: comparison.state };
    const behind = Number(await git(cwd, ["rev-list", "--count", `${comparison.head}..${comparison.oid}`]));
    if (!Number.isSafeInteger(behind) || behind < 0) throw new Error("Invalid Git count");
    return { state: "ready", baseBranch: comparison.base, behind, checkedAt: comparison.checkedAt };
  }

  private async comparison(cwd: string, refresh: boolean): Promise<Comparison> {
    // A missing directory or inaccessible Git repository is unknown, not an empty comparison.
    try { await git(cwd, ["rev-parse", "--show-toplevel"]); }
    catch (error) {
      if (String((error as { stderr?: string }).stderr).includes("not a git repository")) {
        return { state: "not-repository" };
      }
      throw error;
    }
    if (await git(cwd, ["rev-parse", "--is-shallow-repository"]) === "true") {
      return { state: "unavailable", reason: "shallow-repository" };
    }
    const common = await realpath(await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
    const remotes = (await git(cwd, ["remote"])).split("\n").filter(Boolean);
    const remote = remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : undefined;
    if (!remote) return { state: "unavailable" };
    const url = await git(cwd, ["remote", "get-url", remote]);
    const entry = this.entry(this.remotes, `${common}\0${remote}\0${url}`);
    // Failed fetches only coalesce bursts; clients control the retry interval.
    if (!entry.pending && (!entry.at || Date.now() - entry.at >= (refresh || entry.failed ? RECHECK_TTL : TTL))) {
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
    try { await git(cwd, ["merge-base", head, base.oid]); }
    catch (error) {
      if ((error as { code?: number }).code === 1) return { state: "unavailable", reason: "unrelated-history" };
      throw error;
    }
    return { state: "ready", head, remote, ...base };
  }
}
