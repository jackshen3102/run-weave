import type { EvolutionRepository } from "@runweave/shared/evolution";
import type {
  InboxItem,
  InboxListQuery,
  InboxPage,
  InboxRepository,
  InboxSourceStatus,
  InboxStateChange,
} from "@runweave/shared/knowledge-inbox";
import type { EvolutionRepositoryScopes } from "../evolution/repository-scope";
import {
  InboxStorage,
  type CatalogItem,
  type InboxDatabase,
  type UserState,
} from "./storage";
import {
  InboxError,
  type InboxSourceReader,
  type PublishedItem,
} from "./types";
import { digest, publicText } from "./projection";
import type { KnowledgeShareService } from "./shares";

type InboxQuery = InboxListQuery & { limit: number };
interface Snapshot {
  repositories: EvolutionRepository[];
  sourceStatus: InboxSourceStatus;
  revision: number;
}
export class KnowledgeInboxService {
  shares?: KnowledgeShareService;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(
    private readonly storage: InboxStorage,
    private readonly scopes: EvolutionRepositoryScopes | null,
    private readonly sources: InboxSourceReader[],
    private readonly projects: () => Array<{ id: string; name: string }>,
  ) {}
  async dispose(): Promise<void> {
    this.closed = true;
    await this.tail;
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new InboxError(503, "收件箱已关闭"));
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
  private async repositories(): Promise<EvolutionRepository[]> {
    if (!this.scopes) throw new InboxError(503, "仓库登记暂不可用");
    return this.scopes.list();
  }
  private options(repositories: EvolutionRepository[]): InboxRepository[] {
    const projects = this.projects();
    return repositories
      .filter((repo) => repo.available)
      .map((repo) => ({
        repositoryId: repo.repositoryId,
        displayName: publicText(repo.name),
        projectAliases: projects
          .filter((project) => repo.projectIds.includes(project.id))
          .map((project) => publicText(project.name)),
      }));
  }
  async listRepositories(): Promise<{ repositories: InboxRepository[] }> {
    return this.serial(async () => ({
      repositories: this.options(await this.repositories()),
    }));
  }
  private async refresh(): Promise<Snapshot> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const revision = this.storage.withStore((store) => store.revision());
      const repositories = await this.repositories();
      const reads = await Promise.allSettled(
        this.sources.map((source) => readStable(source, repositories)),
      );
      const sourceStatus: InboxSourceStatus = {
        status: "ok",
        evolution: "unavailable",
        experience: "unavailable",
      };
      const items: PublishedItem[] = [];
      reads.forEach((read, index) => {
        if (read.status === "fulfilled") {
          sourceStatus[this.sources[index]!.source] = "available";
          items.push(...read.value);
        }
      });
      const available = this.sources
        .filter((source) => sourceStatus[source.source] === "available")
        .map((source) => source.source);
      if (!available.length)
        throw new InboxError(503, "成果来源暂不可用，请稍后重试");
      if (available.length !== 2) sourceStatus.status = "partial";
      if (
        this.storage.withStore((store) =>
          store.project(revision, items, available),
        )
      ) {
        return { repositories, sourceStatus, revision: revision + 1 };
      }
      // Another Backend refreshed during source I/O. Re-read heads; never replay an old snapshot.
    }
    throw new InboxError(409, "内容正在更新，请重试");
  }
  list(username: string, query: InboxQuery): Promise<InboxPage> {
    const cursor = decodeCursor(query);
    return this.serial(async () => {
      const snapshot = await this.refresh();
      if (
        query.repositoryId &&
        !snapshot.repositories.some(
          (repo) => repo.repositoryId === query.repositoryId,
        )
      )
        throw new InboxError(404, "项目不存在");
      return this.storage.withStore((store) => {
        const states = store.states(username);
        const items = store
          .catalog()
          .flatMap((catalog) => {
            if (
              (query.source && query.source !== catalog.item.source) ||
              !snapshot.repositories.some(
                (repo) => repo.repositoryId === catalog.item.repositoryId,
              ) ||
              (query.repositoryId &&
                query.repositoryId !== catalog.item.repositoryId)
            )
              return [];
            if (query.state === "pending") {
              const current = decorate(catalog.item, catalog, states, snapshot);
              return current.availability === "available" &&
                !current.processedAt
                ? [current]
                : [];
            }
            const latest = states
              .filter(
                (state) =>
                  state.itemId === catalog.item.itemId && state.processedAt,
              )
              .sort(
                (a, b) =>
                  b.processedAt!.localeCompare(a.processedAt!) ||
                  b.stateVersion - a.stateVersion,
              )[0];
            const version =
              latest &&
              store.processedVersion(
                username,
                latest.itemId,
                latest.contentVersion,
              );
            return version
              ? [decorate(version, catalog, states, snapshot)]
              : [];
          })
          .sort(compareItems)
          .filter((item) => !cursor || compareItems(item, cursor) > 0);
        const page = items.slice(0, query.limit);
        const last = page.at(-1);
        return {
          items: page,
          nextCursor:
            items.length > query.limit && last
              ? Buffer.from(
                  JSON.stringify({
                    state: query.state,
                    ...(query.source ? { source: query.source } : {}),
                    repositoryId: query.repositoryId ?? "",
                    itemId: last.itemId,
                    contentUpdatedAt: last.contentUpdatedAt,
                  }),
                ).toString("base64url")
              : null,
          sourceStatus: snapshot.sourceStatus,
          repositories: this.options(snapshot.repositories),
        };
      });
    });
  }
  detail(username: string, id: string, version?: string): Promise<InboxItem> {
    return this.serial(async () => {
      const snapshot = await this.refresh();
      return this.storage.withStore((store) =>
        this.readItem(store, snapshot, username, id, version),
      );
    });
  }
  change(
    username: string,
    id: string,
    input: InboxStateChange,
  ): Promise<InboxItem> {
    return this.serial(async () => {
      const snapshot = await this.refresh();
      return this.storage.withStore((store) => {
        const current = this.readItem(store, snapshot, username, id);
        if (current.availability !== "available")
          throw new InboxError(409, "内容已失效或暂不可用");
        store.change(username, id, input, snapshot.revision);
        return this.readItem(store, snapshot, username, id);
      });
    });
  }
  private readItem(
    store: InboxDatabase,
    snapshot: Snapshot,
    username: string,
    id: string,
    version?: string,
  ): InboxItem {
    const catalog = store.catalogItem(id);
    if (
      !catalog ||
      !snapshot.repositories.some(
        (repo) => repo.repositoryId === catalog.item.repositoryId,
      )
    )
      throw new InboxError(404, "成果不存在");
    const states = store.states(username);
    if (
      version &&
      !states.some(
        (state) =>
          state.itemId === id &&
          state.contentVersion === version &&
          state.processedAt,
      )
    )
      throw new InboxError(404, "处理历史不存在");
    const item = version
      ? store.processedVersion(username, id, version)
      : catalog.item;
    if (!item) throw new InboxError(404, "成果不存在");
    return decorate(item, catalog, states, snapshot);
  }
}
function decorate(
  item: PublishedItem,
  catalog: CatalogItem,
  states: UserState[],
  snapshot: Snapshot,
): InboxItem {
  const state = states.find(
    (value) =>
      value.itemId === item.itemId &&
      value.contentVersion === item.contentVersion,
  );
  const prior = states.some(
    (value) =>
      value.itemId === item.itemId &&
      value.contentVersion !== catalog.item.contentVersion &&
      value.processedAt,
  );
  const currentState = states.find(
    (value) =>
      value.itemId === item.itemId &&
      value.contentVersion === catalog.item.contentVersion,
  );
  return {
    ...item,
    stateVersion: state?.stateVersion ?? 0,
    processedAt: state?.processedAt ?? null,
    hasUpdate: prior && !currentState?.processedAt,
    availability:
      snapshot.sourceStatus[item.source] === "unavailable"
        ? "unknown"
        : catalog.available &&
            snapshot.repositories.some(
              (repo) =>
                repo.repositoryId === item.repositoryId && repo.available,
            )
          ? "available"
          : "unavailable",
    ...(item.contentVersion !== catalog.item.contentVersion
      ? { currentContentVersion: catalog.item.contentVersion }
      : {}),
  };
}
type Boundary = Pick<InboxItem, "itemId" | "contentUpdatedAt">;
function compareItems(a: Boundary, b: Boundary): number {
  return (
    b.contentUpdatedAt.localeCompare(a.contentUpdatedAt) ||
    a.itemId.localeCompare(b.itemId)
  );
}
function decodeCursor(query: InboxQuery): Boundary | null {
  if (!query.cursor) return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/u.test(query.cursor) || query.cursor.length > 1024)
      throw new Error();
    const cursor = JSON.parse(
      Buffer.from(query.cursor, "base64url").toString(),
    ) as Record<string, unknown>;
    if (
      Object.keys(cursor).sort().join() !==
        (query.source
          ? "contentUpdatedAt,itemId,repositoryId,source,state"
          : "contentUpdatedAt,itemId,repositoryId,state") ||
      cursor.state !== query.state ||
      cursor.source !== query.source ||
      cursor.repositoryId !== (query.repositoryId ?? "") ||
      typeof cursor.itemId !== "string" ||
      !/^[a-f0-9]{64}$/u.test(cursor.itemId) ||
      typeof cursor.contentUpdatedAt !== "string" ||
      !Number.isFinite(Date.parse(cursor.contentUpdatedAt))
    )
      throw new Error();
    return { itemId: cursor.itemId, contentUpdatedAt: cursor.contentUpdatedAt };
  } catch {
    throw new InboxError(400, "无效的分页游标");
  }
}

/** Sources live in independent stores. Recheck heads after evidence I/O before publishing. */
async function readStable(
  source: InboxSourceReader,
  repositories: EvolutionRepository[],
): Promise<PublishedItem[]> {
  let previous = await source.read(repositories);
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await source.read(repositories);
    const signature = (items: PublishedItem[]) =>
      digest(
        JSON.stringify(
          [...items].sort((a, b) => a.itemId.localeCompare(b.itemId)),
        ),
      );
    if (signature(previous) === signature(current)) return current;
    previous = current;
  }
  throw new Error("knowledge_source_changed_during_read");
}
