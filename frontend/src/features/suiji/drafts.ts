import type {
  RecordKind,
  SuijiAttachment,
  SuijiInfo,
  UploadedAttachment,
} from "@runweave/shared/suiji";

export type PendingRequest = {
  path: string;
  method: string;
  data: unknown;
  key: string;
};
export type DraftFile = {
  id: string;
  file: File;
  key: string;
  uploaded?: UploadedAttachment;
};
export type SuijiDraft = {
  id: string;
  kind: RecordKind;
  body: string;
  version?: number;
  existing: SuijiAttachment[];
  files: DraftFile[];
  frozen?: boolean;
  pending?: PendingRequest;
};
export class SuijiDraftStore {
  readonly scope: string;
  private database: Promise<IDBDatabase>;
  constructor(endpoint: string, info: SuijiInfo) {
    this.scope = JSON.stringify([endpoint, info.serverId, info.ownerId]);
    this.database = new Promise((resolve, reject) => {
      const request = indexedDB.open("suiji-local-v1", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("drafts");
      request.onerror = () => reject(new Error("无法打开本机草稿存储"));
      request.onsuccess = () => resolve(request.result);
    });
  }
  async get<T>(id: string): Promise<T | undefined> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const request = db
        .transaction("drafts", "readonly")
        .objectStore("drafts")
        .get(this.scope + ":" + id);
      request.onerror = () => reject(new Error("读取本机草稿失败"));
      request.onsuccess = () => resolve(request.result as T | undefined);
    });
  }
  async set(id: string, value: unknown) {
    const snapshot = structuredClone(value),
      db = await this.database;
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("drafts", "readwrite");
      transaction.objectStore("drafts").put(snapshot, this.scope + ":" + id);
      transaction.oncomplete = () => resolve();
      transaction.onabort = transaction.onerror = () =>
        reject(new Error("本机草稿未保存，可能空间不足，请保留页面并重试"));
    });
  }
  async remove(id: string) {
    const db = await this.database;
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("drafts", "readwrite");
      transaction.objectStore("drafts").delete(this.scope + ":" + id);
      transaction.oncomplete = () => resolve();
      transaction.onabort = transaction.onerror = () =>
        reject(new Error("本机确认状态未保存，请手动重试"));
    });
  }
  close() {
    void this.database.then((db) => db.close()).catch(() => undefined);
  }
}
