import type {
  SupervisionDiscovery,
  SupervisionTarget,
  TaskWatch,
} from "@runweave/shared/task-supervision";
import type { TerminalSessionManager } from "../terminal/manager/manager";
import { resolveSupervisionTarget } from "./target";
import { readCodexThreadSnapshot } from "../terminal/runtime/codex-thread-snapshot";
import { getTerminalSessionAgent } from "../terminal/state/terminal-state-service";
import { terminalInputAdmission } from "../terminal/runtime/input-admission";
import { sameTarget } from "./synchronization";

/** Discovery polls only live identity and bounded state, never native conversation/history bodies. */
export async function discoverSupervision(
  manager: TerminalSessionManager,
  terminalSessionId: string,
  panelId: string | null | undefined,
  readWatch: () => TaskWatch | null,
  synchronize: (watchId: string, target: SupervisionTarget) => Promise<unknown>,
): Promise<SupervisionDiscovery> {
  let watch = readWatch();
  let target: SupervisionTarget;
  try {
    target = resolveSupervisionTarget(
      manager,
      terminalSessionId,
      panelId,
    ).target;
  } catch (error) {
    return structuredClone({
      target: null,
      watch,
      capability: { supported: false, reason: (error as Error).message },
      taskCandidates: [],
    });
  }
  if (watch) await synchronize(watch.watchId, target);
  const panel = manager.getPanel(target.panelId);
  const threadTitle =
    watch?.enabled &&
    target.threadId &&
    panel &&
    getTerminalSessionAgent(panel) === "codex"
      ? await readCodexThreadSnapshot(target.threadId)
          .then((snapshot) => snapshot.name)
          .catch(() => null)
      : null;
  watch = readWatch();
  const session = manager.getSession(terminalSessionId);
  let current = false;
  try {
    current = sameTarget(
      resolveSupervisionTarget(manager, terminalSessionId, panelId).target,
      target,
    );
  } catch {
    /* Exited while awaiting title. */
  }
  return structuredClone({
    target,
    watch,
    threadTitle:
      watch?.enabled && sameTarget(watch.target, target) && current
        ? threadTitle
        : null,
    ...(session
      ? { inputVersion: terminalInputAdmission(session).inputVersion }
      : {}),
    capability: { supported: true },
    taskCandidates: [],
  });
}
