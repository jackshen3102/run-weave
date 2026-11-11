import { existsSync } from "node:fs";
import path from "node:path";
import type {
  ExperienceCandidate,
  ExperienceCatalogKind,
  ExperienceCatalogPage,
  ExperienceRecord,
} from "@runweave/shared/experience";
import type { LearningJob } from "./learning-queue";
import { candidateView } from "./candidate-lifecycle";
import { ExperienceError } from "./errors";
import { withExperienceStore, type ExperienceStorage } from "./storage";

type StoredItem = ExperienceRecord | ExperienceCandidate | LearningJob;

export function experienceCatalogDirectory(storage: ExperienceStorage, repositoryId: string, kind: ExperienceCatalogKind) {
  return path.join(storage.home, storage.namespace, kind === "jobs" ? "_queue" : repositoryId);
}

function publicItem(storage: ExperienceStorage, repositoryId: string, kind: ExperienceCatalogKind, value: StoredItem): ExperienceCatalogPage["items"][number] {
  if (kind === "jobs") {
    const { source: _source, claim: _claim, leaseUntil: _lease, sourceDigest: _digest, ...job } = value as LearningJob;
    void _source; void _claim; void _lease; void _digest;
    if (job.repositoryId !== repositoryId) throw new ExperienceError("experience_scope_mismatch", 409);
    return job;
  }
  const record = kind === "candidates" ? (value as ExperienceCandidate).record : value as ExperienceRecord;
  if (record.repositoryId !== repositoryId || record.namespace !== storage.namespace)
    throw new ExperienceError("experience_scope_mismatch", 409);
  return kind === "candidates" ? candidateView(value as ExperienceCandidate) : record;
}

export function readExperienceCatalogItem(storage: ExperienceStorage, repositoryId: string, kind: ExperienceCatalogKind, itemId: string) {
  const directory = experienceCatalogDirectory(storage, repositoryId, kind);
  if (!existsSync(path.join(directory, "store.sqlite"))) throw new ExperienceError("experience_catalog_item_not_found", 404);
  return withExperienceStore(directory, store => {
    const value = store.get<StoredItem>(kind, itemId);
    if (!value) throw new ExperienceError("experience_catalog_item_not_found", 404);
    return publicItem(storage, repositoryId, kind, value);
  }, true);
}

/** Historical inspection is explicitly scoped by a registered repository, never a guessed cwd. */
export function readExperienceCatalog(
  storage: ExperienceStorage,
  repositoryId: string,
  sourceAvailable: boolean,
  kind: ExperienceCatalogKind,
  limit: number,
  cursor?: string,
): ExperienceCatalogPage {
  let after = "";
  if (cursor) {
    try {
      const value = JSON.parse(Buffer.from(cursor, "base64url").toString());
      if (
        value.repositoryId !== repositoryId ||
        value.kind !== kind ||
        value.namespace !== storage.namespace ||
        typeof value.after !== "string" ||
        !value.after ||
        value.after.length > 256
      )
        throw new Error();
      after = value.after;
    } catch {
      throw new ExperienceError("experience_catalog_cursor_invalid");
    }
  }
  const directory = experienceCatalogDirectory(storage, repositoryId, kind);
  const result: ExperienceCatalogPage = {
    repositoryId,
    namespace: storage.namespace,
    kind,
    sourceAvailable,
    storeAvailable: existsSync(path.join(directory, "store.sqlite")),
    items: [],
    nextCursor: null,
  };
  if (!result.storeAvailable) return result;
  return withExperienceStore(
    directory,
    (store) => {
      const rows = store.page<
        ExperienceRecord | ExperienceCandidate | LearningJob
      >(kind, after, limit + 1, kind === "jobs" ? repositoryId : undefined);
      const page = rows.slice(0, limit);
      result.items = page.map(({ value }) => publicItem(storage, repositoryId, kind, value));
      if (rows.length > limit)
        result.nextCursor = Buffer.from(
          JSON.stringify({
            repositoryId,
            namespace: storage.namespace,
            kind,
            after: page.at(-1)!.id,
          }),
        ).toString("base64url");
      return result;
    },
    true,
  );
}
