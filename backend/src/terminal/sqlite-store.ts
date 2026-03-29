import Database from "better-sqlite3";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type {
  PersistedTerminalSessionRecord,
  TerminalSessionStore,
  UpdateTerminalSessionActivityParams,
  UpdateTerminalSessionExitParams,
} from "./store";

interface TerminalSessionRow {
  id: string;
  name: string;
  command: string;
  args_json: string;
  cwd: string;
  linked_browser_session_id: string | null;
  status: string;
  created_at: string;
  last_activity_at: string;
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
        linked_browser_session_id text,
        status text not null,
        created_at text not null,
        last_activity_at text not null,
        exit_code integer
      );

      create index if not exists idx_terminal_sessions_last_activity_at
      on terminal_sessions(last_activity_at);
    `);

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
            linked_browser_session_id,
            status,
            created_at,
            last_activity_at,
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
            linked_browser_session_id,
            status,
            created_at,
            last_activity_at,
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
            linked_browser_session_id,
            status,
            created_at,
            last_activity_at,
            exit_code
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        session.id,
        session.name,
        session.command,
        JSON.stringify(session.args),
        session.cwd,
        session.linkedBrowserSessionId ?? null,
        session.status,
        session.createdAt,
        session.lastActivityAt,
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

  async updateSessionActivity(
    params: UpdateTerminalSessionActivityParams,
  ): Promise<void> {
    this.getDatabase()
      .prepare(
        `
          update terminal_sessions
          set last_activity_at = ?
          where id = ?
        `,
      )
      .run(params.lastActivityAt, params.terminalSessionId);
  }

  async updateSessionExit(
    params: UpdateTerminalSessionExitParams,
  ): Promise<void> {
    this.getDatabase()
      .prepare(
        `
          update terminal_sessions
          set status = ?, exit_code = ?, last_activity_at = ?
          where id = ?
        `,
      )
      .run(
        params.status,
        params.exitCode ?? null,
        params.lastActivityAt,
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
      linkedBrowserSessionId: row.linked_browser_session_id ?? undefined,
      status: row.status === "exited" ? "exited" : "running",
      createdAt: row.created_at,
      lastActivityAt: row.last_activity_at,
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
