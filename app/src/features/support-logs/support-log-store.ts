import type {
  SupportLogRecord,
  SupportLogStore,
  SupportLogStoreStatus,
} from "./support-log-types";

const DB_NAME = "runweave_support_logs_v1";
const STORE_NAME = "records";
const MAX_INDEXEDDB_RECORDS = 2000;
const MAX_INDEXEDDB_BYTES = 2 * 1024 * 1024;
const MAX_MEMORY_RECORDS = 300;
const MAX_MEMORY_BYTES = 256 * 1024;

interface StoredSupportLogRecord extends SupportLogRecord {
  id: string;
}

function estimateBytes(value: unknown): number {
  return new Blob([JSON.stringify(value)]).size;
}

function createRecordId(record: SupportLogRecord): string {
  return `${record.at}:${crypto.randomUUID()}`;
}

function trimByCapacity<T>(
  records: T[],
  maxRecords: number,
  maxBytes: number,
): T[] {
  let next = records.slice(-maxRecords);
  let bytes = estimateBytes(next);
  while (next.length > 0 && bytes > maxBytes) {
    next = next.slice(1);
    bytes = estimateBytes(next);
  }
  return next;
}

function toSupportLogRecord(record: StoredSupportLogRecord): SupportLogRecord {
  return {
    at: record.at,
    event: record.event,
    fields: record.fields,
    level: record.level,
    source: record.source,
  };
}

function recordDedupeKey(record: SupportLogRecord): string {
  return JSON.stringify(record);
}

function mergeRecords(
  indexedDbRecords: StoredSupportLogRecord[],
  memoryRecords: SupportLogRecord[],
): SupportLogRecord[] {
  const records = indexedDbRecords.map(toSupportLogRecord);
  const seen = new Set(records.map(recordDedupeKey));
  for (const record of memoryRecords) {
    const key = recordDedupeKey(record);
    if (!seen.has(key)) {
      seen.add(key);
      records.push(record);
    }
  }
  return records.sort((a, b) => a.at.localeCompare(b.at));
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error));
    transaction.addEventListener("error", () => reject(transaction.error));
  });
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.addEventListener("upgradeneeded", () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => resolve(null));
    request.addEventListener("blocked", () => resolve(null));
  });
}

async function readAllRecords(db: IDBDatabase): Promise<StoredSupportLogRecord[]> {
  const transaction = db.transaction(STORE_NAME, "readonly");
  const store = transaction.objectStore(STORE_NAME);
  const records = await requestToPromise(store.getAll());
  return (records as StoredSupportLogRecord[]).sort((a, b) =>
    a.at.localeCompare(b.at),
  );
}

async function replaceAllRecords(
  db: IDBDatabase,
  records: StoredSupportLogRecord[],
): Promise<void> {
  const transaction = db.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  store.clear();
  for (const record of records) {
    store.put(record);
  }
  await transactionDone(transaction);
}

export function createSupportLogStore(): SupportLogStore {
  let databasePromise: Promise<IDBDatabase | null> | null = null;
  let memoryRecords: SupportLogRecord[] = [];
  let storageDegraded = false;
  let storageKind: SupportLogStoreStatus["storageKind"] = "indexeddb";

  const getDatabase = async () => {
    databasePromise ??= openDatabase();
    const db = await databasePromise;
    if (!db) {
      storageDegraded = true;
      storageKind = "memory";
    }
    return db;
  };

  const rememberMemoryRecord = (record: SupportLogRecord) => {
    memoryRecords = trimByCapacity(
      [...memoryRecords, record],
      MAX_MEMORY_RECORDS,
      MAX_MEMORY_BYTES,
    );
  };

  const appendMemory = (record: SupportLogRecord) => {
    storageKind = "memory";
    rememberMemoryRecord(record);
  };

  const trimIndexedDb = async (db: IDBDatabase) => {
    const records = await readAllRecords(db);
    const trimmed = trimByCapacity(
      records,
      MAX_INDEXEDDB_RECORDS,
      MAX_INDEXEDDB_BYTES,
    );
    if (trimmed.length !== records.length) {
      await replaceAllRecords(db, trimmed);
    }
  };

  return {
    async append(record) {
      rememberMemoryRecord(record);
      try {
        const db = await getDatabase();
        if (!db) {
          return;
        }

        const storedRecord: StoredSupportLogRecord = {
          ...record,
          id: createRecordId(record),
        };
        try {
          const transaction = db.transaction(STORE_NAME, "readwrite");
          transaction.objectStore(STORE_NAME).add(storedRecord);
          await transactionDone(transaction);
          await trimIndexedDb(db);
        } catch {
          storageDegraded = true;
          await trimIndexedDb(db);
          const retry = db.transaction(STORE_NAME, "readwrite");
          retry.objectStore(STORE_NAME).add(storedRecord);
          await transactionDone(retry);
        }
      } catch {
        storageDegraded = true;
        appendMemory(record);
      }
    },

    async listRecent(options) {
      const since = options?.since;
      const limit = options?.limit;
      try {
        const db = await getDatabase();
        const records = db
          ? mergeRecords(await readAllRecords(db), memoryRecords)
          : memoryRecords;
        const filtered = records.filter(
          (record) => !since || new Date(record.at) >= since,
        );
        return typeof limit === "number" ? filtered.slice(-limit) : filtered;
      } catch {
        storageDegraded = true;
        const filtered = memoryRecords.filter(
          (record) => !since || new Date(record.at) >= since,
        );
        return typeof limit === "number" ? filtered.slice(-limit) : filtered;
      }
    },

    async clear() {
      memoryRecords = [];
      try {
        const db = await getDatabase();
        if (!db) {
          return;
        }
        const transaction = db.transaction(STORE_NAME, "readwrite");
        transaction.objectStore(STORE_NAME).clear();
        await transactionDone(transaction);
      } catch {
        storageDegraded = true;
      }
    },

    getStatus() {
      return {
        storageDegraded,
        storageKind,
      };
    },
  };
}
