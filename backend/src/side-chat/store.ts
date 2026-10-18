import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { SideChat, SideChatMessage, SideChatMessagePage, SideChatOperation, SideChatTurn } from "@runweave/shared/side-chat";

export interface StoredChat extends SideChat {
  ownerScope: string;
  sourceKey: string;
  providerThreadId: string | null;
}
export interface StoredTurn extends SideChatTurn { providerTurnId: string | null }
interface StoredOperation { fingerprint: string; result: SideChatOperation }

/** Small, independent control-plane DB. No model/RPC work takes place inside transactions. */
export class SideChatStore {
  private readonly db: Database.Database;
  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new Database(file);
    try {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("busy_timeout = 1000");
      const version = this.db.pragma("user_version", { simple: true });
      if (version !== 0 && version !== 1) throw new Error("Unsupported side chat schema");
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS chats (
            id TEXT PRIMARY KEY, owner TEXT NOT NULL, source_key TEXT NOT NULL,
            status TEXT NOT NULL, data TEXT NOT NULL
          );
          CREATE UNIQUE INDEX IF NOT EXISTS active_source ON chats(owner, source_key) WHERE status != 'ended';
          CREATE TABLE IF NOT EXISTS turns (
            id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), state TEXT NOT NULL, data TEXT NOT NULL
          );
          CREATE UNIQUE INDEX IF NOT EXISTS active_turn ON turns(chat_id) WHERE state IN ('accepted','running','stopping','unknown');
          CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), sequence INTEGER NOT NULL,
            turn_id TEXT NOT NULL REFERENCES turns(id), data TEXT NOT NULL, UNIQUE(chat_id, sequence)
          );
          CREATE TABLE IF NOT EXISTS operations (
            owner TEXT NOT NULL, id TEXT NOT NULL, chat_id TEXT NOT NULL REFERENCES chats(id),
            fingerprint TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(owner, id)
          );
          PRAGMA user_version = 1;
        `);
      });
    } catch (error) { this.db.close(); throw error; }
  }
  transaction<T>(body: () => T): T { return this.db.transaction(body).immediate(); }
  close(): void { this.db.close(); }
  chat(id: string, owner: string): StoredChat | null {
    return this.read<StoredChat>("SELECT data FROM chats WHERE id=? AND owner=?", id, owner);
  }
  active(owner: string, sourceKey: string): StoredChat | null {
    return this.read<StoredChat>("SELECT data FROM chats WHERE owner=? AND source_key=? AND status != 'ended'", owner, sourceKey);
  }
  all(): StoredChat[] { return this.rows<StoredChat>("SELECT data FROM chats WHERE status != 'ended'"); }
  saveChat(chat: StoredChat): void {
    this.db.prepare("INSERT INTO chats(id,owner,source_key,status,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data")
      .run(chat.id, chat.ownerScope, chat.sourceKey, chat.status, JSON.stringify(chat));
  }
  turn(id: string): StoredTurn | null { return this.read<StoredTurn>("SELECT data FROM turns WHERE id=?", id); }
  current(chatId: string): StoredTurn | null {
    return this.read<StoredTurn>("SELECT data FROM turns WHERE chat_id=? ORDER BY rowid DESC LIMIT 1", chatId);
  }
  saveTurn(turn: StoredTurn): void {
    this.db.prepare("INSERT INTO turns(id,chat_id,state,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data")
      .run(turn.id, turn.sideChatId, turn.state, JSON.stringify(turn));
  }
  message(message: Omit<SideChatMessage, "sequence">): void {
    if (this.db.prepare("SELECT 1 FROM messages WHERE id=?").get(message.id)) return;
    const row = this.db.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS n FROM messages WHERE chat_id=?").get(message.sideChatId) as { n: number };
    const data: SideChatMessage = { ...message, sequence: row.n };
    this.db.prepare("INSERT INTO messages(id,chat_id,sequence,turn_id,data) VALUES(?,?,?,?,?)")
      .run(data.id, data.sideChatId, data.sequence, data.turnId, JSON.stringify(data));
  }
  page(chatId: string, before = Number.MAX_SAFE_INTEGER, limit = 50): SideChatMessagePage {
    const rows = this.db.prepare("SELECT m.data,t.state FROM messages m JOIN turns t ON t.id=m.turn_id WHERE m.chat_id=? AND m.sequence<? ORDER BY m.sequence DESC LIMIT ?")
      .all(chatId, before, limit + 1) as Array<{ data: string; state: SideChatTurn["state"] }>;
    const messages = rows.map(row => ({ ...JSON.parse(row.data) as SideChatMessage, turnState: row.state }));
    const hasMore = messages.length > limit;
    if (hasMore) messages.pop();
    messages.reverse();
    return { messages, beforeSequence: hasMore ? messages[0]!.sequence : null };
  }
  operation(owner: string, id: string): StoredOperation | null {
    const row = this.db.prepare("SELECT fingerprint,data FROM operations WHERE owner=? AND id=?").get(owner, id) as { fingerprint: string; data: string } | undefined;
    return row ? { fingerprint: row.fingerprint, result: JSON.parse(row.data) as SideChatOperation } : null;
  }
  saveOperation(owner: string, fingerprint: string, result: SideChatOperation): void {
    this.db.prepare("INSERT INTO operations(owner,id,chat_id,fingerprint,data) VALUES(?,?,?,?,?) ON CONFLICT(owner,id) DO UPDATE SET data=excluded.data")
      .run(owner, result.operationId, result.sideChatId, fingerprint, JSON.stringify(result));
  }
  settleOperations(chat: StoredChat, turnId: string | null, state: SideChatOperation["state"], kind?: SideChatOperation["kind"]): void {
    for (const result of this.rows<SideChatOperation>("SELECT data FROM operations WHERE owner=? AND chat_id=?", chat.ownerScope, chat.id)) {
      if (result.state === "completed" || (turnId && result.turnId !== turnId) || (kind && result.kind !== kind)) continue;
      const stored = this.operation(chat.ownerScope, result.operationId)!;
      this.saveOperation(chat.ownerScope, stored.fingerprint, { ...result, state });
    }
  }
  private read<T>(sql: string, ...params: (string | number)[]): T | null {
    const row = this.db.prepare(sql).get(...params) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as T : null;
  }
  private rows<T>(sql: string, ...params: (string | number)[]): T[] {
    return (this.db.prepare(sql).all(...params) as { data: string }[]).map(row => JSON.parse(row.data) as T);
  }
}
