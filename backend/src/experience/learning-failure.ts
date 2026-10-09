import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ExperienceLearningFailureReceipt } from "@runweave/shared/experience";
import type { EvolutionProviderRequest } from "../evolution/providers/types";
import { ProviderOutputError } from "../evolution/providers/output";
import { redactExcerpt } from "./evidence";
import { digest } from "./learning-queue";

export function learningFailureReceipt(
  error: unknown,
  input: {
    attempt: number;
    phase: ExperienceLearningFailureReceipt["phase"];
    callAttempt: number;
    provider: string;
    request: EvolutionProviderRequest;
    schema: string;
    durationMs: number;
    output: unknown;
  },
): ExperienceLearningFailureReceipt {
  const raw =
    error instanceof ProviderOutputError
      ? error.raw
      : input.output === undefined
        ? ""
        : JSON.stringify(input.output);
  // Redact complete bounded output before truncating, including malformed JSON
  // and unterminated sensitive strings which cannot use the JSON redactor.
  let normalized = raw;
  try {
    normalized = JSON.stringify(JSON.parse(raw));
  } catch {
    /* malformed output is diagnostic input */
  }
  // Complex sensitive objects in malformed JSON cannot be safely delimited.
  if (
    /["'](?:authorization|cookie|set-cookie|environment|env|secret|token|password|passwd|api[_-]?key|private[_-]?key)["']\s*:\s*[{[]/iu.test(
      normalized,
    )
  ) {
    normalized = "[REDACTED: structured sensitive output]";
  }
  const redacted = redactExcerpt(
    normalized
      .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/g, "[REDACTED]")
      .replace(
        /["'](?:authorization|cookie|set-cookie|password|passwd|secret|token|api[_-]?key|private[_-]?key|environment|env)["']\s*:\s*(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\n,}]+)/giu,
        '"[REDACTED]"',
      ),
  );
  let excerpt = "";
  let bytes = 0;
  for (const char of redacted) {
    bytes += Buffer.byteLength(char);
    if (bytes > 2048) break;
    excerpt += char;
  }
  const code =
    error instanceof ProviderOutputError
      ? (error.ioCode ?? error.message)
      : error instanceof z.ZodError
        ? "provider_output_schema_invalid"
        : error instanceof Error && /^provider_[a-z_]+$/u.test(error.message)
          ? error.message
          : "provider_failed";
  return {
    receiptId: randomUUID(),
    at: new Date().toISOString(),
    attempt: input.attempt,
    phase: input.phase,
    callAttempt: input.callAttempt,
    provider: input.provider,
    requestedModel: input.request.model ?? null,
    durationMs: input.durationMs,
    maxWallTimeMs: input.request.maxWallTimeMs,
    maxOutputBytes: input.request.maxOutputBytes,
    promptSha256: digest(input.request.prompt),
    schemaSha256: digest(input.schema),
    kind:
      error instanceof ProviderOutputError
        ? error.kind
        : error instanceof z.ZodError
          ? "schema"
          : "provider",
    code,
    outputBytes:
      error instanceof ProviderOutputError &&
      ["read_failed", "too_large"].includes(error.kind)
        ? null
        : input.output === undefined && !(error instanceof ProviderOutputError)
          ? null
          : Buffer.byteLength(raw),
    outputExcerpt: excerpt,
    excerptTruncated: excerpt.length < redacted.length,
    ...(error instanceof z.ZodError
      ? {
          schemaIssueCodes: error.issues
            .slice(0, 16)
            .map((issue) => issue.code),
        }
      : {}),
  };
}
