import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { DevSessionError, assertPathInside } from "./contracts.mjs";

const AGENT_TEAM_RUN_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export async function resolveAgentTeamFixtureScope({
  sourceRoot,
  sessionId,
  env = process.env,
}) {
  const resolvedOwner = await resolveOwnerRun(sourceRoot, sessionId, env);
  if (!resolvedOwner) {
    return null;
  }
  const { ownerRunId, runPath, run } = resolvedOwner;
  const panelIdentityPresent = Boolean(
    env.RUNWEAVE_TERMINAL_PANEL_ID?.trim() || env.TMUX_PANE?.trim(),
  );
  if (!AGENT_TEAM_RUN_ID_PATTERN.test(ownerRunId)) {
    throw new DevSessionError("invalid Agent Team owner Run id", 4, {
      ownerRunId,
    });
  }
  const dispatch = run?.activeWorkerDispatch;
  if (
    run?.runId !== ownerRunId ||
    run?.phase !== "executing" ||
    run?.status !== "running" ||
    run?.activeWorkerRole !== dispatch?.role ||
    typeof dispatch.dispatchId !== "string" ||
    !dispatch.dispatchId.trim() ||
    (panelIdentityPresent && !dispatchMatchesPane(dispatch, env))
  ) {
    throw new DevSessionError(
      "Dev Session fixture owner must be the active behavior_verify or runtime code repair dispatch",
      5,
      { ownerRunId, runPath },
    );
  }
  const ownerCaseIds = resolveDispatchOwnerCaseIds(run, sessionId);
  if (ownerCaseIds.length === 0) {
    throw new DevSessionError(
      "Active fixture dispatch has no traceable product cases for this Dev Session",
      5,
      { ownerRunId, ownerDispatchId: dispatch.dispatchId },
    );
  }
  return {
    ownerRunId,
    ownerDispatchId: dispatch.dispatchId,
    ownerCaseIds,
    ownerDevSessionId: sessionId,
    fixtureNamespace: `agent-team:${ownerRunId}:${dispatch.dispatchId}:${sessionId}`,
  };
}

async function resolveOwnerRun(sourceRoot, sessionId, env) {
  const explicitOwnerRunId =
    env.RUNWEAVE_AGENT_TEAM_RUN_ID?.trim() || null;
  if (explicitOwnerRunId) {
    if (!AGENT_TEAM_RUN_ID_PATTERN.test(explicitOwnerRunId)) {
      throw new DevSessionError("invalid Agent Team owner Run id", 4, {
        ownerRunId: explicitOwnerRunId,
      });
    }
    const runPath = ownerRunPath(sourceRoot, explicitOwnerRunId);
    try {
      return {
        ownerRunId: explicitOwnerRunId,
        runPath,
        run: JSON.parse(await readFile(runPath, "utf8")),
      };
    } catch (error) {
      throw new DevSessionError(
        `Agent Team owner Run is unreadable: ${explicitOwnerRunId}`,
        4,
        {
          runPath,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  if (
    !env.RUNWEAVE_TERMINAL_PANEL_ID?.trim() &&
    !env.TMUX_PANE?.trim()
  ) {
    return null;
  }
  const runDir = assertPathInside(
    sourceRoot,
    path.join(sourceRoot, ".runweave", "agent-team"),
    "Agent Team Run directory",
  );
  let entries;
  try {
    entries = await readdir(runDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const matches = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const candidateRunId = entry.name.slice(0, -".json".length);
    if (!AGENT_TEAM_RUN_ID_PATTERN.test(candidateRunId)) continue;
    const runPath = ownerRunPath(sourceRoot, candidateRunId);
    try {
      const run = JSON.parse(await readFile(runPath, "utf8"));
      if (
        run?.runId === candidateRunId &&
        run?.phase === "executing" &&
        run?.status === "running" &&
        run?.activeWorkerRole === run?.activeWorkerDispatch?.role &&
        resolveDispatchOwnerCaseIds(run, sessionId).length > 0 &&
        dispatchMatchesPane(run.activeWorkerDispatch, env)
      ) {
        matches.push({ ownerRunId: candidateRunId, runPath, run });
      }
    } catch {
      // A malformed historical Run cannot establish pane ownership.
    }
  }
  if (matches.length > 1) {
    throw new DevSessionError(
      "Multiple active fixture Runs claim the current pane",
      5,
      { ownerRunIds: matches.map((item) => item.ownerRunId) },
    );
  }
  return matches[0] ?? null;
}

function resolveDispatchOwnerCaseIds(run, sessionId) {
  const dispatch = run?.activeWorkerDispatch;
  const acceptance = Array.isArray(run?.acceptance) ? run.acceptance : [];
  if (dispatch?.role === "behavior_verify") {
    const dispatchCases = acceptance.filter(
      (item) => item?.recheckDispatchId === dispatch.dispatchId,
    );
    const fallbackCases = acceptance.filter(isProductAcceptanceCase);
    return uniqueCaseIds(
      dispatchCases.length > 0 ? dispatchCases : fallbackCases,
    );
  }
  if (dispatch?.role !== "code") {
    return [];
  }
  const repairKeys = new Set(
    Array.isArray(dispatch.repairKeys) ? dispatch.repairKeys : [],
  );
  const acceptedCaseIds = new Set(
    acceptance
      .filter(isProductAcceptanceCase)
      .map((item) => item.caseId.trim()),
  );
  const repairCycles = Array.isArray(run?.loop?.repairCycles)
    ? run.loop.repairCycles
    : [];
  return Array.from(
    new Set(
      repairCycles
        .filter((cycle) => {
          const reproduction =
            cycle?.sourceReproduction ?? cycle?.finding?.reproduction;
          return (
            cycle?.verificationMode === "runtime" &&
            repairKeys.has(cycle.repairKey) &&
            reproduction?.mode === "real_product" &&
            reproduction?.status === "reproduced" &&
            reproduction?.validationSessionId === sessionId
          );
        })
        .flatMap((cycle) =>
          Array.isArray(cycle.caseIds) ? cycle.caseIds : [],
        )
        .map((caseId) => (typeof caseId === "string" ? caseId.trim() : ""))
        .filter((caseId) => caseId && acceptedCaseIds.has(caseId)),
    ),
  );
}

function uniqueCaseIds(cases) {
  return Array.from(
    new Set(
      cases
        .map((item) =>
          typeof item?.caseId === "string" ? item.caseId.trim() : "",
        )
        .filter(Boolean),
    ),
  );
}

function isProductAcceptanceCase(item) {
  return (
    typeof item?.caseId === "string" &&
    !/code review|代码审查|code_review/i.test(String(item?.text ?? ""))
  );
}

function ownerRunPath(sourceRoot, ownerRunId) {
  return assertPathInside(
    sourceRoot,
    path.join(sourceRoot, ".runweave", "agent-team", `${ownerRunId}.json`),
    "Agent Team owner Run path",
  );
}

function dispatchMatchesPane(dispatch, env) {
  const expectedPanelId = env.RUNWEAVE_TERMINAL_PANEL_ID?.trim() || null;
  const expectedTmuxPaneId = env.TMUX_PANE?.trim() || null;
  return (
    (!expectedPanelId || dispatch?.panelId === expectedPanelId) &&
    (!expectedTmuxPaneId || dispatch?.tmuxPaneId === expectedTmuxPaneId) &&
    Boolean(expectedPanelId || expectedTmuxPaneId)
  );
}

export function buildAgentTeamFixtureEnvironment(
  fixtureScope,
  { ownsTerminalSession },
) {
  if (!fixtureScope) {
    return {};
  }
  return {
    RUNWEAVE_AGENT_TEAM_OWNER_RUN_ID: fixtureScope.ownerRunId,
    RUNWEAVE_AGENT_TEAM_OWNER_DISPATCH_ID: fixtureScope.ownerDispatchId,
    RUNWEAVE_AGENT_TEAM_OWNER_CASE_IDS: JSON.stringify(
      fixtureScope.ownerCaseIds,
    ),
    RUNWEAVE_AGENT_TEAM_OWNER_DEV_SESSION_ID: fixtureScope.ownerDevSessionId,
    RUNWEAVE_AGENT_TEAM_FIXTURE_NAMESPACE: fixtureScope.fixtureNamespace,
    RUNWEAVE_AGENT_TEAM_FIXTURE_OWNS_TERMINAL_SESSION: ownsTerminalSession
      ? "true"
      : "false",
  };
}
