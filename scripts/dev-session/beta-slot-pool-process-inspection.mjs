import os from "node:os";
import path from "node:path";

import { resolveBetaUpdateTargets } from "../runweave-update-core.mjs";
import {
  inspectProcessReferences,
  inspectRecordedProcessState,
} from "../runweave-beta-state.mjs";

export async function inspectBetaSlotProcessSafety(
  slotId,
  homeDir = os.homedir(),
) {
  const targets = resolveBetaUpdateTargets(homeDir, slotId);
  const [desktop, backend, appServer, references] = await Promise.all([
    inspectRecordedProcessState(
      path.join(targets.userData, "beta-desktop-status.json"),
      ["app", "pid"],
    ),
    inspectRecordedProcessState(
      path.join(targets.userData, "browser-profile", "backend.lock.json"),
      ["pid"],
    ),
    inspectRecordedProcessState(
      path.join(targets.appServerHome, "app-server.lock.json"),
      ["pid"],
    ),
    inspectProcessReferences([
      targets.appPath,
      targets.instanceRoot,
      targets.userData,
      targets.appServerHome,
    ]),
  ]);
  const recorded = { desktop, backend, appServer };
  const unknown = Object.entries(recorded)
    .filter(([, entry]) => entry.exists && !entry.trusted)
    .map(([name]) => `${name}-record-unknown`);
  if (!references.trusted) {
    unknown.push("process-references-unknown");
  }
  const active = Object.entries(recorded)
    .filter(([, entry]) => entry.trusted && entry.active)
    .map(([name]) => name);
  if (references.active) {
    active.push("path-reference");
  }
  return {
    safeToReset: unknown.length === 0 && active.length === 0,
    recorded,
    references,
    active,
    unknown,
  };
}

export async function betaSlotProcessesAreAbsent(
  slotId,
  homeDir = os.homedir(),
) {
  return (await inspectBetaSlotProcessSafety(slotId, homeDir)).safeToReset;
}
