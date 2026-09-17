import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type {
  ExperienceEvidence,
  ExperienceEvidenceInput,
} from "@runweave/shared/experience";
import { redactActivityText } from "../activity/security/redaction";
import path from "node:path";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
async function readEvidence(
  input: ExperienceEvidenceInput,
  archive = false,
): Promise<ExperienceEvidence> {
  if (!path.isAbsolute(input.path))
    throw new Error("experience_evidence_path_must_be_absolute");
  const source = await stat(input.path);
  if (!source.isFile()) {
    throw new Error("experience_evidence_must_be_a_file");
  }
  const stream = createReadStream(input.path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const selected: string[] = [];
  let line = 0;
  let bytes = 0;
  try {
    for await (const value of lines) {
      line++;
      if (line >= input.startLine) {
        bytes += Buffer.byteLength(value);
        if (bytes > 2 * 1024 * 1024)
          throw new Error("experience_evidence_too_large");
        selected.push(value);
      }
      if (line === input.endLine) break;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  if (line < input.endLine)
    throw new Error("experience_evidence_lines_missing");
  const original = selected.join("\n") + "\n";
  const text = redactExcerpt(original);
  if (archive && Buffer.byteLength(text) > 64 * 1024)
    throw new Error("experience_excerpt_too_large");
  return {
    path: input.path,
    startLine: input.startLine,
    endLine: input.endLine,
    note: input.note,
    sha256: hash(original),
    ...(archive ? { archived: { text, sha256: hash(text) } } : {}),
  };
}

export const snapshotEvidence = (input: ExperienceEvidenceInput) =>
  readEvidence(input, true);

export async function inspectEvidence(
  evidence: ExperienceEvidence,
): Promise<string | null> {
  if (
    evidence.archived &&
    hash(evidence.archived.text) !== evidence.archived.sha256
  )
    return `evidence_archive_changed:${evidence.path}`;
  try {
    if ((await readEvidence(evidence)).sha256 !== evidence.sha256)
      return `evidence_changed:${evidence.path}`;
  } catch (error) {
    if (
      !evidence.archived ||
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    )
      return `evidence_unavailable:${evidence.path}`;
  }
  return null;
}

export function redactExcerpt(value: string): string {
  const redacted = redactActivityText(value);
  return redacted
    .split("\n")
    .map((line) => {
      try {
        return JSON.stringify(JSON.parse(line), (key, child: unknown) =>
          /^(authorization|cookie|set-cookie|password|passwd|secret|token|api[_-]?key|private[_-]?key|environment|env)$/iu.test(
            key,
          )
            ? "[REDACTED]"
            : typeof child === "string"
              ? redactActivityText(child)
              : child,
        );
      } catch {
        return line;
      }
    })
    .join("\n");
}
