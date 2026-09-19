import type { TerminalSessionManager } from "../terminal/manager/manager";
import { TerminalSnapshotShareService } from "../terminal/snapshot-share/service";
import { TerminalSnapshotShareStore } from "../terminal/snapshot-share/store";
import type { TmuxService } from "../terminal/tmux/service";
import type { ResourceScope } from "./resource-scope";

export async function createTerminalSnapshotShares(
  resources: ResourceScope,
  directory: string,
  sessions: TerminalSessionManager,
  tmuxService: TmuxService,
): Promise<TerminalSnapshotShareService> {
  const service = new TerminalSnapshotShareService(
    new TerminalSnapshotShareStore(directory), sessions, tmuxService,
  );
  resources.defer("terminal-snapshot-shares", () => service.dispose());
  await service.initialize();
  return service;
}
