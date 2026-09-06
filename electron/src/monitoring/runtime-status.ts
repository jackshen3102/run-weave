import { BrowserWindow, Notification, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import {
  isRuntimeStatusCapabilityId,
  type RuntimeStatusCapabilityId,
  type RuntimeStatusFact,
  type RuntimeStatusItem,
  type RuntimeStatusReport,
} from "@runweave/shared/runtime-status";
import { getTerminalBrowserProfileRuntimeStates } from "../browser/profile/runtime.js";
import type { DesktopCompanionAgent } from "../companion/agent.js";
import { desktopRuntime } from "../desktop/runtime-state.js";
import { resolveLocalConnectionAddresses } from "../desktop/connection-address.js";

const electronInstanceId =
  process.env.RUNWEAVE_DESKTOP_INSTANCE_ID?.trim() ||
  `electron:${process.pid}:${randomUUID()}`;

export function buildElectronRuntimeStatusReport(options: {
  companion: DesktopCompanionAgent | null;
  companionEnabled: boolean;
  now?: number;
}): RuntimeStatusReport {
  const now = options.now ?? Date.now();
  const backend = desktopRuntime.packagedBackendState;
  const addresses = resolveLocalConnectionAddresses(backend.backendUrl);
  const addressFacts: RuntimeStatusFact[] = [];
  if (addresses.primary) {
    addressFacts.push({
      id: "electron.local-network.primary",
      label: "局域网地址",
      value: addresses.primary,
      kind: "address",
      copyable: true,
    });
  }
  for (const [index, candidate] of addresses.candidates.slice(1).entries()) {
    addressFacts.push({
      id: `electron.local-network.candidate-${index + 1}`,
      label: "候选地址",
      value: candidate,
      kind: "address",
      copyable: true,
    });
  }
  if (addresses.loopback) {
    addressFacts.push({
      id: "electron.local-network.loopback",
      label: "本机地址",
      value: addresses.loopback,
      kind: "address",
      copyable: true,
    });
  }

  const companion = options.companion?.getStatusSnapshot();
  const items: RuntimeStatusItem[] = [
    {
      ...item(
        "electron.process",
        "Electron process",
        "healthy",
        "Electron 主进程可响应",
        now,
      ),
      dependsOn: [],
    },
    {
      ...item(
        "electron.packaged-backend",
        "Packaged Backend",
        backend.available
          ? "healthy"
          : desktopRuntime.packagedBackendRestartPromise
            ? "recovering"
            : "unhealthy",
        backend.available
          ? "本机 Backend 已就绪"
          : desktopRuntime.packagedBackendRestartPromise
            ? "本机 Backend 正在启动"
            : "本机 Backend 不可用",
        now,
      ),
      facts: backend.backendUrl
        ? [
            {
              id: "electron.packaged-backend.address",
              label: "地址",
              value: backend.backendUrl,
              kind: "address",
              copyable: true,
            },
          ]
        : [],
    },
    {
      ...item(
        "electron.local-network",
        "Local network",
        !backend.available
          ? "blocked"
          : addresses.primary
            ? "healthy"
            : "unhealthy",
        backend.available && addresses.primary
          ? "局域网地址可用"
          : "仅本机可用",
        now,
      ),
      dependsOn: ["electron.packaged-backend"],
      facts: addressFacts,
    },
    {
      ...item(
        "electron.cdp-proxy",
        "CDP Proxy",
        desktopRuntime.cdpProxy ? "healthy" : "unhealthy",
        desktopRuntime.cdpProxy ? "CDP Proxy 已监听" : "CDP Proxy 不可用",
        now,
      ),
      facts: desktopRuntime.cdpProxy
        ? [
            {
              id: "electron.cdp-proxy.port",
              label: "端口",
              value: String(desktopRuntime.cdpProxy.port),
              kind: "port",
              copyable: true,
            },
          ]
        : [],
    },
    buildCompanionItem(options.companionEnabled, companion, now),
    ...getTerminalBrowserProfileRuntimeStates().map((profile) => {
      const expected =
        profile.proxyMode === "whistle" &&
        (profile.visibleViewCount > 0 || profile.cdpConnectionCount > 0);
      const state = !expected
        ? "disabled"
        : profile.whistle.status === "ready"
          ? "healthy"
          : profile.whistle.status === "starting"
            ? "recovering"
            : "unhealthy";
      return {
        ...item(
          `electron.whistle:${profile.profileId}`,
          `Whistle ${profile.profileId}`,
          state,
          !expected
            ? "Profile 未使用代理"
            : state === "healthy"
              ? "Whistle 已就绪"
              : state === "recovering"
                ? "Whistle 正在启动"
                : `Whistle 启动失败${profile.whistle.error?.code ? ` (${profile.whistle.error.code})` : ""}`,
          now,
        ),
        facts: expected
          ? [
              {
                id: "electron.whistle.port",
                label: "端口",
                value: String(profile.whistle.port),
                kind: "port" as const,
                copyable: true,
              },
            ]
          : [],
      };
    }),
  ];

  return {
    protocolVersion: 1,
    target: { kind: "local-host" },
    source: {
      id: "electron",
      runtime: "electron",
      instanceId: electronInstanceId,
      capabilityId: "desktop",
    },
    observedAt: now,
    validForMs: 15_000,
    items,
  };
}

export function registerRuntimeStatusHandlers(options: {
  getCompanion: () => DesktopCompanionAgent | null;
  isCompanionEnabled: () => boolean;
}): void {
  const requireMainRenderer = (senderId: number): BrowserWindow => {
    const mainWindow = desktopRuntime.mainWindow;
    if (
      !mainWindow ||
      mainWindow.isDestroyed() ||
      mainWindow.webContents.id !== senderId
    ) {
      throw new Error("Main window sender required");
    }
    return mainWindow;
  };
  ipcMain.handle("runtime-status:get-report", (event) => {
    requireMainRenderer(event.sender.id);
    return buildElectronRuntimeStatusReport({
      companion: options.getCompanion(),
      companionEnabled: options.isCompanionEnabled(),
    });
  });
  ipcMain.handle("runtime-status:notify", (event, input: unknown): boolean => {
    const mainWindow = requireMainRenderer(event.sender.id);
    if (mainWindow.isVisible() && mainWindow.isFocused()) return false;
    if (!isNotificationInput(input))
      throw new Error("Invalid runtime status notification");
    new Notification({
      title: input.title,
      body: input.body,
      silent: true,
    }).show();
    return true;
  });
}

function buildCompanionItem(
  enabled: boolean,
  snapshot: ReturnType<DesktopCompanionAgent["getStatusSnapshot"]> | undefined,
  now: number,
): RuntimeStatusItem {
  if (!enabled)
    return item(
      "electron.companion",
      "Companion",
      "disabled",
      "Companion 未启用",
      now,
    );
  const state = snapshot?.ready
    ? "healthy"
    : snapshot?.failureSince && now - snapshot.failureSince >= 30_000
      ? "unhealthy"
      : "recovering";
  return {
    ...item(
      "electron.companion",
      "Companion",
      state,
      state === "healthy"
        ? "Companion 已就绪"
        : state === "unhealthy"
          ? "Companion 持续启动失败"
          : "Companion 正在启动",
      snapshot?.observedAt ?? now,
    ),
    recovery:
      state === "healthy"
        ? null
        : {
            startedAt: snapshot?.failureSince ?? now,
            attempt: snapshot?.restartAttempt ?? 0,
            maxAttempts: null,
            nextAttemptAt: snapshot?.nextAttemptAt ?? null,
            deadlineAt: (snapshot?.failureSince ?? now) + 30_000,
          },
  };
}

function item(
  id: string,
  label: string,
  state: RuntimeStatusItem["state"],
  summary: string,
  observedAt: number,
): RuntimeStatusItem {
  return {
    id,
    capabilityId: "desktop",
    label,
    state,
    summary,
    observedAt,
    dependsOn: ["electron.process"],
    recovery: null,
    facts: [],
    navigation: null,
  };
}

function isNotificationInput(value: unknown): value is {
  capabilityId: RuntimeStatusCapabilityId;
  title: string;
  body: string;
} {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const safeText = (text: unknown, max: number) =>
    typeof text === "string" &&
    text.trim().length > 0 &&
    text.length <= max &&
    !text.includes("://") &&
    !text.startsWith("/");
  return (
    Object.keys(candidate).every((key) =>
      ["capabilityId", "title", "body"].includes(key),
    ) &&
    isRuntimeStatusCapabilityId(candidate.capabilityId) &&
    safeText(candidate.title, 160) &&
    safeText(candidate.body, 512)
  );
}
