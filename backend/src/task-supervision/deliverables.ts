import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ConversationMessage } from "@runweave/shared/terminal/conversation";
import type { SupervisionDeliverable, SupervisionDeliverables } from "@runweave/shared/task-supervision";
import { digest } from "./context";

const run = promisify(execFile);
const MAX_ITEMS = 5;
const MAX_DOCUMENT_BYTES = 24_000;
const MAX_TOTAL_BYTES = 48_000;
const DOCUMENT = /\.(?:md|txt|testplan\.ya?ml)$/i;
const PR = /^https:\/\/github\.com\/([a-z\d][a-z\d-]*)\/([\w.-]*[\w-][\w.-]*)\/pull\/([1-9]\d*)\/?(?:[?#].*)?$/i;

/** Only explicit references in this final reply; never follow links inside retrieved material. */
function references(text: string) {
  const candidates = [
    ...text.matchAll(/\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^\s)]+)(?:\s+"[^"\n]*")?\s*\)|`([^`\n]+)`|https:\/\/github\.com\/[^\s<>`）)]+|(?:^|\s)((?:\.\/)?docs\/[^\s<>`）)]+)/gm),
  ];
  const result = new Map<string, { kind: SupervisionDeliverable["kind"]; reference: string }>();
  for (const match of candidates) {
    let reference = (match[1] ?? match[2] ?? match[3] ?? match[0]).trim().replace(/^<|>$/g, "");
    if (!match[1] && !match[2]) reference = reference.replace(/[，。；,;.]+$/, "");
    const pr = PR.exec(reference);
    if (pr) {
      reference = `https://github.com/${pr[1]}/${pr[2]}/pull/${pr[3]}`;
      result.set(reference, { kind: "github_pr", reference });
      continue;
    }
    if (/^[a-z][a-z\d+.-]*:/i.test(reference)) continue;
    try { reference = decodeURIComponent(reference).replace(/#.*$/, "").replace(/:\d+(?::\d+)?$/, ""); }
    catch { continue; }
    if (!DOCUMENT.test(reference) || reference.length > 2048 || reference.includes("\0")) continue;
    reference = path.normalize(reference);
    result.set(reference, { kind: "local_document", reference });
  }
  return [...result.values()];
}

async function readDocument(root: string, reference: string): Promise<Partial<SupervisionDeliverable>> {
  const realRoot = await realpath(root);
  // Resolve absolute references against the original root as well (macOS /var -> /private/var).
  const candidate = path.resolve(root, reference);
  const lexicalRoot = path.resolve(root);
  const relative = path.relative(candidate.startsWith(`${realRoot}${path.sep}`) ? realRoot : lexicalRoot, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    return { availability: "outside_project" };
  const file = await realpath(path.resolve(realRoot, relative));
  if (!file.startsWith(`${realRoot}${path.sep}`)) return { availability: "outside_project" };
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile()) return { availability: "unavailable" };
    if (before.size > MAX_DOCUMENT_BYTES) return { availability: "too_large" };
    const buffer = Buffer.alloc(MAX_DOCUMENT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_DOCUMENT_BYTES) return { availability: "too_large" };
    const after = await handle.stat();
    if (before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.size !== after.size)
      return { availability: "unavailable" };
    const bytes = buffer.subarray(0, length);
    if (bytes.includes(0)) return { availability: "unavailable" };
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const hash = digest(text);
    return { availability: "available", text, digest: hash, version: `sha256:${hash}` };
  } finally {
    await handle.close();
  }
}

async function readPullRequest(reference: string, signal: AbortSignal): Promise<Partial<SupervisionDeliverable>> {
  const match = PR.exec(reference)!;
  // Fixed host, GET only, no shell, no recursive browsing, no repository-provided commands.
  const { stdout } = await run("gh", ["api", "--hostname", "github.com", "--method", "GET",
    `repos/${match[1]}/${match[2]}/pulls/${match[3]}`,
    "--jq", "{url: .html_url, title, body, updated_at, head: .head.sha}"],
  { signal, timeout: 8_000, maxBuffer: 128_000, encoding: "utf8" });
  const pr = JSON.parse(stdout) as Record<string, unknown>;
  if (pr.url !== reference || typeof pr.title !== "string" || (pr.body !== null && typeof pr.body !== "string") ||
    typeof pr.updated_at !== "string" || typeof pr.head !== "string")
    return { availability: "unavailable" };
  const text = `${pr.title}\n\n${pr.body ?? ""}`;
  if (Buffer.byteLength(text) > MAX_DOCUMENT_BYTES) return { availability: "too_large" };
  return { availability: "available", text, digest: digest(text), version: `${pr.head}@${pr.updated_at}` };
}

export async function collectDeliverables(root: string, reply: ConversationMessage, remainingBytes: number,
  signal: AbortSignal): Promise<SupervisionDeliverables> {
  const refs = references(reply.text);
  const result: SupervisionDeliverables = { items: [], omittedCount: Math.max(0, refs.length - MAX_ITEMS) };
  const budget = Math.max(0, Math.min(MAX_TOTAL_BYTES, remainingBytes));
  // A shared deadline cancels PR requests and prevents starting further reads.
  const readSignal = AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
  for (const ref of refs.slice(0, MAX_ITEMS)) {
    signal.throwIfAborted();
    const item: SupervisionDeliverable = {
      ...ref, id: `deliverable:${digest(`${reply.id}\n${ref.reference}`).slice(0, 24)}`,
      sourceMessageId: reply.id, readAt: new Date().toISOString(), availability: "unavailable",
    };
    try {
      if (!readSignal.aborted) Object.assign(item, ref.kind === "local_document"
        ? await readDocument(root, ref.reference) : await readPullRequest(ref.reference, readSignal));
    } catch (error) {
      signal.throwIfAborted();
      // Do not expose CLI stderr, credentials, or arbitrary OS error text to the model/archive.
      if (ref.kind === "local_document" && (error as NodeJS.ErrnoException).code === "ENOENT") item.availability = "missing";
    }
    result.items.push(item);
    if (Buffer.byteLength(JSON.stringify(result)) > budget) {
      delete item.text;
      delete item.digest;
      delete item.version;
      item.availability = "too_large";
    }
    if (Buffer.byteLength(JSON.stringify(result)) > budget) {
      result.items.pop();
      result.omittedCount++;
    }
  }
  signal.throwIfAborted();
  return result;
}
