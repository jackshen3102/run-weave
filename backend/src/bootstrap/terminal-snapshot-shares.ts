import type { TerminalSessionManager } from "../terminal/manager/manager";
import { TerminalSnapshotShareService } from "../terminal/snapshot-share/service";
import type { TmuxService } from "../terminal/tmux/service";
import type { ResourceScope } from "./resource-scope";
import { createTerminalSnapshotPublisher } from "../terminal/snapshot-share/publisher";

export function createTerminalSnapshotShares(
  resources: ResourceScope,
  sessions: TerminalSessionManager,
  tmuxService: TmuxService,
): TerminalSnapshotShareService {
  const service = new TerminalSnapshotShareService(
    sessions, tmuxService, createTerminalSnapshotPublisher(process.env),
  );
  resources.defer("terminal-snapshot-shares", () => service.dispose());
  return service;
}
