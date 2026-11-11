import { readFile } from "node:fs/promises";
import type {
  ExperienceMaintenancePage,
  ExperienceMaintenanceReview,
} from "@runweave/shared/experience";
import { getStringOption, requireStringOption } from "../args.js";
import type { AuthContext } from "../client/auth-context.js";
import { CliError } from "../errors.js";

export async function runExperienceReview(
  command: "review-queue" | "review" | "review-receipt",
  positionals: string[],
  options: Record<string, string | boolean>,
  auth: AuthContext,
) {
  const allowed = new Set([
    "json",
    "plain",
    "instance",
    "config-dir",
    "profile",
    "backend-port",
    "repository-id",
    ...(command === "review"
      ? ["file"]
      : command === "review-receipt"
        ? ["request-id"]
        : ["kind", "policy", "limit", "cursor", "all", "pending-only"]),
  ]);
  for (const key of Object.keys(options))
    if (!allowed.has(key)) throw new CliError(`Unknown option --${key}`, 2);
  if (positionals.length)
    throw new CliError(`${command} does not accept positional arguments`, 2);
  const repositoryId = requireStringOption(options, "repository-id");
  if (!/^[a-f0-9]{64}$/.test(repositoryId))
    throw new CliError("Invalid repository ID", 2);
  const route = `/api/experience/maintenance/${repositoryId}`;
  if (command === "review-receipt") {
    const requestId = requireStringOption(options, "request-id");
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(requestId))
      throw new CliError("Invalid request ID", 2);
    return auth.requestJson<ExperienceMaintenanceReview>(
      `${route}/reviews/${requestId}`,
    );
  }
  if (command === "review") {
    const file = requireStringOption(options, "file");
    let body: unknown;
    try {
      body = JSON.parse(await readFile(file, "utf8"));
    } catch {
      throw new CliError(`Cannot read review JSON: ${file}`, 2);
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new CliError("Expected one review request object", 2);
    return auth.requestJson<ExperienceMaintenanceReview>(`${route}/reviews`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  const policy = requireStringOption(options, "policy");
  const kind = requireStringOption(options, "kind");
  const limit = getStringOption(options, "limit") ?? "50";
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(policy) ||
    !["records", "revisions", "candidates", "jobs"].includes(kind) ||
    !/^\d+$/.test(limit) ||
    Number(limit) < 1 ||
    Number(limit) > 200
  )
    throw new CliError("Invalid policy, kind or limit (1–200)", 2);
  if (options.all && options.cursor)
    throw new CliError("--all cannot be combined with --cursor", 2);
  const pendingOnly = options["pending-only"] === true;
  let cursor = getStringOption(options, "cursor");
  let result: ExperienceMaintenancePage | undefined;
  const seen = new Set<string>();
  const blockers = new Map<string, number>();
  do {
    const page = await auth.requestJson<ExperienceMaintenancePage>(
      `${route}?${new URLSearchParams({
        kind,
        policy,
        pendingOnly: String(pendingOnly),
        limit,
        ...(cursor ? { cursor } : {}),
      })}`,
    );
    if (
      page.repositoryId !== repositoryId ||
      page.kind !== kind ||
      page.policy !== policy ||
      page.pendingOnly !== pendingOnly ||
      (result && page.namespace !== result.namespace)
    )
      throw new CliError("Experience maintenance scope changed", 1);
    for (const blocker of page.blockers)
      blockers.set(
        blocker.key,
        (blockers.get(blocker.key) ?? 0) + blocker.count,
      );
    if (result) {
      result.items.push(...page.items);
      for (const key of ["scanned", "pending", "reviewed", "deferred"] as const)
        result.counts[key] += page.counts[key];
      result.nextCursor = page.nextCursor;
      result.sourceAvailable &&= page.sourceAvailable;
      result.storeAvailable &&= page.storeAvailable;
    } else result = page;
    if (!options.all || !page.nextCursor) break;
    if (seen.has(page.nextCursor))
      throw new CliError("Experience maintenance cursor repeated", 1);
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (cursor);
  result!.blockers = [...blockers].map(([key, count]) => ({ key, count }));
  return result!;
}
