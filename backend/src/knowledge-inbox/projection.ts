import { createHash } from "node:crypto";
import type {
  InboxContent,
  InboxSource,
} from "@runweave/shared/knowledge-inbox";
import { redactExcerpt } from "../experience/evidence";

export function publicText(value: string): string {
  return redactExcerpt(value)
    .replace(/file:\/\/[^\s<>"'`]+/giu, "[路径]")
    .replace(
      /(?:[A-Za-z]:\\|~\/|(?<![\w:/])\/)[^\s<>"'`，。；）)]+/gu,
      "[路径]",
    )
    .replace(/\b[A-Z][A-Z0-9_]*\s*=\s*[^\s,;]+/gu, "[环境变量]");
}
export function normalize(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}
export function contentVersion(content: InboxContent): string {
  // Fixed key order; ordered steps stay ordered. Missing and empty fields agree.
  return digest(
    JSON.stringify([
      normalize(content.statement),
      normalize(content.applicability),
      ...[
        content.guidance,
        content.actions,
        content.avoid,
        content.verification,
      ].map((values) => (values ?? []).map(normalize).filter(Boolean)),
    ]),
  );
}
export function itemId(
  source: InboxSource,
  repositoryId: string,
  sourceId: string,
): string {
  return digest(JSON.stringify([source, repositoryId, sourceId]));
}
export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
export function publicContent(content: InboxContent): InboxContent {
  return {
    statement: publicText(content.statement),
    applicability: publicText(content.applicability),
    ...Object.fromEntries(
      (["guidance", "actions", "avoid", "verification"] as const).flatMap(
        (key) =>
          content[key]?.length ? [[key, content[key]!.map(publicText)]] : [],
      ),
    ),
  };
}
