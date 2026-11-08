import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { CodeReviewSnapshot, CodeReviewSnapshotEntry, CodeReviewSnapshotSide } from "@runweave/shared/terminal/code-review";
import type { TerminalPreviewContentSide } from "@runweave/shared/terminal/preview";
import { getPreviewGitChanges } from "../preview/git";
import { readChangeContent } from "../preview/change-content";
import { CodeReviewError } from "./store";
const exec = promisify(execFile);
export const reviewDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function git(root: string, args: string[]) {
  return (await exec("git", args, { cwd: root, timeout: 5000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_LITERAL_PATHSPECS: "1", GIT_OPTIONAL_LOCKS: "0" } })).stdout;
}
async function head(root: string): Promise<string | null> {
  try { return (await git(root, ["rev-parse", "--verify", "HEAD"])).trim(); }
  catch {
    // An unborn HEAD is valid; other repository errors must not become an empty baseline.
    const ref = (await git(root, ["symbolic-ref", "-q", "HEAD"])).trim();
    const refs = await git(root, ["for-each-ref", "--format=%(refname)", ref]);
    if (refs.trim()) throw new CodeReviewError(409, "snapshot_unstable", "HEAD 无法读取");
    return null;
  }
}
async function capture(projectId: string, rootPath: string) {
  const list = await getPreviewGitChanges({ projectId, projectPath: rootPath });
  if (!list.repoRoot) throw new CodeReviewError(400, "not_git", "当前工作区不是 Git 仓库");
  const beforeHead = await head(rootPath);
  const repoRoot = list.repoRoot;
  const prefix = path.relative(repoRoot, rootPath).split(path.sep).join("/");
  const repoPath = (file: string) => prefix ? `${prefix}/${file}` : file;
  let stable = true;
  let total = 0;
  const entries: CodeReviewSnapshotEntry[] = [];
  const stamp = async (file: string, source: TerminalPreviewContentSide["source"]) => {
    if (source !== "working") return reviewDigest(await git(repoRoot, source === "head"
      ? ["ls-tree", "-z", "HEAD", "--", repoPath(file)]
      : ["ls-files", "--stage", "-z", "--", repoPath(file)]));
    try {
      // Metadata permits drift detection even when the content reader rejects the file.
      const stat = await lstat(path.join(rootPath, file));
      return reviewDigest([stat.mode, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
    } catch (error) { return reviewDigest((error as NodeJS.ErrnoException).code); }
  };
  const read = async (file: string, source: TerminalPreviewContentSide["source"]): Promise<CodeReviewSnapshotSide> => {
    if (source === "head" && beforeHead === null) return { source, path: file, state: "missing", content: null, stamp: "unborn" };
    const before = await stamp(file, source);
    let content;
    try { content = await readChangeContent({ projectPath: rootPath, repoRoot, repoPath: repoPath(file), filePath: file, source }); }
    catch { content = { side: { source, path: file, state: "unsupported" as const }, text: "" }; }
    const after = await stamp(file, source);
    stable &&= before === after;
    return { ...content.side, content: content.side.state === "ready" && content.side.contentKind === "text" ? content.text : null, stamp: before };
  };
  const changes = (["staged", "working"] as const).flatMap((changeKind) => list[changeKind].map((file) => ({ ...file, changeKind })))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.changeKind.localeCompare(b.changeKind));
  for (const file of changes) {
    const old = await read(file.oldPath ?? file.path, file.changeKind === "staged" ? "head" : "index");
    const next = await read(file.path, file.changeKind === "staged" ? "index" : "working");
    const validSide = (side: CodeReviewSnapshotSide, missing: boolean) => side.content !== null || (missing && side.state === "missing");
    let omission = validSide(old, ["added", "untracked"].includes(file.status)) && validSide(next, file.status === "deleted")
      ? null : `${file.changeKind}:${file.path}：${old.state}/${next.state}，无法完整读取文本`;
    const bytes = Buffer.byteLength(old.content ?? "") + Buffer.byteLength(next.content ?? "");
    if (!omission && total + bytes > 16 * 1024 * 1024) omission = `${file.changeKind}:${file.path}：超过本轮 16 MiB 文本上限`;
    if (omission) { old.content = null; next.content = null; } else total += bytes;
    entries.push({ ...file, old, new: next, omission });
  }
  const afterList = await getPreviewGitChanges({ projectId, projectPath: rootPath });
  stable &&= beforeHead === await head(rootPath) && reviewDigest(list) === reviewDigest(afterList);
  const fingerprint = reviewDigest({ head: beforeHead, rootPath, entries });
  return { stable, head: beforeHead, entries, fingerprint };
}
export async function captureReviewSnapshot(projectId: string, rootPath: string): Promise<CodeReviewSnapshot> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const first = await capture(projectId, rootPath);
    const second = await capture(projectId, rootPath);
    if (!first.stable || !second.stable || first.fingerprint !== second.fingerprint) continue;
    return { schemaVersion: 1, snapshotId: randomUUID(), rootPath, capturedAt: new Date().toISOString(),
      head: first.head, fingerprint: first.fingerprint, entries: first.entries,
      omissions: first.entries.flatMap((entry) => entry.omission ? [entry.omission] : []) };
  }
  throw new CodeReviewError(409, "snapshot_unstable", "捕获期间代码持续变化，请稍后重试");
}
