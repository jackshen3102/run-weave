import type { TerminalSessionManager } from "../terminal/manager/manager";
import { TerminalSnapshotShareService } from "../terminal/snapshot-share/service";
import type { TmuxService } from "../terminal/tmux/service";
import type { ResourceScope } from "./resource-scope";
import { createTerminalSnapshotPublisher } from "../terminal/snapshot-share/publisher";
import { configuration } from "@runweave/config-node";

export function createTerminalSnapshotShares(
  resources: ResourceScope,
  sessions: TerminalSessionManager,
  tmuxService: TmuxService,
): TerminalSnapshotShareService {
  let publisher;
  try { publisher = createTerminalSnapshotPublisher(); }
  catch { configuration().reportError("services.snapshotPublisher"); }
  const service = new TerminalSnapshotShareService(sessions, tmuxService, publisher);
  const unregister = configuration().register("services.snapshotPublisher", (snapshot) => {
    service.replacePublisher(createTerminalSnapshotPublisher(snapshot));
  });
  resources.defer("snapshot-configuration", unregister);
  resources.defer("terminal-snapshot-shares", () => service.dispose());
  return service;
}
