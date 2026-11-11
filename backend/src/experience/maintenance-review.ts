import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import type {
  ExperienceCatalogKind,
  ExperienceCatalogPage,
  ExperienceMaintenanceItem,
  ExperienceMaintenancePage,
  ExperienceMaintenanceReview,
  SaveExperienceMaintenanceReview,
} from "@runweave/shared/experience";
import { readExperienceCatalog, readExperienceCatalogItem } from "./catalog";
import { inspectEvidenceSnapshot } from "./evidence";
import { ExperienceError } from "./errors";
import { withExperienceStore, type ExperienceStorage } from "./storage";

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const reviewKey = (
  policy: string,
  kind: ExperienceCatalogKind,
  itemId: string,
  version: string,
) => digest([policy, kind, itemId, version]);
const reviewDirectory = (storage: ExperienceStorage, repositoryId: string) =>
  path.join(storage.home, storage.namespace, repositoryId);

export function readExperienceMaintenanceReview(
  storage: ExperienceStorage,
  repositoryId: string,
  requestId: string,
) {
  const directory = reviewDirectory(storage, repositoryId);
  if (!existsSync(path.join(directory, "store.sqlite")))
    throw new ExperienceError("experience_maintenance_review_not_found", 404);
  return withExperienceStore(
    directory,
    (store) => {
      const stored = store.get<StoredReview>("maintenance-reviews", requestId);
      if (!stored)
        throw new ExperienceError(
          "experience_maintenance_review_not_found",
          404,
        );
      if (
        stored.receipt.repositoryId !== repositoryId ||
        stored.receipt.namespace !== storage.namespace
      )
        throw new ExperienceError("experience_scope_mismatch", 409);
      return stored.receipt;
    },
    true,
  );
}

async function observe(
  repositoryId: string,
  namespace: string,
  sourceAvailable: boolean,
  policy: string,
  kind: ExperienceCatalogKind,
  item: ExperienceCatalogPage["items"][number],
): Promise<Omit<ExperienceMaintenanceItem, "review" | "state">> {
  const itemId =
    "candidate" in item
      ? item.candidate.candidateId
      : "jobId" in item
        ? item.jobId
        : kind === "revisions"
          ? item.revision
          : item.id;
  const record =
    "candidate" in item ? item.candidate.record : "jobId" in item ? null : item;
  const evidence = await Promise.all(
    (record?.evidence ?? []).map(inspectEvidenceSnapshot),
  );
  const evidenceIssues = evidence.flatMap((state) =>
    state.reason ? [state.reason] : [],
  );
  const expired = record ? Date.parse(record.expiresAt) <= Date.now() : false;
  return {
    itemId,
    item,
    evidenceIssues,
    version: digest({
      repositoryId,
      namespace,
      sourceAvailable,
      policy,
      kind,
      itemId,
      item,
      evidence,
      expired,
    }),
  };
}

/** Pagination advances over raw objects, even when a page has no pending items. */
export async function readExperienceMaintenance(
  storage: ExperienceStorage,
  repositoryId: string,
  sourceAvailable: boolean,
  kind: ExperienceCatalogKind,
  policy: string,
  pendingOnly: boolean,
  limit: number,
  cursor?: string,
): Promise<ExperienceMaintenancePage> {
  let catalogCursor: string | undefined;
  if (cursor) {
    try {
      const value = JSON.parse(Buffer.from(cursor, "base64url").toString());
      if (
        value.policy !== policy ||
        value.pendingOnly !== pendingOnly ||
        typeof value.catalogCursor !== "string"
      )
        throw new Error();
      catalogCursor = value.catalogCursor;
    } catch {
      throw new ExperienceError("experience_maintenance_cursor_invalid");
    }
  }
  const page = readExperienceCatalog(
    storage,
    repositoryId,
    sourceAvailable,
    kind,
    limit,
    catalogCursor,
  );
  const observed = [];
  for (const item of page.items)
    observed.push(
      await observe(
        repositoryId,
        storage.namespace,
        sourceAvailable,
        policy,
        kind,
        item,
      ),
    );
  const directory = reviewDirectory(storage, repositoryId);
  const items: ExperienceMaintenanceItem[] = observed.map((item) => ({
    ...item,
    review: null,
    state: "pending",
  }));
  if (existsSync(path.join(directory, "store.sqlite"))) {
    withExperienceStore(
      directory,
      (store) => {
        for (const item of items) {
          const id = store.get<string>(
            "maintenance-review-heads",
            reviewKey(policy, kind, item.itemId, item.version),
          );
          if (!id) continue;
          const review = store.get<StoredReview>(
            "maintenance-reviews",
            id,
          )?.receipt;
          if (
            !review ||
            review.repositoryId !== repositoryId ||
            review.namespace !== storage.namespace ||
            review.policy !== policy ||
            review.kind !== kind ||
            review.itemId !== item.itemId ||
            review.version !== item.version
          )
            throw new ExperienceError(
              "experience_maintenance_receipt_invalid",
              409,
            );
          item.review = review;
          item.state = review.decision;
        }
      },
      true,
    );
  }
  const counts = {
    scanned: items.length,
    pending: 0,
    reviewed: 0,
    deferred: 0,
  };
  const blockers = new Map<string, number>();
  for (const item of items) {
    counts[item.state]++;
    if (item.state === "deferred") {
      const key = item.review!.blocker!;
      blockers.set(key, (blockers.get(key) ?? 0) + 1);
    }
  }
  return {
    ...page,
    policy,
    pendingOnly,
    counts,
    blockers: [...blockers].map(([key, count]) => ({ key, count })),
    items: pendingOnly
      ? items.filter((item) => item.state === "pending")
      : items,
    nextCursor: page.nextCursor
      ? Buffer.from(
          JSON.stringify({
            policy,
            pendingOnly,
            catalogCursor: page.nextCursor,
          }),
        ).toString("base64url")
      : null,
  };
}

/** Evidence I/O is outside the short write transaction. Receipts bind that observation. */
export async function saveExperienceMaintenanceReview(
  storage: ExperienceStorage,
  repositoryId: string,
  sourceAvailable: boolean,
  input: SaveExperienceMaintenanceReview,
): Promise<ExperienceMaintenanceReview> {
  const directory = reviewDirectory(storage, repositoryId);
  // Resolve an uncertain original request before inspecting evidence that may since have changed.
  const readReplay = () =>
    existsSync(path.join(directory, "store.sqlite"))
      ? withExperienceStore(
          directory,
          (store) =>
            store.get<StoredReview>("maintenance-reviews", input.requestId),
          true,
        )
      : undefined;
  const requestHash = digest(input);
  const replay = readReplay();
  if (replay)
    return replayReceipt(replay, repositoryId, storage.namespace, requestHash);
  const item = readExperienceCatalogItem(
    storage,
    repositoryId,
    input.kind,
    input.itemId,
  );
  const observed = await observe(
    repositoryId,
    storage.namespace,
    sourceAvailable,
    input.policy,
    input.kind,
    item,
  );
  if (observed.version !== input.expectedVersion)
    throw new ExperienceError("experience_maintenance_version_conflict", 409);
  if (
    input.decision === "reviewed" &&
    (observed.evidenceIssues.length || !sourceAvailable)
  )
    throw new ExperienceError(
      "experience_maintenance_evidence_unverified",
      409,
    );
  const key = reviewKey(
    input.policy,
    input.kind,
    input.itemId,
    observed.version,
  );
  return withExperienceStore(directory, (store) =>
    store.transaction(() => {
      const previous = store.get<StoredReview>(
        "maintenance-reviews",
        input.requestId,
      );
      if (previous)
        return replayReceipt(
          previous,
          repositoryId,
          storage.namespace,
          requestHash,
        );
      if (
        digest(
          readExperienceCatalogItem(
            storage,
            repositoryId,
            input.kind,
            input.itemId,
          ),
        ) !== digest(item)
      )
        throw new ExperienceError(
          "experience_maintenance_version_conflict",
          409,
        );
      if (
        (store.get<string>("maintenance-review-heads", key) ?? null) !==
        input.expectedReviewId
      )
        throw new ExperienceError(
          "experience_maintenance_review_conflict",
          409,
        );
      const receipt: ExperienceMaintenanceReview = {
        requestId: input.requestId,
        repositoryId,
        namespace: storage.namespace,
        policy: input.policy,
        kind: input.kind,
        itemId: input.itemId,
        version: observed.version,
        decision: input.decision,
        reason: input.reason,
        blocker: input.blocker,
        reviewedAt: new Date().toISOString(),
      };
      store.put("maintenance-reviews", input.requestId, {
        receipt,
        requestHash,
      });
      store.put("maintenance-review-heads", key, input.requestId);
      return receipt;
    }),
  );
}

interface StoredReview {
  receipt: ExperienceMaintenanceReview;
  requestHash: string;
}
function replayReceipt(
  stored: StoredReview,
  repositoryId: string,
  namespace: string,
  requestHash: string,
) {
  if (
    stored.receipt.repositoryId !== repositoryId ||
    stored.receipt.namespace !== namespace ||
    stored.requestHash !== requestHash
  )
    throw new ExperienceError("experience_maintenance_request_conflict", 409);
  return stored.receipt;
}
