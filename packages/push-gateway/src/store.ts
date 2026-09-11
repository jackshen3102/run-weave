import Database from "better-sqlite3";
import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import type { GatewayData } from "./types";

// A separate held SQLite write lock owns the process lifecycle, including crash recovery.
export class GatewayStore {
  private db: Database.Database;
  private owner: Database.Database;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const ownerFile = path.join(directory, "owner.sqlite");
    this.owner = new Database(ownerFile, { timeout: 0 });
    chmodSync(ownerFile, 0o600);
    try {
      this.owner.exec("BEGIN EXCLUSIVE");
    } catch (error) {
      this.owner.close();
      throw error;
    }
    const file = path.join(directory, "state.sqlite");
    this.db = new Database(file);
    chmodSync(file, 0o600);
    try {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = FULL");
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id = 1), value TEXT NOT NULL)",
      );
      this.db.prepare("INSERT OR IGNORE INTO state VALUES (1, ?)").run(
        JSON.stringify({
          schemaVersion: 1,
          senders: {},
          subscriptions: {},
          deliveries: {},
        }),
      );
      this.update((data) => {
        for (const delivery of Object.values(data.deliveries)) {
          if (delivery.state === "sending") delivery.state = "unknown";
        }
      });
    } catch (error) {
      this.close();
      throw error;
    }
  }
  snapshot(): GatewayData {
    const row = this.db
      .prepare("SELECT value FROM state WHERE id = 1")
      .get() as { value: string };
    const value: GatewayData = JSON.parse(row.value);
    if (
      value.schemaVersion !== 1 ||
      !value.senders ||
      !value.subscriptions ||
      !value.deliveries
    ) {
      throw new Error("Unsupported gateway state; existing data retained");
    }
    return value;
  }
  update<T>(mutate: (data: GatewayData) => T): T {
    return this.db.transaction(() => {
      const data = this.snapshot();
      const result = mutate(data);
      this.db
        .prepare("UPDATE state SET value = ? WHERE id = 1")
        .run(JSON.stringify(data));
      return result;
    })();
  }
  close(): void {
    this.db?.close();
    this.owner.close();
  }
}
