import Database from "better-sqlite3";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { SessionHeaders } from "@browser-viewer/shared";
import type {
  PersistedSessionRecord,
  SessionStore,
  UpdateSessionConnectionParams,
} from "./store";

interface SessionRow {
  id: string;
  target_url: string;
  proxy_enabled: number;
  connected: number;
  profile_path: string;
  profile_mode: string;
  headers_json: string;
  created_at: string;
  last_activity_at: string;
}

interface TableInfoRow {
  name: string;
}

export class SQLiteSessionStore implements SessionStore {
  private database: Database.Database | null = null;

  constructor(private readonly databaseFile: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.databaseFile), { recursive: true });

    const database = new Database(this.databaseFile);
    database.pragma("journal_mode = WAL");
    database.exec(`
      create table if not exists sessions (
        id text primary key,
        target_url text not null,
        proxy_enabled integer not null default 0,
        connected integer not null default 0,
        profile_path text not null,
        profile_mode text not null default 'managed',
        headers_json text not null default '{}',
        created_at text not null,
        last_activity_at text not null
      );

      create index if not exists idx_sessions_last_activity_at
      on sessions(last_activity_at);
    `);
    this.ensureProxyEnabledColumn(database);
    this.ensureProfileModeColumn(database);
    this.ensureHeadersColumn(database);

    this.database = database;
  }

  async dispose(): Promise<void> {
    this.database?.close();
    this.database = null;
  }

  async listSessions(): Promise<PersistedSessionRecord[]> {
    const rows = this.getDatabase()
      .prepare(
        `
          select
            id,
            target_url,
            proxy_enabled,
            connected,
            profile_path,
            profile_mode,
            headers_json,
            created_at,
            last_activity_at
          from sessions
          order by created_at asc
        `,
      )
      .all() as SessionRow[];

    return rows.map((row) => this.toRecord(row));
  }

  async getSession(sessionId: string): Promise<PersistedSessionRecord | null> {
    const row = this.getDatabase()
      .prepare(
        `
          select
            id,
            target_url,
            proxy_enabled,
            connected,
            profile_path,
            profile_mode,
            headers_json,
            created_at,
            last_activity_at
          from sessions
          where id = ?
        `,
      )
      .get(sessionId) as SessionRow | undefined;

    return row ? this.toRecord(row) : null;
  }

  async insertSession(session: PersistedSessionRecord): Promise<void> {
    this.getDatabase()
      .prepare(
        `
          insert into sessions (
            id,
            target_url,
            proxy_enabled,
            connected,
            profile_path,
            profile_mode,
            headers_json,
            created_at,
            last_activity_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        session.id,
        session.targetUrl,
        session.proxyEnabled ? 1 : 0,
        session.connected ? 1 : 0,
        session.profilePath,
        session.profileMode,
        JSON.stringify(session.headers),
        session.createdAt,
        session.lastActivityAt,
      );
  }

  async updateSessionConnection(
    params: UpdateSessionConnectionParams,
  ): Promise<void> {
    this.getDatabase()
      .prepare(
        `
          update sessions
          set connected = ?, last_activity_at = ?
          where id = ?
        `,
      )
      .run(params.connected ? 1 : 0, params.lastActivityAt, params.sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.getDatabase()
      .prepare("delete from sessions where id = ?")
      .run(sessionId);
  }

  private getDatabase(): Database.Database {
    if (!this.database) {
      throw new Error("[viewer-be] session store not initialized");
    }

    return this.database;
  }

  private ensureProxyEnabledColumn(database: Database.Database): void {
    const columns = database
      .prepare("pragma table_info(sessions)")
      .all() as TableInfoRow[];

    if (columns.some((column) => column.name === "proxy_enabled")) {
      return;
    }

    database.exec(
      "alter table sessions add column proxy_enabled integer not null default 0",
    );
  }

  private ensureProfileModeColumn(database: Database.Database): void {
    const columns = database
      .prepare("pragma table_info(sessions)")
      .all() as TableInfoRow[];

    if (columns.some((column) => column.name === "profile_mode")) {
      return;
    }

    database.exec(
      "alter table sessions add column profile_mode text not null default 'managed'",
    );
  }

  private ensureHeadersColumn(database: Database.Database): void {
    const columns = database
      .prepare("pragma table_info(sessions)")
      .all() as TableInfoRow[];

    if (columns.some((column) => column.name === "headers_json")) {
      return;
    }

    database.exec(
      "alter table sessions add column headers_json text not null default '{}'",
    );
  }

  private toRecord(row: SessionRow): PersistedSessionRecord {
    return {
      id: row.id,
      targetUrl: row.target_url,
      proxyEnabled: row.proxy_enabled === 1,
      connected: row.connected === 1,
      profilePath: row.profile_path,
      profileMode: row.profile_mode === "custom" ? "custom" : "managed",
      headers: this.parseHeaders(row.headers_json),
      createdAt: row.created_at,
      lastActivityAt: row.last_activity_at,
    };
  }

  private parseHeaders(rawHeaders: string): SessionHeaders {
    try {
      const parsed = JSON.parse(rawHeaders) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }

      return Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
    } catch {
      return {};
    }
  }
}
