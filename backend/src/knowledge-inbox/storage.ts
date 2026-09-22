import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  InboxSource,
  InboxStateChange,
  KnowledgeSnapshot,
} from "@runweave/shared/knowledge-inbox";
import { InboxError, type PublishedItem } from "./types";

const require = createRequire(import.meta.url);
export interface CatalogItem {
  item: PublishedItem;
  available: boolean;
}
export interface UserState {
  itemId: string;
  contentVersion: string;
  stateVersion: number;
  processedAt: string | null;
}
/** Connections are scoped to a short operation. No connection survives a request or shutdown. */
export class InboxStorage {
  constructor(private readonly directory: string) {}
  withStore<T>(operation: (store: InboxDatabase) => T): T {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    const file = path.join(this.directory, "store.sqlite");
    const Driver = require(
      process.env.RUNWEAVE_BETTER_SQLITE3_PACKAGE_DIR ?? "better-sqlite3",
    ) as typeof Database;
    const db = new Driver(file, {
      timeout: 5000,
      nativeBinding: process.env.RUNWEAVE_BETTER_SQLITE3_NATIVE_BINDING,
    });
    try {
      chmodSync(file, 0o600);
      db.exec(`
        CREATE TABLE IF NOT EXISTS projection_clock (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
        INSERT OR IGNORE INTO projection_clock VALUES(1,0);
        CREATE TABLE IF NOT EXISTS catalog (item_id TEXT PRIMARY KEY, source TEXT NOT NULL,
          repository_id TEXT NOT NULL, payload TEXT NOT NULL, available INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS content_versions (item_id TEXT NOT NULL, version TEXT NOT NULL,
          payload TEXT NOT NULL, PRIMARY KEY(item_id,version));
        CREATE TABLE IF NOT EXISTS user_state (username TEXT NOT NULL, item_id TEXT NOT NULL,
          version TEXT NOT NULL, state_version INTEGER NOT NULL, processed_at TEXT,
          PRIMARY KEY(username,item_id,version));
        CREATE TABLE IF NOT EXISTS share_identity (id INTEGER PRIMARY KEY CHECK(id=1), identity TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS knowledge_shares (id TEXT PRIMARY KEY, username TEXT NOT NULL, snapshot TEXT NOT NULL);
      `);
      db.prepare("INSERT OR IGNORE INTO share_identity VALUES(1,?)").run(randomUUID());
      const columns = db
        .prepare("PRAGMA table_info(user_state)")
        .all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "snapshot")) {
        db.transaction(() => {
          const current = db
            .prepare("PRAGMA table_info(user_state)")
            .all() as Array<{ name: string }>;
          if (!current.some((column) => column.name === "snapshot"))
            db.exec("ALTER TABLE user_state ADD COLUMN snapshot TEXT");
        }).immediate();
      }
      return operation(new InboxDatabase(db));
    } finally {
      db.close();
    }
  }
}
export class InboxDatabase {
  constructor(private readonly db: Database.Database) {}
  shareIdentity(): string {
    return (this.db.prepare("SELECT identity FROM share_identity WHERE id=1").get() as { identity: string }).identity;
  }
  saveShare(username: string, snapshot: KnowledgeSnapshot): string {
    const id = randomUUID();
    this.db.prepare("INSERT INTO knowledge_shares VALUES(?,?,?)").run(id, username, JSON.stringify(snapshot));
    return `rw-knowledge:v1:${this.shareIdentity()}:${id}`;
  }
  share(username: string, id: string): KnowledgeSnapshot | undefined {
    const row = this.db.prepare("SELECT snapshot FROM knowledge_shares WHERE id=? AND username=?").get(id, username) as { snapshot: string } | undefined;
    return row ? JSON.parse(row.snapshot) as KnowledgeSnapshot : undefined;
  }
  revision(): number {
    return (
      this.db
        .prepare("SELECT revision FROM projection_clock WHERE id=1")
        .get() as { revision: number }
    ).revision;
  }
  /** Global generation CAS prevents a slow read in another Backend overwriting a newer projection. */
  project(
    expectedRevision: number,
    items: PublishedItem[],
    successfulSources: InboxSource[],
  ): boolean {
    return this.db
      .transaction(() => {
        if (this.revision() !== expectedRevision) return false;
        for (const source of successfulSources) {
          this.db
            .prepare("UPDATE catalog SET available=0 WHERE source=?")
            .run(source);
        }
        for (const incoming of items) {
          const previous = this.catalogItem(incoming.itemId)?.item;
          const archived = this.version(
            incoming.itemId,
            incoming.contentVersion,
          );
          const item = {
            ...incoming,
            contentUpdatedAt:
              archived?.contentUpdatedAt ??
              (previous ? new Date().toISOString() : incoming.contentUpdatedAt),
          };
          this.db
            .prepare("INSERT OR IGNORE INTO content_versions VALUES(?,?,?)")
            .run(item.itemId, item.contentVersion, JSON.stringify(item));
          this.db
            .prepare("INSERT OR REPLACE INTO catalog VALUES(?,?,?,?,1)")
            .run(
              item.itemId,
              item.source,
              item.repositoryId,
              JSON.stringify(item),
            );
        }
        this.db
          .prepare("UPDATE projection_clock SET revision=revision+1 WHERE id=1")
          .run();
        return true;
      })
      .immediate();
  }
  catalog(): CatalogItem[] {
    return (
      this.db.prepare("SELECT payload,available FROM catalog").all() as Array<{
        payload: string;
        available: number;
      }>
    ).map((row) => ({
      item: JSON.parse(row.payload) as PublishedItem,
      available: !!row.available,
    }));
  }
  catalogItem(id: string): CatalogItem | undefined {
    const row = this.db
      .prepare("SELECT payload,available FROM catalog WHERE item_id=?")
      .get(id) as { payload: string; available: number } | undefined;
    return (
      row && {
        item: JSON.parse(row.payload) as PublishedItem,
        available: !!row.available,
      }
    );
  }
  version(id: string, version: string): PublishedItem | undefined {
    const row = this.db
      .prepare(
        "SELECT payload FROM content_versions WHERE item_id=? AND version=?",
      )
      .get(id, version) as { payload: string } | undefined;
    return row && (JSON.parse(row.payload) as PublishedItem);
  }
  processedVersion(
    username: string,
    id: string,
    version: string,
  ): PublishedItem | undefined {
    const row = this.db
      .prepare(
        "SELECT snapshot FROM user_state WHERE username=? AND item_id=? AND version=? AND processed_at IS NOT NULL",
      )
      .get(username, id, version) as { snapshot: string | null } | undefined;
    return row?.snapshot
      ? (JSON.parse(row.snapshot) as PublishedItem)
      : row
        ? this.version(id, version)
        : undefined;
  }
  states(username: string): UserState[] {
    return this.db
      .prepare(
        `SELECT item_id AS itemId, version AS contentVersion,
      state_version AS stateVersion, processed_at AS processedAt FROM user_state WHERE username=?`,
      )
      .all(username) as UserState[];
  }
  change(
    username: string,
    id: string,
    input: InboxStateChange,
    expectedProjection: number,
  ): void {
    this.db
      .transaction(() => {
        if (this.revision() !== expectedProjection)
          throw new InboxError(409, "内容已刷新，请重新读取");
        const current = this.catalogItem(id);
        if (!current?.available)
          throw new InboxError(409, "内容已失效或不可用");
        const state = this.states(username).find(
          (item) =>
            item.itemId === id &&
            item.contentVersion === input.expectedContentVersion,
        );
        if (current.item.contentVersion !== input.expectedContentVersion) {
          // Restoring old history is a no-op: explicitly return the current version to the caller.
          if (
            input.state === "pending" &&
            state?.processedAt &&
            state.stateVersion === input.expectedStateVersion
          )
            return;
          throw new InboxError(409, "正文有更新，请重新阅读");
        }
        const currentVersion = state?.stateVersion ?? 0;
        const sameState =
          input.state === (state?.processedAt ? "processed" : "pending");
        if (
          sameState &&
          (currentVersion === input.expectedStateVersion ||
            currentVersion === input.expectedStateVersion + 1)
        )
          return;
        if (currentVersion !== input.expectedStateVersion)
          throw new InboxError(409, "处理状态已变化，请刷新");
        this.db
          .prepare(
            "INSERT OR REPLACE INTO user_state (username,item_id,version,state_version,processed_at,snapshot) VALUES(?,?,?,?,?,?)",
          )
          .run(
            username,
            id,
            input.expectedContentVersion,
            currentVersion + 1,
            input.state === "processed" ? new Date().toISOString() : null,
            input.state === "processed" ? JSON.stringify(current.item) : null,
          );
      })
      .immediate();
  }
}
