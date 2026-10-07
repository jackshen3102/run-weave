import type { TerminalAgentKind } from "@runweave/shared/terminal/state";
import { getExecutableCommandName } from "../completion/source-gate";
import type {
  TerminalPanelRecord,
  TerminalSessionManager,
  TerminalSessionRecord,
} from "../manager/manager";

/** Persist the Agent identified by an accepted startup hook behind a Node wrapper. */
export async function persistNodeWrapperAgentIdentity(
  manager: TerminalSessionManager,
  session: TerminalSessionRecord,
  panel: TerminalPanelRecord | null | undefined,
  agent: TerminalAgentKind,
  activeCommand: string | null,
  reportedCommand: string | null,
) {
  // Node wrappers otherwise erase the Agent identity on the next pane poll.
  // An accepted startup hook identifies the wrapper before its first reply.
  if (getExecutableCommandName(activeCommand) !== "node" ||
    getExecutableCommandName(reportedCommand) !== "node") return;
  if (panel) {
    await manager.upsertPanel({ ...panel, activeCommand: agent });
  }
  await manager.updateSessionMetadata(session.id, {
    cwd: session.cwd,
    activeCommand: agent,
  });
}
