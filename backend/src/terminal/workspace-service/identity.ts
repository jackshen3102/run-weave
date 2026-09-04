import { createHash } from "node:crypto";

const WORKSPACE_SERVICE_HASH_LENGTH = 12;
const HOST_LABEL_MAX_LENGTH = 63;

export interface WorkspaceServiceIdentityInput {
  parentProjectId: string;
  projectId: string;
  projectName: string;
  contextName: string;
  serviceName: string;
}

export interface WorkspaceServiceIdentity {
  key: string;
  hostname: string;
}

function slugify(value: string, fallback: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return slug || fallback;
}

export function buildWorkspaceServiceIdentity(
  input: WorkspaceServiceIdentityInput,
): WorkspaceServiceIdentity {
  const key = [input.parentProjectId, input.projectId, input.serviceName].join(
    "\0",
  );
  const hash = createHash("sha256")
    .update(key)
    .digest("hex")
    .slice(0, WORKSPACE_SERVICE_HASH_LENGTH);
  const readable = [
    slugify(input.serviceName, "service"),
    slugify(input.contextName, "workspace"),
    slugify(input.projectName, "project"),
  ].join("--");
  const readableLimit = HOST_LABEL_MAX_LENGTH - hash.length - 1;
  const truncated = readable
    .slice(0, readableLimit)
    .replace(/-+$/gu, "") || "service";
  return {
    key,
    hostname: `${truncated}-${hash}.localhost`,
  };
}

export function buildWorkspaceServiceUrl(
  hostname: string,
  proxyPort: number,
): string {
  return `http://${hostname}:${proxyPort}`;
}

export function parseRequestHostname(host: string | undefined): string | null {
  if (!host) return null;
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isWorkspaceServiceHostnameCandidate(
  hostname: string | null,
): boolean {
  return Boolean(
    hostname &&
      /^[a-z0-9-]+-[a-f0-9]{12}\.localhost$/u.test(hostname.toLowerCase()),
  );
}
