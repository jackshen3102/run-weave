import { createHash } from "node:crypto";
import type { ActivityContentValueDto } from "@runweave/shared/activity";
import { KNOWLEDGE_REFERENCE_PATTERN, type KnowledgeReadResult } from "@runweave/shared/knowledge-inbox";
import { parseArgs, getStringOption } from "../args.js";
import { resolveAuthContext } from "../client/auth-context.js";
import { CliError, HttpError } from "../errors.js";

export async function runKnowledgeCommand(
  command: string | undefined,
  args: string[],
  io: { stdout: Pick<NodeJS.WriteStream, "write">; env: NodeJS.ProcessEnv },
): Promise<void> {
  const { options, positionals } = parseArgs(args, new Set(["json", "plain", "evidence"]));
  const reference = positionals[0];
  if (command !== "read" || positionals.length !== 1 || !reference || !KNOWLEDGE_REFERENCE_PATTERN.test(reference))
    throw new CliError("Usage: rw knowledge read 'rw-knowledge:v1:…' [--evidence] [--json] [--profile name|--backend-port port]", 2);
  const auth = await resolveAuthContext({
    profileName: getStringOption(options, "profile"),
    backendPort: getStringOption(options, "backend-port"),
    env: io.env,
  });
  const query = new URLSearchParams({ reference, evidence: String(options.evidence === true) });
  const result = await auth.requestJson<KnowledgeReadResult>(`/api/knowledge-inbox/shares/read?${query}`);
  if (result.reference !== reference) throw new CliError("Knowledge reference mismatch", 4);
  if (options.evidence === true) {
    const refs = new Map((result.material?.evolution?.evidence ?? []).flatMap((entry) =>
      entry.contentRefs.map((ref) => [ref.contentId, ref] as const),
    ));
    result.contents = [];
    for (const [contentId, ref] of refs) {
      try {
        const content = await auth.requestJson<ActivityContentValueDto>(`/api/activity/contents/${encodeURIComponent(contentId)}`);
        if (content.availability !== "available" || typeof content.bytesBase64 !== "string") {
          result.contents.push({ contentId, status: "unavailable", reason: content.availability });
          continue;
        }
        const bytes = Buffer.from(content.bytesBase64, "base64");
        if (content.contentId !== contentId || createHash("sha256").update(bytes).digest("hex") !== ref.sha256) {
          result.contents.push({ contentId, status: "unavailable", reason: "source_digest_changed" });
          continue;
        }
        if (!content.mediaType.startsWith("text/") && !content.mediaType.includes("json")) {
          result.contents.push({ contentId, status: "unavailable", reason: "non_text_content" });
          continue;
        }
        const text = bytes.toString("utf8");
        result.contents.push({ contentId, status: "available", text: text.slice(0, 65536), truncated: text.length > 65536 });
      } catch (error) {
        // Authentication failure is not evidence absence. Do not hide a broken connection.
        if (error instanceof HttpError && [401, 403].includes(error.status)) throw error;
        result.contents.push({ contentId, status: "unavailable", reason: error instanceof HttpError ? `http_${error.status}` : "content_read_failed" });
      }
    }
  }
  // Both forms preserve structure and evidence boundaries; no model-generated summary.
  io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
