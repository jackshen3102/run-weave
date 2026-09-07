import { useMemoizedFn } from "ahooks";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  aggregateRuntimeStatusState,
  type RuntimeStatusCapabilityId,
  type RuntimeStatusItem,
  type RuntimeStatusReport,
} from "@runweave/shared/runtime-status";
import { RuntimeStatusNotice } from "../../components/runtime-status-notice";
import { RuntimeStatusPanel } from "../../components/runtime-status-panel";
import { getConnectionAuth } from "../auth/storage";
import { LOCAL_DEV_CONNECTION_ID } from "../connection/system-connection";
import type { ConnectionConfig } from "../connection/types";
import {
  fetchBackendHealth,
  fetchBackendRuntimeStatus,
} from "../../services/runtime-status";
import { buildRuntimeStatusNodes, type RuntimeStatusEndpointResult } from "./registry";
import { RuntimeStatusContext } from "./use-runtime-status";

const ACTIVE_POLL_INTERVAL_MS = 5_000;
const BACKGROUND_POLL_INTERVAL_MS = 15_000;

interface RuntimeStatusProviderProps {
  apiBase: string;
  token: string | null;
  connections: ConnectionConfig[];
  isElectron: boolean;
  children: ReactNode;
}

interface EndpointSpec {
  endpointKey: string;
  apiBase: string;
  address: string;
  roles: RuntimeStatusEndpointResult["roles"];
  token: string | null;
}

function normalizeAddress(apiBase: string): string {
  const candidate = apiBase || window.location.origin;
  try {
    const url = new URL(candidate, window.location.origin);
    return url.origin;
  } catch {
    return candidate.replace(/\/+$/u, "");
  }
}

function mergeEndpointSpec(
  byAddress: Map<string, EndpointSpec>,
  input: Omit<EndpointSpec, "endpointKey">,
): void {
  const endpointKey = normalizeAddress(input.apiBase);
  const existing = byAddress.get(endpointKey);
  if (!existing) {
    byAddress.set(endpointKey, { ...input, endpointKey });
    return;
  }
  byAddress.set(endpointKey, {
    ...existing,
    roles: Array.from(new Set([...existing.roles, ...input.roles])),
    token: input.roles.includes("current") ? input.token : existing.token,
  });
}

function createElectronFallbackReport(
  state: "unsupported" | "unhealthy",
  summary: string,
): RuntimeStatusReport {
  const now = Date.now();
  return {
    protocolVersion: 1,
    target: { kind: "local-host" },
    source: {
      id: "electron",
      runtime: "electron",
      instanceId: "electron:renderer-bridge",
      capabilityId: "desktop",
    },
    observedAt: now,
    validForMs: 15_000,
    items: [
      {
        id: "electron.process",
        capabilityId: "desktop",
        label: "Electron process",
        state,
        summary,
        observedAt: now,
        dependsOn: [],
        recovery: null,
        facts: [],
        navigation: null,
      },
    ],
  };
}

export function RuntimeStatusProvider({
  apiBase,
  token,
  connections,
  isElectron,
  children,
}: RuntimeStatusProviderProps) {
  const [endpointResults, setEndpointResults] = useState<
    RuntimeStatusEndpointResult[]
  >([]);
  const [electronReport, setElectronReport] =
    useState<RuntimeStatusReport | null>(null);
  const [frontendItems, setFrontendItems] = useState<
    Map<string, RuntimeStatusItem>
  >(new Map());
  const [refreshing, setRefreshing] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const endpointResultsRef = useRef(endpointResults);
  const inFlightRef = useRef<Promise<void> | null>(null);
  endpointResultsRef.current = endpointResults;

  const endpointSpecs = useMemo(() => {
    const byAddress = new Map<string, EndpointSpec>();
    if (isElectron) {
      const localConnection = connections.find(
        (connection) => connection.id === LOCAL_DEV_CONNECTION_ID,
      );
      if (localConnection?.url) {
        const auth = getConnectionAuth(localConnection.id);
        mergeEndpointSpec(byAddress, {
          apiBase: localConnection.url,
          address: normalizeAddress(localConnection.url),
          roles: ["local"],
          token: auth?.accessToken ?? auth?.token ?? null,
        });
      }
    }
    if (apiBase || !isElectron) {
      mergeEndpointSpec(byAddress, {
        apiBase,
        address: normalizeAddress(apiBase),
        roles: ["current"],
        token,
      });
    }
    return [...byAddress.values()];
  }, [apiBase, connections, isElectron, token]);

  const refresh = useMemoizedFn((): Promise<void> => {
    if (inFlightRef.current) return inFlightRef.current;
    setRefreshing(true);
    const operation = (async () => {
      const previous = new Map(
        endpointResultsRef.current.map((entry) => [entry.endpointKey, entry]),
      );
      const nextEndpoints = await Promise.all(
        endpointSpecs.map(async (spec): Promise<RuntimeStatusEndpointResult> => {
          const before = previous.get(spec.endpointKey);
          const [health, status] = await Promise.all([
            fetchBackendHealth(spec.apiBase),
            spec.token
              ? fetchBackendRuntimeStatus(spec.apiBase, spec.token)
              : Promise.resolve({ kind: "missing-auth" } as const),
          ]);
          const now = Date.now();
          const failed = health.kind !== "ok";
          return {
            ...spec,
            health,
            status,
            lastSnapshot:
              status.kind === "ok" ? status.snapshot : (before?.lastSnapshot ?? null),
            failureSince: failed ? (before?.failureSince ?? now) : null,
            failureCount: failed ? (before?.failureCount ?? 0) + 1 : 0,
            observedAt: now,
          };
        }),
      );
      let nextElectronReport: RuntimeStatusReport | null = null;
      if (isElectron) {
        const getReport = window.electronAPI?.getRuntimeStatusReport;
        if (!getReport) {
          nextElectronReport = createElectronFallbackReport(
            "unsupported",
            "当前 Desktop 版本不支持运行状态协议",
          );
        } else {
          try {
            nextElectronReport = await getReport();
          } catch {
            nextElectronReport = createElectronFallbackReport(
              "unhealthy",
              "Electron 状态桥接不可用",
            );
          }
        }
      }
      setEndpointResults(nextEndpoints);
      setElectronReport(nextElectronReport);
    })();
    inFlightRef.current = operation.finally(() => {
      inFlightRef.current = null;
      setRefreshing(false);
    });
    return inFlightRef.current;
  });

  useEffect(() => {
    let disposed = false;
    let timer: number | null = null;
    const schedule = async (): Promise<void> => {
      await refresh();
      if (disposed) return;
      timer = window.setTimeout(
        () => void schedule(),
        document.hidden
          ? BACKGROUND_POLL_INTERVAL_MS
          : ACTIVE_POLL_INTERVAL_MS,
      );
    };
    const handleVisibilityChange = (): void => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      void schedule();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    void schedule();
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [endpointSpecs, refresh]);

  const setFrontendItem = useMemoizedFn(
    (item: RuntimeStatusItem | null, id: string): void => {
      setFrontendItems((current) => {
        const existing = current.get(id);
        if (item === existing || (!item && !existing)) return current;
        const next = new Map(current);
        if (item) next.set(id, item);
        else next.delete(id);
        return next;
      });
    },
  );

  const nodes = useMemo(
    () =>
      buildRuntimeStatusNodes({
        endpoints: endpointResults,
        electronReport,
        frontendItems: [...frontendItems.values()],
      }),
    [electronReport, endpointResults, frontendItems],
  );
  const currentNode = nodes.find((node) => node.roles.includes("current"));
  const currentAddress =
    currentNode?.address ?? normalizeAddress(apiBase || window.location.origin);
  const unhealthyCapabilityIds = Array.from(
    new Set(
      nodes.flatMap((node) =>
        node.capabilities
          .filter((capability) => capability.unhealthy)
          .map((capability) => capability.capabilityId),
      ),
    ),
  ) as RuntimeStatusCapabilityId[];
  const overallState = aggregateRuntimeStatusState(
    nodes.length > 0 ? nodes.map((node) => node.state) : ["checking"],
  );
  const value = useMemo(
    () => ({
      nodes,
      currentAddress,
      overallState,
      unhealthyCapabilityIds,
      refreshing,
      panelOpen,
      setPanelOpen,
      refresh,
      setFrontendItem,
    }),
    [
      currentAddress,
      nodes,
      overallState,
      panelOpen,
      refresh,
      refreshing,
      setFrontendItem,
      unhealthyCapabilityIds,
    ],
  );

  return (
    <RuntimeStatusContext.Provider value={value}>
      {children}
      <RuntimeStatusPanel />
      <RuntimeStatusNotice />
    </RuntimeStatusContext.Provider>
  );
}
