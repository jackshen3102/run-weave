import { deviceStorage } from "../device-storage";
import type { RunweaveElectronBridge } from "@runweave/shared/desktop-bridge";
import type {
  TunnelHostConfig,
  TunnelBackendEndpoint,
} from "@runweave/shared/tunnels";
import type { ConnectionConfig, ConnectionStore } from "../connection/types";
import { getConnectionAuth, clearConnectionAuth } from "../auth/storage";
import { useTunnelStore } from "./store";

// The only reader of the retired renderer schema. Commit renderer changes only
// after the main-process import has acknowledged the durable configuration.
let pending: Promise<void> | null = null;
export function migrateLegacyTunnels(storageKey: string): Promise<void> {
  if (pending) return pending;
  pending = migrate(storageKey).finally(() => {
    pending = null;
  });
  return pending;
}
async function migrate(storageKey: string) {
  const api = window.electronAPI as RunweaveElectronBridge | undefined;
  if (!api) return;
  const snapshot = await api.listTunnels();
  useTunnelStore.getState().setSnapshot(snapshot);
  const raw = deviceStorage.getItem(storageKey);
  if (!raw) return;
  const store = JSON.parse(raw) as ConnectionStore;
  type Legacy = ConnectionConfig & {
    kind?: string;
    sshHost?: string;
    sshBackendPort?: number;
    approvedBrowserGroupId?: string | null;
  };
  const legacy = store.connections.filter(
    (c: Legacy) => c.kind === "ssh",
  ) as Legacy[];
  if (!legacy.length) return;
  const migrationId = "renderer-ssh-v1";
  const hosts: TunnelHostConfig[] = [];
  const endpoints: TunnelBackendEndpoint[] = [];
  const backups: Record<string, string> = {};
  for (let i = 0; i < deviceStorage.length; i++) {
    const key = deviceStorage.key(i);
    if (
      key &&
      (key === storageKey ||
        key.startsWith("viewer.remote-forward.") ||
        key.includes("connection-auth") ||
        key.includes("project-binding"))
    )
      backups[key] = deviceStorage.getItem(key)!;
  }
  for (const c of legacy) {
    if (!c.sshHost || !c.sshBackendPort)
      throw new Error("旧 SSH 配置不完整，已保留原数据，请检查后再导入");
    const draftRaw = deviceStorage.getItem(`viewer.remote-forward.${c.id}`);
    const draft = draftRaw
      ? (JSON.parse(draftRaw) as { port: string; path: string })
      : null;
    hosts.push({
      id: `ssh-${c.id}`,
      name: c.name,
      sshTarget: c.sshHost,
      autoConnect: true,
      forwards: draft
        ? [
            {
              id: `port-${c.id}`,
              name: "开发服务",
              port: Number(draft.port),
              path: draft.path,
              enabled: false,
            },
          ]
        : [],
      browser: {
        enabled: true,
        backendPort: c.sshBackendPort,
        profileId: c.browserProfileId ?? "profile-1",
        approvedBrowserGroupId: c.approvedBrowserGroupId ?? null,
      },
    });
    endpoints.push({
      id: `backend-${c.id}`,
      hostId: `ssh-${c.id}`,
      remotePort: c.sshBackendPort,
    });
  }
  // Only authenticated live installation identities can merge aliases. Unreachable
  // or expired sessions stay separate; migration never guesses from a host name.
  const identities = new Map<string, string>();
  await Promise.all(
    store.connections.map(async (c) => {
      const token = getConnectionAuth(c.id)?.accessToken;
      if (!token || !/^https?:\/\//.test(c.url)) return;
      try {
        const response = await fetch(
          `${c.url.replace(/\/$/, "")}/api/remote/capabilities`,
          {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(3000),
            redirect: "error",
          },
        );
        if (!response.ok) return;
        const info = (await response.json()) as { installationId?: unknown };
        if (typeof info.installationId === "string" && info.installationId)
          identities.set(c.id, info.installationId);
      } catch {
        /* Offline aliases are preserved. */
      }
    }),
  );
  const merged = new Map<string, Legacy>();
  for (const old of legacy) {
    const identity = identities.get(old.id);
    const direct =
      identity &&
      store.connections.find(
        (c: Legacy) => c.kind !== "ssh" && identities.get(c.id) === identity,
      );
    if (direct) merged.set(old.id, direct);
  }
  const imported = await api.importTunnels({
    migrationId,
    expectedRevision: snapshot.config.revision,
    hosts: [
      ...snapshot.config.hosts,
      ...hosts.filter(
        (h) => !snapshot.config.hosts.some((old) => old.id === h.id),
      ),
    ],
    backendEndpoints: [
      ...snapshot.config.backendEndpoints,
      ...endpoints.filter(
        (e) => !snapshot.config.backendEndpoints.some((old) => old.id === e.id),
      ),
    ],
    backup: backups,
  });
  if (
    !imported.config.completedImports.includes(migrationId) ||
    endpoints.some(
      (e) =>
        !imported.config.backendEndpoints.some((saved) => saved.id === e.id),
    )
  )
    throw new Error("隧道导入校验失败，原数据未修改");
  if (store.activeId && merged.has(store.activeId))
    store.activeId = merged.get(store.activeId)!.id;
  store.connections = store.connections
    .filter((c) => !merged.has(c.id))
    .map((c: Legacy) =>
      c.kind === "ssh"
        ? {
            id: c.id,
            name: c.name,
            createdAt: c.createdAt,
            url: "",
            tunnelEndpointId: `backend-${c.id}`,
          }
        : c,
    );
  deviceStorage.setItem(storageKey, JSON.stringify(store));
  // The old project allow-list is only retained in the encrypted import backup.
  // Ordinary connections now display all projects returned by their Backend.
  deviceStorage.removeItem("viewer.remote-project-bindings.v1");
  for (const c of legacy) {
    deviceStorage.removeItem(`viewer.remote-forward.${c.id}`);
    if (merged.has(c.id)) clearConnectionAuth(c.id);
  }
  useTunnelStore.getState().setSnapshot(imported);
  useTunnelStore
    .getState()
    .setNotice(
      merged.size
        ? `旧 SSH 配置已迁入端口与隧道。已确认同一 Backend，保留普通入口：${[...merged.values()].map((c) => c.name).join("、")}。浏览器通道需要单独登录。`
        : "旧 SSH 配置已迁入端口与隧道。浏览器通道需要单独登录；原连接入口已保留。",
    );
}
