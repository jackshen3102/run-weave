import crypto from "node:crypto";
import type {
  ActivityEventInput,
  ActivityOperationScope,
} from "@runweave/shared/activity";
import { redactActivityPayload, sanitizeActivityLocator } from "./redaction";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

export function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function canonicalizeActivityEvent(event: ActivityEventInput): {
  normalized: ActivityEventInput;
  fingerprint: string;
} {
  const normalized: ActivityEventInput = {
    ...event,
    payload: redactActivityPayload(event.payload),
    externalRefs: event.externalRefs.map((ref) => ({
      ...ref,
      locator: sanitizeActivityLocator(ref.locator),
    })),
  };
  return {
    normalized,
    fingerprint: sha256(canonicalJson(normalized)),
  };
}

export function canonicalActivityScope(scope: ActivityOperationScope): {
  scopeType: "project" | "thread";
  scopeId: string;
  canonicalJson: string;
  digest: string;
} {
  const scopeType = typeof scope.projectId === "string" ? "project" : "thread";
  const scopeId =
    scopeType === "project"
      ? (scope.projectId as string)
      : (scope.threadId as string);
  const canonical =
    scopeType === "project"
      ? canonicalJson({ projectId: scopeId })
      : canonicalJson({ threadId: scopeId });
  return { scopeType, scopeId, canonicalJson: canonical, digest: sha256(canonical) };
}
