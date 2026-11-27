import { chmodSync, closeSync, openSync } from "node:fs";
import Database from "better-sqlite3";
import type { TerminalPrWatchState } from "@runweave/shared/pr-watch";
import type { Baseline, Wake } from "./evaluator";

export interface WatchRecord {
  state: TerminalPrWatchState;
  operationId: string;
  generation: string;
  baseline: Baseline;
  pending: Wake | null;
  inputVersion?: string;
}
export class PrWatchStore {
  private db: Database.Database;
  constructor(file: string) {
    closeSync(openSync(file, "a", 0o600));
    chmodSync(file, 0o600);
    this.db = new Database(file);
    try {
      this.db.pragma("journal_mode = WAL");
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS watches (session TEXT PRIMARY KEY, record TEXT NOT NULL)",
      );
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  all() {
    return (
      this.db.prepare("SELECT record FROM watches").all() as {
        record: string;
      }[]
    ).map((r) => JSON.parse(r.record) as WatchRecord);
  }
  get(id: string) {
    const row = this.db
      .prepare("SELECT record FROM watches WHERE session=?")
      .get(id) as { record: string } | undefined;
    return row ? (JSON.parse(row.record) as WatchRecord) : null;
  }
  save(r: WatchRecord) {
    this.db
      .prepare("INSERT OR REPLACE INTO watches VALUES (?,?)")
      .run(r.state.terminalSessionId, JSON.stringify(r));
  }
  delete(id: string) {
    this.db.prepare("DELETE FROM watches WHERE session=?").run(id);
  }
  close() {
    this.db.close();
  }
}
