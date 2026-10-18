import type {
  TaskHandoffCard,
  TaskHandoffTarget,
} from "@runweave/shared/task-handoff";
import type { SuijiEnvironment } from "@runweave/shared/suiji/desktop";

export type HandoffBackend = {
  connectionId: string | null;
  apiBase: string;
  endpointId: string | null;
};
export type HandoffAccount = {
  environment: SuijiEnvironment;
  endpoint: string;
  serverId: string;
  ownerId: string;
};
export type LocalHandoffLink = {
  schemaVersion: 1;
  linkId: string;
  backend: HandoffBackend;
  target: TaskHandoffTarget;
  projectId: string;
  suiji: HandoffAccount & { recordId: string };
  confirmedSource: { recordVersion: number; latestFollowupSequence: number };
  revision: number;
  linkedAt: string;
};
export type ObservedHandoffSource = {
  linkId: string;
  card: TaskHandoffCard;
  observedAt: string;
  sessionName: string;
};
type LinkRow = { key: string; scope: string; link: LocalHandoffLink };
export const handoffAccountKey = (
  backend: HandoffBackend,
  account: HandoffAccount,
) => JSON.stringify([backend, account]);
export const handoffTargetKey = (target: TaskHandoffTarget) =>
  JSON.stringify([target.terminalSessionId, target.panelId, target.threadId]);
export const sameHandoffTarget = (a: TaskHandoffTarget, b: TaskHandoffTarget) =>
  handoffTargetKey(a) === handoffTargetKey(b);
const linkKey = (
  link: Pick<LocalHandoffLink, "backend" | "suiji" | "target">,
) =>
  JSON.stringify([
    handoffAccountKey(link.backend, accountOf(link.suiji)),
    handoffTargetKey(link.target),
  ]);
function accountOf(value: HandoffAccount): HandoffAccount {
  return {
    environment: value.environment,
    endpoint: value.endpoint,
    serverId: value.serverId,
    ownerId: value.ownerId,
  };
}

/** Device-local relationships only. No cloud writes, credentials or execution ownership. */
class HandoffContextLinkStore {
  private database?: Promise<IDBDatabase>;
  private listeners = new Set<() => void>();
  private channel?: BroadcastChannel;
  private open() {
    if (!this.database) {
      this.database = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("runweave-handoff-links-v1", 1);
        request.onupgradeneeded = () => {
          request.result
            .createObjectStore("links", { keyPath: "key" })
            .createIndex("scope", "scope");
          request.result.createObjectStore("observed-sources", {
            keyPath: "linkId",
          });
        };
        request.onerror = () => reject(new Error("无法打开本机关联存储"));
        request.onblocked = () =>
          reject(new Error("本机关联存储被其他页面占用，请关闭旧页面后重试"));
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => {
            db.close();
            this.database = undefined;
          };
          resolve(db);
        };
      }).catch((error: unknown) => {
        this.database = undefined;
        throw error;
      });
    }
    return this.database;
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (!this.channel && typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel("runweave-handoff-links-v1");
      this.channel.onmessage = () => this.emit();
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        this.channel?.close();
        this.channel = undefined;
      }
    };
  };
  private emit() {
    for (const listener of this.listeners) listener();
  }
  private changed(key: string, revision: number) {
    this.emit();
    this.channel?.postMessage({ key, revision });
  }
  async list(
    backend: HandoffBackend,
    account: HandoffAccount,
  ): Promise<LocalHandoffLink[]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const request = db
        .transaction("links")
        .objectStore("links")
        .index("scope")
        .getAll(handoffAccountKey(backend, account));
      request.onsuccess = () =>
        resolve((request.result as LinkRow[]).map((row) => row.link));
      request.onerror = () => reject(new Error("读取本机关联失败"));
    });
  }
  async sources(links: LocalHandoffLink[]): Promise<ObservedHandoffSource[]> {
    if (!links.length) return [];
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("observed-sources");
      const items: ObservedHandoffSource[] = [];
      for (const link of links) {
        const request = tx.objectStore("observed-sources").get(link.linkId);
        request.onsuccess = () => {
          if (request.result)
            items.push(request.result as ObservedHandoffSource);
        };
      }
      tx.oncomplete = () => resolve(items);
      tx.onabort = tx.onerror = () => reject(new Error("读取成果摘录失败"));
    });
  }
  async create(
    link: LocalHandoffLink,
    isCurrent: () => boolean,
    source?: { card: TaskHandoffCard; sessionName: string },
  ): Promise<LocalHandoffLink> {
    const db = await this.open();
    const key = linkKey(link);
    const result = await new Promise<LocalHandoffLink>((resolve, reject) => {
      const tx = db.transaction(["links", "observed-sources"], "readwrite");
      const store = tx.objectStore("links");
      let saved = link;
      let failure = "本机关联未保存，请手动重试";
      const request = store.get(key);
      request.onsuccess = () => {
        if (!isCurrent()) {
          failure = "会话或账号已切换，请重新选择";
          tx.abort();
          return;
        }
        const old = (request.result as LinkRow | undefined)?.link;
        if (old) {
          if (
            old.suiji.recordId !== link.suiji.recordId ||
            old.projectId !== link.projectId ||
            old.confirmedSource.recordVersion !== link.confirmedSource.recordVersion ||
            old.confirmedSource.latestFollowupSequence !== link.confirmedSource.latestFollowupSequence
          ) {
            failure = "关联已变化，请刷新后重新选择";
            tx.abort();
            return;
          }
          saved = old;
        } else {
          store.add({
            key,
            scope: handoffAccountKey(link.backend, accountOf(link.suiji)),
            link,
          } satisfies LinkRow);
          if (source && sameHandoffTarget(source.card.target, link.target)) {
            tx.objectStore("observed-sources").put({
              linkId: link.linkId,
              card: structuredClone(source.card),
              sessionName: source.sessionName,
              observedAt: new Date().toISOString(),
            } satisfies ObservedHandoffSource);
          }
        }
      };
      tx.oncomplete = () => resolve(saved);
      tx.onabort = tx.onerror = () => reject(new Error(failure));
    });
    this.changed(key, result.revision);
    return result;
  }
  async remove(
    link: LocalHandoffLink,
    isCurrent: () => boolean,
  ): Promise<void> {
    const db = await this.open();
    const key = linkKey(link);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["links", "observed-sources"], "readwrite");
      const store = tx.objectStore("links");
      let failure = "解除关联未保存，请手动重试";
      const request = store.get(key);
      request.onsuccess = () => {
        const old = (request.result as LinkRow | undefined)?.link;
        if (
          !isCurrent() ||
          !old ||
          old.linkId !== link.linkId ||
          old.revision !== link.revision
        ) {
          failure = "关联或当前会话已变化，请刷新后重试";
          tx.abort();
          return;
        }
        store.delete(key);
        tx.objectStore("observed-sources").delete(link.linkId);
      };
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(new Error(failure));
    });
    this.changed(key, link.revision + 1);
  }
  async observe(
    link: LocalHandoffLink,
    card: TaskHandoffCard,
    sessionName: string,
    isCurrent: () => boolean,
  ) {
    if (!sameHandoffTarget(card.target, link.target)) return;
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["links", "observed-sources"], "readwrite");
      const request = tx.objectStore("links").get(linkKey(link));
      request.onsuccess = () => {
        const old = (request.result as LinkRow | undefined)?.link;
        if (
          !isCurrent() ||
          old?.linkId !== link.linkId ||
          old.revision !== link.revision
        ) {
          tx.abort();
          return;
        }
        const sources = tx.objectStore("observed-sources");
        const cached = sources.get(link.linkId);
        cached.onsuccess = () => {
          if (!isCurrent()) { tx.abort(); return; }
          const previous = cached.result as ObservedHandoffSource | undefined;
          if (previous && previous.card.revision >= card.revision) return;
          sources.put({
            linkId: link.linkId,
            card: structuredClone(card),
            sessionName,
            observedAt: new Date().toISOString(),
          } satisfies ObservedHandoffSource);
        };
      };
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () =>
        reject(new Error("成果摘录未保存；原始记录仍可查看"));
    });
  }
}
export const handoffContextLinks = new HandoffContextLinkStore();
