import net from "node:net";
import type { WorkspaceServiceStatus } from "@runweave/shared/terminal/workspace-service";
import type { OwnedWorkspaceServiceExit } from "./owned-process";
import type { WorkspaceServiceRecord } from "./manager-types";

export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async acquire(key: string): Promise<() => void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let releaseGate = (): void => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const tail = previous.catch(() => {}).then(() => gate);
    this.tails.set(key, tail);
    await previous.catch(() => {});

    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseGate();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    };
  }
}

export async function allocateEphemeralPort(host: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate workspace service port"));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

export function statusHasLiveProcess(
  status: WorkspaceServiceStatus,
): boolean {
  return status === "starting" || status === "ready" || status === "stopping";
}

export function exitDescription(exit: OwnedWorkspaceServiceExit): string {
  if (exit.error) return "Workspace service process could not be started";
  return `Workspace service exited (${exit.code ?? exit.signal ?? "unknown"})`;
}

export function forgetWorkspaceServiceContexts(
  records: Map<string, WorkspaceServiceRecord>,
  hostnameToKey: Map<string, string>,
  projectIds: string[],
): void {
  const targets = new Set(projectIds);
  for (const [key, record] of records) {
    if (!targets.has(record.projectId)) continue;
    if (statusHasLiveProcess(record.status)) {
      throw new Error("Cannot forget a Context with an active Workspace Service");
    }
    records.delete(key);
    for (const [hostname, mappedKey] of hostnameToKey) {
      if (mappedKey === key) hostnameToKey.delete(hostname);
    }
  }
}
