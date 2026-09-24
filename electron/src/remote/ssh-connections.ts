import { ipcMain } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import net from "node:net";
import type {
  ConnectionRuntime,
  SshRemoteConnection,
} from "@runweave/shared/remote";
import { desktopRuntime } from "../desktop/runtime-state.js";
import { createRemoteBrowserGateway, type RemoteBrowserGateway } from "./browser-gateway.js";
import type { DesktopBrowserBinding } from "@runweave/shared/remote";
import type { RemoteCapabilities } from "@runweave/shared/remote";
import type { RemoteServiceRef, ResolvedServiceAccess } from "@runweave/shared/remote";
import type { ManualRemotePortAccess } from "@runweave/shared/remote";
import type { WorkspaceServiceListResponse } from "@runweave/shared/terminal/workspace-service";

interface ManagedConnection {
  config: SshRemoteConnection;
  runtime: ConnectionRuntime;
  process: ChildProcessWithoutNullStreams | null;
  retryTimer: NodeJS.Timeout | null;
  healthTimer: NodeJS.Timeout | null;
  healthChecking: boolean;
  stopped: boolean;
  failures: number;
  port: number | null;
  gateway: RemoteBrowserGateway | null;
  reverseProcess: ChildProcessWithoutNullStreams | null;
  reversePort: number | null;
  binding: DesktopBrowserBinding | null;
  bindingAuthToken: string | null;
  browserRetryTimer: NodeJS.Timeout | null;
  manualForwards: Map<number, { child: ChildProcessWithoutNullStreams; localPort: number }>;
}

const connections = new Map<string, ManagedConnection>();

function publish(connection: ManagedConnection): void {
  desktopRuntime.mainWindow?.webContents.send(
    "remote:connection-state",
    connection.runtime,
  );
}

function update(
  connection: ManagedConnection,
  patch: Partial<ConnectionRuntime>,
): void {
  connection.runtime = { ...connection.runtime, ...patch };
  publish(connection);
}

function validateConfig(value: unknown): SshRemoteConnection {
  if (!value || typeof value !== "object") throw new Error("Invalid SSH connection");
  const config = value as Partial<SshRemoteConnection>;
  if (
    typeof config.connectionId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(config.connectionId) ||
    typeof config.host !== "string" ||
    !/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]{0,254}$/.test(config.host) ||
    !Number.isInteger(config.backendPort) ||
    config.backendPort! < 1 ||
    config.backendPort! > 65535 ||
    (config.browserProfileId !== null && config.browserProfileId !== undefined &&
      !["profile-1", "profile-2", "profile-3"].includes(config.browserProfileId)) ||
    (config.approvedBrowserGroupId !== null && config.approvedBrowserGroupId !== undefined &&
      (typeof config.approvedBrowserGroupId !== "string" || !config.approvedBrowserGroupId ||
        config.approvedBrowserGroupId.length > 512 || config.approvedBrowserGroupId.trim() !== config.approvedBrowserGroupId))
  ) {
    throw new Error("Invalid SSH connection");
  }
  return config as SshRemoteConnection;
}

async function findRemotePort(host: string): Promise<number> {
  const command = "node -e 'const s=require(\"node:net\").createServer();s.listen(0,\"127.0.0.1\",()=>{console.log(s.address().port);s.close()})'";
  const child = spawn("ssh", ["-T", "-o", "StrictHostKeyChecking=yes", host, command]);
  let output = "";
  let error = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { error += chunk.toString("utf8"); });
  const code = await new Promise<number | null>((resolve) => {
    const timeout = setTimeout(() => { child.kill("SIGTERM"); resolve(null); }, 10_000);
    child.once("exit", (value) => { clearTimeout(timeout); resolve(value); });
    child.once("error", () => { clearTimeout(timeout); resolve(null); });
  });
  const port = Number(output.trim());
  if (code !== 0 || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(error.trim() || "Could not reserve remote Browser port");
  }
  return port;
}

async function findFreePort(): Promise<number> {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a local port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function stopProcess(connection: ManagedConnection): void {
  if (connection.retryTimer) clearTimeout(connection.retryTimer);
  connection.retryTimer = null;
  if (connection.healthTimer) clearInterval(connection.healthTimer);
  connection.healthTimer = null;
  const child = connection.process;
  connection.process = null;
  child?.kill("SIGTERM");
  for (const forward of connection.manualForwards.values()) forward.child.kill("SIGTERM");
  connection.manualForwards.clear();
}

function monitorBackend(connection: ManagedConnection, child: ChildProcessWithoutNullStreams, port: number): void {
  connection.healthTimer = setInterval(() => {
    if (connection.healthChecking || connection.stopped || connection.process !== child) return;
    connection.healthChecking = true;
    void (async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) });
        if (!response.ok) throw new Error(`Backend health returned ${response.status}`);
        const payload = (await response.json()) as { serviceInstanceId?: unknown };
        if (connection.process !== child) return;
        const serviceInstanceId = typeof payload.serviceInstanceId === "string" ? payload.serviceInstanceId : null;
        if (connection.runtime.status !== "ready" || connection.runtime.serviceInstanceId !== serviceInstanceId) {
          await teardownBrowserBridge(connection);
          if (connection.process !== child) return;
          update(connection, {
            status: "ready", apiBase: `http://127.0.0.1:${port}`,
            serviceInstanceId, generation: connection.runtime.generation + 1,
            lastObservedAt: new Date().toISOString(), message: null,
          });
          void setupBrowserBridge(connection);
        }
      } catch {
        if (connection.process === child && connection.runtime.status === "ready") {
          await teardownBrowserBridge(connection);
          update(connection, { status: "reconnecting", apiBase: null, browserAvailable: false, message: "Remote Backend is unavailable" });
        }
      } finally {
        connection.healthChecking = false;
      }
    })();
  }, 5_000);
}

async function teardownBrowserBridge(connection: ManagedConnection): Promise<void> {
  if (connection.browserRetryTimer) clearTimeout(connection.browserRetryTimer);
  connection.browserRetryTimer = null;
  const binding = connection.binding;
  const token = connection.bindingAuthToken;
  const base = connection.runtime.apiBase;
  connection.binding = null;
  connection.bindingAuthToken = null;
  if (binding && token && base) {
    await fetch(`${base}/api/desktop-browser/bindings/${encodeURIComponent(binding.id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1_000),
    }).catch(() => {});
  }
  const reverse = connection.reverseProcess;
  connection.reverseProcess = null;
  connection.reversePort = null;
  reverse?.kill("SIGTERM");
  const gateway = connection.gateway;
  connection.gateway = null;
  await gateway?.close();
  update(connection, { browserAvailable: false });
}

async function setupBrowserBridge(connection: ManagedConnection): Promise<void> {
  await teardownBrowserBridge(connection);
  if (connection.stopped || connection.runtime.status !== "ready") return;
  const cdpEndpoint = desktopRuntime.cdpProxy?.endpoint;
  if (!cdpEndpoint) {
    update(connection, { browserAvailable: false, browserMessage: "Desktop Browser is not ready" });
    return;
  }
  try {
    const gateway = await createRemoteBrowserGateway({
      connectionId: connection.config.connectionId,
      generation: connection.runtime.generation,
      allowedProfileId: connection.config.browserProfileId ?? null,
      approvedBrowserGroupId: connection.config.approvedBrowserGroupId ?? null,
      cdpEndpoint,
    });
    connection.gateway = gateway;
    const remotePort = await findRemotePort(connection.config.host);
    if (connection.stopped || connection.runtime.status !== "ready") {
      await teardownBrowserBridge(connection);
      return;
    }
    const child = spawn("ssh", [
      "-N", "-T",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3",
      "-o", "StrictHostKeyChecking=yes",
      "-R", `127.0.0.1:${remotePort}:127.0.0.1:${gateway.port}`,
      connection.config.host,
    ], { stdio: "pipe" });
    connection.reverseProcess = child;
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-2048); });
    child.on("error", (error) => { stderr = error.message; });
    child.on("exit", () => {
      if (connection.stopped || connection.reverseProcess !== child) return;
      void teardownBrowserBridge(connection).then(() => {
        update(connection, { browserMessage: stderr.trim() || "Browser tunnel closed" });
        if (connection.runtime.status === "ready") {
          connection.browserRetryTimer = setTimeout(() => {
            void setupBrowserBridge(connection);
          }, 5_000);
        }
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    if (connection.reverseProcess !== child || child.exitCode !== null) {
      throw new Error(stderr.trim() || "Browser reverse forward failed");
    }
    connection.reversePort = remotePort;
    update(connection, { browserAvailable: true, browserMessage: null });
  } catch (error) {
    await teardownBrowserBridge(connection);
    update(connection, {
      browserMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

async function waitForHealth(
  connection: ManagedConnection,
  child: ChildProcessWithoutNullStreams,
  port: number,
): Promise<{ serviceInstanceId: string | null }> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (connection.stopped || connection.process !== child || child.exitCode !== null) {
      throw new Error("SSH connection closed");
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) {
        const body = (await response.json()) as { serviceInstanceId?: unknown };
        return {
          serviceInstanceId:
            typeof body.serviceInstanceId === "string"
              ? body.serviceInstanceId
              : null,
        };
      }
    } catch {
      // The SSH forward may be ready before the Backend accepts requests.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Remote Backend did not answer /health on the configured port");
}

async function connect(connection: ManagedConnection): Promise<ConnectionRuntime> {
  await teardownBrowserBridge(connection);
  stopProcess(connection);
  connection.stopped = false;
  update(connection, {
    status: connection.failures ? "reconnecting" : "connecting",
    message: null,
  });
  const port = await findFreePort();
  const child = spawn("ssh", [
    "-N", "-T",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", "StrictHostKeyChecking=yes",
    "-L", `127.0.0.1:${port}:127.0.0.1:${connection.config.backendPort}`,
    connection.config.host,
  ], { stdio: "pipe" });
  connection.process = child;
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-2048);
  });
  child.on("error", (error) => {
    stderr = error.message;
  });
  child.on("exit", () => {
    if (connection.stopped || connection.process !== child) return;
    stopProcess(connection);
    connection.process = null;
    connection.port = null;
    void teardownBrowserBridge(connection);
    connection.failures += 1;
    update(connection, {
      status: connection.failures >= 5 ? "failed" : "reconnecting",
      apiBase: null,
      browserAvailable: false,
      message: stderr.trim() || "SSH connection closed",
    });
    if (connection.failures < 5) {
      connection.retryTimer = setTimeout(() => {
        void connect(connection).catch(() => {});
      }, Math.min(1000 * 2 ** connection.failures, 15_000));
    }
  });
  try {
    const health = await waitForHealth(connection, child, port);
    connection.port = port;
    connection.failures = 0;
    update(connection, {
      generation: connection.runtime.generation + 1,
      serviceInstanceId: health.serviceInstanceId,
      apiBase: `http://127.0.0.1:${port}`,
      status: "ready",
      lastObservedAt: new Date().toISOString(),
      message: null,
    });
    monitorBackend(connection, child, port);
    void setupBrowserBridge(connection).catch((error: unknown) => {
      update(connection, { browserAvailable: false, browserMessage: String(error) });
    });
  } catch (error) {
    if (connection.process === child) {
      connection.process = null;
      child.kill("SIGTERM");
    }
    update(connection, {
      status: "failed",
      apiBase: null,
      message: error instanceof Error && error.message.startsWith("Remote Backend did not answer")
        ? error.message
        : stderr.trim().slice(-300) || (error instanceof Error ? error.message : String(error)),
    });
  }
  return connection.runtime;
}

async function stop(connectionId: string): Promise<void> {
  const connection = connections.get(connectionId);
  if (!connection) return;
  connection.stopped = true;
  await teardownBrowserBridge(connection);
  stopProcess(connection);
  update(connection, { status: "disconnected", apiBase: null, message: null });
  connections.delete(connectionId);
}

export async function stopRemoteConnections(): Promise<void> {
  await Promise.all([...connections.keys()].map((connectionId) => stop(connectionId)));
}

export function registerRemoteConnectionHandlers(): void {
  const requireMainWindow = (senderId: number): void => {
    if (desktopRuntime.mainWindow?.webContents.id !== senderId) {
      throw new Error("Main window sender required");
    }
  };
  ipcMain.handle("remote:connect", async (event, raw: unknown) => {
    requireMainWindow(event.sender.id);
    const config = validateConfig(raw);
    const existing = connections.get(config.connectionId);
    if (existing && existing.config.host === config.host &&
        existing.config.backendPort === config.backendPort &&
        existing.config.browserProfileId === config.browserProfileId &&
        (existing.config.approvedBrowserGroupId ?? null) === (config.approvedBrowserGroupId ?? null)) {
      return existing.runtime;
    }
    if (existing) await stop(config.connectionId);
    const connection: ManagedConnection = {
      config,
      runtime: {
        connectionId: config.connectionId,
        generation: 0,
        installationId: null,
        serviceInstanceId: null,
        apiBase: null,
        status: "disconnected",
        lastObservedAt: null,
        message: null,
        browserAvailable: false,
        browserMessage: null,
      },
      process: null,
      retryTimer: null,
      healthTimer: null,
      healthChecking: false,
      stopped: false,
      failures: 0,
      port: null,
      gateway: null,
      reverseProcess: null,
      reversePort: null,
      binding: null,
      bindingAuthToken: null,
      browserRetryTimer: null,
      manualForwards: new Map(),
    };
    connections.set(config.connectionId, connection);
    return connect(connection);
  });
  ipcMain.handle("remote:disconnect", async (event, connectionId: unknown) => {
    requireMainWindow(event.sender.id);
    if (typeof connectionId !== "string") throw new Error("Invalid connection ID");
    await stop(connectionId);
  });
  ipcMain.handle("remote:bind-browser", async (event, connectionId: unknown, token: unknown) => {
    requireMainWindow(event.sender.id);
    if (typeof connectionId !== "string" || typeof token !== "string" || token.length > 8192) {
      throw new Error("Invalid Browser binding request");
    }
    const connection = connections.get(connectionId);
    if (!connection?.runtime.apiBase || !connection.gateway || !connection.reversePort || !connection.runtime.browserAvailable) {
      throw new Error("DESKTOP_UNAVAILABLE: Browser bridge is not connected");
    }
    const response = await fetch(`${connection.runtime.apiBase}/api/desktop-browser/bindings`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        connectionId,
        generation: connection.runtime.generation,
        reversePort: connection.reversePort,
        gatewayKey: connection.gateway.key,
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Browser binding failed: HTTP ${response.status}`);
    const binding = (await response.json()) as DesktopBrowserBinding;
    connection.binding = binding;
    connection.bindingAuthToken = token;
    return binding;
  });
  ipcMain.handle("remote:inspect", async (event, connectionId: unknown, token: unknown) => {
    requireMainWindow(event.sender.id);
    if (typeof connectionId !== "string" || typeof token !== "string" || token.length > 8192) {
      throw new Error("Invalid remote inspection request");
    }
    const connection = connections.get(connectionId);
    if (!connection?.runtime.apiBase) throw new Error("Remote Backend is unavailable");
    const generation = connection.runtime.generation;
    const response = await fetch(`${connection.runtime.apiBase}/api/remote/capabilities`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Remote capability inspection failed: HTTP ${response.status}`);
    const capabilities = (await response.json()) as RemoteCapabilities;
    if (capabilities.protocolVersion !== 1 || typeof capabilities.installationId !== "string") {
      throw new Error("REMOTE_CAPABILITY_UNSUPPORTED: incompatible remote Backend");
    }
    const duplicate = [...connections.values()].find((other) =>
      other !== connection && other.runtime.status === "ready" &&
      other.runtime.installationId === capabilities.installationId,
    );
    if (duplicate) {
      await teardownBrowserBridge(connection);
      update(connection, {
        status: "incompatible",
        browserAvailable: false,
        message: `This Backend is already connected as ${duplicate.config.host}; reuse that connection for additional projects`,
      });
      throw new Error("REMOTE_DUPLICATE_INSTALLATION");
    }
    if (connection.runtime.generation === generation) {
      update(connection, {
        installationId: capabilities.installationId,
        agents: Array.isArray(capabilities.agents) ? capabilities.agents : undefined,
      });
    }
    return capabilities;
  });
  ipcMain.handle("remote:resolve-service", async (event, rawRef: unknown, token: unknown) => {
    requireMainWindow(event.sender.id);
    const ref = rawRef as Partial<RemoteServiceRef> | null;
    if (!ref || typeof ref.connectionId !== "string" ||
        typeof ref.parentProjectId !== "string" || !ref.parentProjectId ||
        typeof ref.projectId !== "string" || !ref.projectId ||
        typeof ref.serviceId !== "string" || !ref.serviceId ||
        typeof token !== "string" || token.length > 8192) {
      throw new Error("Invalid remote service reference");
    }
    const connection = connections.get(ref.connectionId);
    if (!connection?.runtime.apiBase || !connection.port || connection.runtime.status !== "ready") {
      throw new Error("Remote connection is unavailable");
    }
    const generation = connection.runtime.generation;
    const response = await fetch(
      `${connection.runtime.apiBase}/api/terminal/project/${encodeURIComponent(ref.parentProjectId)}/contexts/${encodeURIComponent(ref.projectId)}/services`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000) },
    );
    if (!response.ok) throw new Error(`Remote service lookup failed: HTTP ${response.status}`);
    const snapshot = (await response.json()) as WorkspaceServiceListResponse;
    if (snapshot.projectId !== ref.projectId || snapshot.parentProjectId !== ref.parentProjectId ||
        connection.runtime.generation !== generation) {
      throw new Error("Remote service snapshot changed");
    }
    const service = snapshot.services.find((item) => item.name === ref.serviceId);
    if (!service || service.status !== "ready") throw new Error("Remote service is not ready");
    const url = new URL(service.url);
    if (url.protocol !== "http:" || !url.hostname.endsWith(".localhost") ||
        !/^[a-z0-9.-]+\.localhost$/.test(url.hostname) ||
        Number(url.port) !== connection.config.backendPort ||
        url.username || url.password) {
      throw new Error("Remote service address is unsupported");
    }
    url.port = String(connection.port);
    return {
      ref: ref as RemoteServiceRef,
      desktopUrl: url.toString(),
      generation,
    } satisfies ResolvedServiceAccess;
  });
  ipcMain.handle("remote:forward-port", async (event, connectionId: unknown, remotePort: unknown) => {
    requireMainWindow(event.sender.id);
    if (typeof connectionId !== "string" || !Number.isInteger(remotePort) ||
        Number(remotePort) < 1 || Number(remotePort) > 65535) {
      throw new Error("Invalid remote port request");
    }
    const connection = connections.get(connectionId);
    if (!connection || connection.runtime.status !== "ready") throw new Error("Remote connection is unavailable");
    const port = Number(remotePort);
    const existing = connection.manualForwards.get(port);
    if (existing && existing.child.exitCode === null) {
      return {
        connectionId,
        remotePort: port,
        desktopUrl: `http://127.0.0.1:${existing.localPort}`,
        generation: connection.runtime.generation,
      } satisfies ManualRemotePortAccess;
    }
    const localPort = await findFreePort();
    const child = spawn("ssh", [
      "-N", "-T", "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
      "-o", "StrictHostKeyChecking=yes",
      "-L", `127.0.0.1:${localPort}:127.0.0.1:${port}`,
      connection.config.host,
    ], { stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-2048); });
    child.on("error", (error) => { stderr = error.message; });
    connection.manualForwards.set(port, { child, localPort });
    child.on("exit", () => {
      if (connection.manualForwards.get(port)?.child === child) connection.manualForwards.delete(port);
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    if (child.exitCode !== null || connection.manualForwards.get(port)?.child !== child) {
      throw new Error(stderr.trim() || "Remote port forward failed");
    }
    return {
      connectionId,
      remotePort: port,
      desktopUrl: `http://127.0.0.1:${localPort}`,
      generation: connection.runtime.generation,
    } satisfies ManualRemotePortAccess;
  });
  ipcMain.handle("remote:list", (event) => {
    requireMainWindow(event.sender.id);
    return [...connections.values()].map(({ runtime }) => runtime);
  });
}
