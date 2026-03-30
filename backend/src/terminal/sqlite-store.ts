import Database from "better-sqlite3";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type {
  AppendTerminalSessionScrollbackParams,
  PersistedTerminalSessionRecord,
  TerminalSessionStore,
  UpdateTerminalSessionExitParams,
} from "./store";

interface TerminalSessionRow {
  id: string;
  name: string;
  command: string;
  args_json: string;
  cwd: string;
  scrollback: string;
  status: string;
  created_at: string;
  exit_code: number | null;
}

export class SQLiteTerminalSessionStore implements TerminalSessionStore {
  private database: Database.Database | null = null;

  constructor(private readonly databaseFile: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.databaseFile), { recursive: true });

    const database = new Database(this.databaseFile);
    database.pragma("journal_mode = WAL");
    database.exec(`
      create table if not exists terminal_sessions (
        id text primary key,
        name text not null,
        command text not null,
        args_json text not null default '[]',
        cwd text not null,
        scrollback text not null default '',
        status text not null,
        created_at text not null,
        exit_code integer
      );

      create index if not exists idx_terminal_sessions_created_at
      on terminal_sessions(created_at);
    `);
    const columns = database
      .prepare("pragma table_info(terminal_sessions)")
      .all() as Array<{ name: string }>;
    const hasScrollbackColumn = columns.some(
      (column) => column.name === "scrollback",
    );
    if (!hasScrollbackColumn) {
      database.exec(
        "alter table terminal_sessions add column scrollback text not null default ''",
      );
    }
    const hasLegacyBrowserLinkColumn = columns.some(
      (column) => column.name === "linked_browser_session_id",
    );
    const hasLegacyLastActivityColumn = columns.some(
      (column) => column.name === "last_activity_at",
    );
    if (hasLegacyBrowserLinkColumn || hasLegacyLastActivityColumn) {
      database.exec(`
        begin transaction;
        create table terminal_sessions_next (
          id text primary key,
          name text not null,
          command text not null,
          args_json text not null default '[]',
          cwd text not null,
          scrollback text not null default '',
          status text not null,
          created_at text not null,
          exit_code integer
        );
        insert into terminal_sessions_next (
          id,
          name,
          command,
          args_json,
          cwd,
          scrollback,
          status,
          created_at,
          exit_code
        )
        select
          id,
          name,
          command,
          args_json,
          cwd,
          scrollback,
          status,
          created_at,
          exit_code
        from terminal_sessions;
        drop table terminal_sessions;
        alter table terminal_sessions_next rename to terminal_sessions;
        create index if not exists idx_terminal_sessions_created_at
        on terminal_sessions(created_at);
        commit;
      `);
    }

    this.database = database;
  }

  async dispose(): Promise<void> {
    this.database?.close();
    this.database = null;
  }

  async listSessions(): Promise<PersistedTerminalSessionRecord[]> {
    const rows = this.getDatabase()
      .prepare(
        `
          select
            id,
            name,
            command,
            args_json,
            cwd,
            scrollback,
            status,
            created_at,
            exit_code
          from terminal_sessions
          order by created_at asc
        `,
      )
      .all() as TerminalSessionRow[];

    return rows.map((row) => this.toRecord(row));
  }

  async getSession(
    terminalSessionId: string,
  ): Promise<PersistedTerminalSessionRecord | null> {
    const row = this.getDatabase()
      .prepare(
        `
          select
            id,
            name,
            command,
            args_json,
            cwd,
            scrollback,
            status,
            created_at,
            exit_code
          from terminal_sessions
          where id = ?
        `,
      )
      .get(terminalSessionId) as TerminalSessionRow | undefined;

    return row ? this.toRecord(row) : null;
  }

  async insertSession(session: PersistedTerminalSessionRecord): Promise<void> {
    this.getDatabase()
      .prepare(
        `
          insert into terminal_sessions (
            id,
            name,
            command,
            args_json,
            cwd,
            scrollback,
            status,
            created_at,
            exit_code
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        session.id,
        session.name,
        session.command,
        JSON.stringify(session.args),
        session.cwd,
        session.scrollback,
        session.status,
        session.createdAt,
        session.exitCode ?? null,
      );
  }

  async updateSessionName(
    terminalSessionId: string,
    name: string,
  ): Promise<void> {
    this.getDatabase()
      .prepare(
        `
          update terminal_sessions
          set name = ?
          where id = ?
        `,
      )
      .run(name, terminalSessionId);
  }

  async appendSessionScrollback(
    params: AppendTerminalSessionScrollbackParams,
  ): Promise<void> {
    this.getDatabase()
      .prepare(
        `
          update terminal_sessions
          set scrollback = substr(coalesce(scrollback, '') || ?, -?)
          where id = ?
        `,
      )
      .run(params.chunk, params.maxLength, params.terminalSessionId);
  }

  async updateSessionExit(
    params: UpdateTerminalSessionExitParams,
  ): Promise<void> {
    this.getDatabase()
      .prepare(
        `
          update terminal_sessions
          set status = ?, exit_code = ?
          where id = ?
        `,
      )
      .run(
        params.status,
        params.exitCode ?? null,
        params.terminalSessionId,
      );
  }

  async deleteSession(terminalSessionId: string): Promise<void> {
    this.getDatabase()
      .prepare("delete from terminal_sessions where id = ?")
      .run(terminalSessionId);
  }

  private getDatabase(): Database.Database {
    if (!this.database) {
      throw new Error("[viewer-be] terminal session store not initialized");
    }

    return this.database;
  }

  private toRecord(row: TerminalSessionRow): PersistedTerminalSessionRecord {
    return {
      id: row.id,
      name: row.name,
      command: row.command,
      args: this.parseArgs(row.args_json),
      cwd: row.cwd,
      scrollback: row.scrollback ?? "",
      status: row.status === "exited" ? "exited" : "running",
      createdAt: row.created_at,
      exitCode: row.exit_code ?? undefined,
    };
  }

  private parseArgs(rawArgs: string): string[] {
    try {
      const parsed = JSON.parse(rawArgs) as unknown;
      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed.filter((value): value is string => typeof value === "string");
    } catch {
      return [];
    }
  }
}
