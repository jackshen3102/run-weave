import type { ExperienceLearningStatus } from "@runweave/shared/experience";
import type { InboxItem, InboxPage } from "@runweave/shared/knowledge-inbox";
import type { AuthContext } from "../client/auth-context.js";
import { CliError } from "../errors.js";
import { getStringOption } from "../args.js";

/** Consumption state belongs to the authenticated inbox user, not experience validity. */
export async function runExperienceInbox(
  command: "list" | "process",
  positionals: string[],
  options: Record<string, string | boolean>,
  cwd: string,
  auth: AuthContext,
): Promise<unknown> {
  const allowed = new Set([
    "cwd",
    "profile",
    "backend-port",
    "json",
    "plain",
    ...(command === "list" ? ["limit", "all"] : ["expected-content-version"]),
  ]);
  for (const name of Object.keys(options)) {
    if (!allowed.has(name))
      throw new CliError(
        `Unknown option --${name} for experience ${command}`,
        2,
      );
  }
  if (positionals.length !== (command === "process" ? 1 : 0))
    throw new CliError(
      command === "list"
        ? "Usage: rw experience list [--limit N | --all]"
        : "Usage: rw experience process <experience-id> [--expected-content-version hash]",
      2,
    );
  const limitText = getStringOption(options, "limit");
  if (options.all === true && limitText !== undefined)
    throw new CliError("Use either --limit or --all", 2);
  const limit = options.all === true ? Infinity : Number(limitText ?? "10");
  if (
    options.all !== true &&
    (!/^[1-9]\d*$/.test(limitText ?? "10") || !Number.isSafeInteger(limit))
  )
    throw new CliError("--limit must be a positive safe integer", 2);
  const expectedVersion = getStringOption(options, "expected-content-version");
  if (expectedVersion !== undefined && !/^[a-f0-9]{64}$/.test(expectedVersion))
    throw new CliError(
      "--expected-content-version must be a content version hash",
      2,
    );
  const identity = await auth.requestJson<ExperienceLearningStatus>(
    `/api/experience/status?${new URLSearchParams({ cwd })}`,
  );
  const readPage = async (
    state: "pending" | "processed",
    count: number,
    cursor?: string,
  ): Promise<InboxPage> => {
    const query = new URLSearchParams({
      state,
      source: "experience",
      repositoryId: identity.repositoryId,
      limit: String(count),
      ...(cursor ? { cursor } : {}),
    });
    const page = await auth.requestJson<InboxPage>(
      `/api/knowledge-inbox/items?${query}`,
    );
    if (page.sourceStatus.experience !== "available")
      throw new CliError(
        "Experience inbox source is unavailable; refusing to report an empty or complete list",
        4,
      );
    return page;
  };
  if (command === "list") {
    const items: InboxItem[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let page: InboxPage;
    do {
      page = await readPage(
        "pending",
        Math.min(100, limit - items.length),
        cursor,
      );
      items.push(...page.items);
      cursor = page.nextCursor ?? undefined;
      if (cursor && seenCursors.has(cursor))
        throw new CliError("Inbox pagination did not advance", 4);
      if (cursor) seenCursors.add(cursor);
    } while (cursor && items.length < limit);
    return {
      repositoryId: identity.repositoryId,
      namespace: identity.namespace,
      state: "pending",
      items,
      nextCursor: cursor ?? null,
      sourceStatus: page.sourceStatus,
    };
  }

  // Resolve within this repository and source; never accept another repository's item ID.
  let found: InboxItem | undefined;
  for (const state of ["pending", "processed"] as const) {
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      const page = await readPage(state, 100, cursor);
      found = page.items.find((item) => item.sourceId === positionals[0]);
      if (found) break;
      cursor = page.nextCursor ?? undefined;
      if (cursor && seenCursors.has(cursor))
        throw new CliError("Inbox pagination did not advance", 4);
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    if (found) break;
  }
  if (!found)
    throw new CliError("Experience not found in this repository's inbox", 4);
  const current = await auth.requestJson<InboxItem>(
    `/api/knowledge-inbox/items/${encodeURIComponent(found.itemId)}`,
  );
  if (
    current.source !== "experience" ||
    current.repositoryId !== identity.repositoryId ||
    current.sourceId !== positionals[0]
  )
    throw new CliError("Experience inbox identity mismatch", 4);
  const reviewedVersion = expectedVersion ?? found.contentVersion;
  if (current.contentVersion !== reviewedVersion)
    throw new CliError(
      "Experience content changed; list and review it again before processing",
      4,
    );
  if (current.availability !== "available")
    throw new CliError("Experience is unavailable; cannot mark processed", 4);
  if (current.processedAt) return current;
  return auth.requestJson<InboxItem>(
    `/api/knowledge-inbox/items/${encodeURIComponent(current.itemId)}/state`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        state: "processed",
        expectedContentVersion: reviewedVersion,
        expectedStateVersion: current.stateVersion,
      }),
    },
  );
}
