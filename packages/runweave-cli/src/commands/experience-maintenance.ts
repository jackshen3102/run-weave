import type {
  ExperienceCandidateView,
  ExperienceCatalogPage,
  RetireExperienceCandidateRequest,
} from "@runweave/shared/experience";
import { getStringOption, requireStringOption } from "../args.js";
import type { AuthContext } from "../client/auth-context.js";
import { CliError } from "../errors.js";

export async function runExperienceMaintenance(
  command: string,
  positionals: string[],
  options: Record<string, string | boolean>,
  cwd: string,
  auth: AuthContext,
) {
  const allowed = new Set([
    "json",
    "plain",
    "instance",
    "config-dir",
    "profile",
    "backend-port",
    ...(command === "catalog"
      ? ["repository-id", "kind", "limit", "cursor", "all"]
      : ["cwd"]),
    ...(command === "retire-candidate" ? ["expected-version", "reason"] : []),
  ]);
  for (const key of Object.keys(options))
    if (!allowed.has(key)) throw new CliError(`Unknown option --${key}`, 2);
  if (command !== "catalog") {
    if (positionals.length !== 1 || !/^[a-f0-9]{64}$/.test(positionals[0]!))
      throw new CliError("Expected one candidate ID", 2);
    const route = `/api/experience/candidates/${positionals[0]}`;
    if (command === "candidate")
      return auth.requestJson<ExperienceCandidateView>(
        `${route}?${new URLSearchParams({ cwd })}`,
      );
    const body: RetireExperienceCandidateRequest = {
      cwd,
      expectedVersion: requireStringOption(options, "expected-version"),
      reason: requireStringOption(options, "reason"),
    };
    if (
      !/^[a-f0-9]{64}$/.test(body.expectedVersion) ||
      !body.reason.trim() ||
      body.reason.trim().length > 2000
    )
      throw new CliError("Invalid expected version or retirement reason", 2);
    return auth.requestJson<ExperienceCandidateView>(`${route}/retire`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  if (positionals.length)
    throw new CliError("catalog does not accept positional arguments", 2);
  const repositoryId = requireStringOption(options, "repository-id");
  const kind = requireStringOption(options, "kind");
  const limit = getStringOption(options, "limit") ?? "50";
  if (
    !/^[a-f0-9]{64}$/.test(repositoryId) ||
    !["records", "revisions", "candidates", "jobs"].includes(kind) ||
    !/^\d+$/.test(limit) ||
    Number(limit) < 1 ||
    Number(limit) > 200
  )
    throw new CliError("Invalid repository ID, kind or limit (1–200)", 2);
  if (options.all && options.cursor)
    throw new CliError("--all cannot be combined with --cursor", 2);
  let cursor = getStringOption(options, "cursor");
  let result: ExperienceCatalogPage | undefined;
  const seen = new Set<string>();
  do {
    const page = await auth.requestJson<ExperienceCatalogPage>(
      `/api/experience/catalog/${repositoryId}?${new URLSearchParams({ kind, limit, ...(cursor ? { cursor } : {}) })}`,
    );
    if (
      page.repositoryId !== repositoryId ||
      page.kind !== kind ||
      (result && page.namespace !== result.namespace)
    )
      throw new CliError("Experience catalog scope changed", 1);
    result = result
      ? { ...page, items: [...result.items, ...page.items] }
      : page;
    if (!options.all || !page.nextCursor) break;
    if (seen.has(page.nextCursor))
      throw new CliError("Experience catalog cursor repeated", 1);
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (cursor);
  return result!;
}
