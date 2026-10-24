import type { ExperienceLearningStatus } from "@runweave/shared/experience";
import type { InboxItem, InboxPage } from "@runweave/shared/knowledge-inbox";
import { readFile } from "node:fs/promises";
import type { AuthContext } from "../client/auth-context.js";
import { CliError, toCliError } from "../errors.js";
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
    "instance",
    "config-dir",
    "profile",
    "backend-port",
    "json",
    "plain",
    ...(command === "list" ? ["limit", "all"] : ["expected-content-version", "file"]),
  ]);
  for (const name of Object.keys(options)) {
    if (!allowed.has(name))
      throw new CliError(
        `Unknown option --${name} for experience ${command}`,
        2,
      );
  }
  const file = getStringOption(options, "file");
  if (positionals.length !== (command === "process" && !file ? 1 : 0))
    throw new CliError(
      command === "list"
        ? "Usage: rw experience list [--limit N | --all]"
        : "Usage: rw experience process <experience-id> [--expected-content-version hash] | process --file reviewed-list.json",
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
  if (file && expectedVersion !== undefined)
    throw new CliError("--file uses each item's contentVersion; cannot combine with --expected-content-version", 2);
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

  const readCurrent = async (
    reviewed: Pick<InboxItem, "itemId" | "sourceId" | "contentVersion">,
  ): Promise<InboxItem> => {
    const current = await auth.requestJson<InboxItem>(
      `/api/knowledge-inbox/items/${encodeURIComponent(reviewed.itemId)}`,
    );
    if (
      current.itemId !== reviewed.itemId ||
      current.source !== "experience" ||
      current.repositoryId !== identity.repositoryId ||
      current.sourceId !== reviewed.sourceId
    )
      throw new CliError("Experience inbox identity mismatch", 4);
    if (current.contentVersion !== reviewed.contentVersion)
      throw new CliError(
        "Experience content changed; list and review it again before processing",
        4,
      );
    if (current.availability !== "available")
      throw new CliError("Experience is unavailable; cannot mark processed", 4);
    return current;
  };
  const processCurrent = (current: InboxItem): Promise<InboxItem> => {
    if (current.processedAt) return Promise.resolve(current);
    return auth.requestJson<InboxItem>(
      `/api/knowledge-inbox/items/${encodeURIComponent(current.itemId)}/state`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          state: "processed",
          expectedContentVersion: current.contentVersion,
          expectedStateVersion: current.stateVersion,
        }),
      },
    );
  };
  if (file) {
    const reviewed = await readReviewedList(file, identity);
    // Check the entire review before the first write. The PATCH still checks
    // both versions, so changes after this preflight stop the batch as well.
    const prepared: InboxItem[] = [];
    for (const item of reviewed) {
      try {
        prepared.push(await readCurrent(item));
      } catch (error) {
        const failure = toCliError(error);
        throw new CliError(
          `Batch preflight failed at ${item.sourceId}: ${failure.message}. No processing requests sent.`,
          failure.exitCode,
        );
      }
    }
    const items: InboxItem[] = [];
    for (const current of prepared) {
      try {
        items.push(await processCurrent(current));
      } catch (error) {
        const failure = toCliError(error);
        throw new CliError(
          `Batch stopped at ${current.sourceId}: ${failure.message}. Completed ${items.length}/${prepared.length}: ${JSON.stringify(items.map(item => item.sourceId))}. Re-read the inbox before retrying; the failed request may have reached the server.`,
          failure.exitCode,
        );
      }
    }
    return { repositoryId: identity.repositoryId, namespace: identity.namespace, state: "processed", items };
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
  return processCurrent(
    await readCurrent({ ...found, contentVersion: expectedVersion ?? found.contentVersion }),
  );
}

async function readReviewedList(
  file: string,
  identity: ExperienceLearningStatus,
): Promise<InboxItem[]> {
  let snapshot: { repositoryId: string; namespace: string; items: InboxItem[] };
  try {
    snapshot = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new CliError(`Cannot read JSON file: ${file}`, 2);
  }
  if (
    !snapshot ||
    snapshot.repositoryId !== identity.repositoryId ||
    snapshot.namespace !== identity.namespace ||
    !Array.isArray(snapshot.items)
  )
    throw new CliError("Reviewed list must contain this repository's repositoryId, namespace and items from experience list --json", 2);
  const ids = new Set<string>();
  const sources = new Set<string>();
  for (const item of snapshot.items) {
    if (
      !item ||
      item.source !== "experience" ||
      item.repositoryId !== identity.repositoryId ||
      typeof item.sourceId !== "string" ||
      !item.sourceId.trim() ||
      typeof item.itemId !== "string" ||
      !/^[a-f0-9]{64}$/.test(item.itemId) ||
      typeof item.contentVersion !== "string" ||
      !/^[a-f0-9]{64}$/.test(item.contentVersion) ||
      ids.has(item.itemId) ||
      sources.has(item.sourceId)
    )
      throw new CliError("Reviewed list items must be unique experiences from this repository with itemId, sourceId and contentVersion", 2);
    ids.add(item.itemId);
    sources.add(item.sourceId);
  }
  return snapshot.items;
}
