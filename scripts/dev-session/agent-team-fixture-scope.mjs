import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { DevSessionError, assertPathInside } from "./contracts.mjs";

const AGENT_TEAM_RUN_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export async function resolveAgentTeamFixtureScope({
  sourceRoot,
  sessionId,
  env = process.env,
}) {
  const resolvedOwner = await resolveOwnerRun(sourceRoot, env);
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
    run?.activeWorkerRole !== "behavior_verify" ||
    dispatch?.role !== "behavior_verify" ||
    typeof dispatch.dispatchId !== "string" ||
    !dispatch.dispatchId.trim() ||
    (panelIdentityPresent && !dispatchMatchesPane(dispatch, env))
  ) {
    throw new DevSessionError(
      "Dev Session fixture owner must be the active behavior_verify dispatch",
      5,
      { ownerRunId, runPath },
    );
  }
  const dispatchCases = Array.isArray(run.acceptance)
    ? run.acceptance.filter(
        (item) => item?.recheckDispatchId === dispatch.dispatchId,
      )
    : [];
  const fallbackCases = Array.isArray(run.acceptance)
    ? run.acceptance.filter(
        (item) =>
          typeof item?.caseId === "string" &&
          !/code review|代码审查|code_review/i.test(String(item?.text ?? "")),
      )
    : [];
  const ownerCaseIds = Array.from(
    new Set(
      (dispatchCases.length > 0 ? dispatchCases : fallbackCases)
        .map((item) =>
          typeof item?.caseId === "string" ? item.caseId.trim() : "",
        )
        .filter(Boolean),
    ),
  );
  if (ownerCaseIds.length === 0) {
    throw new DevSessionError(
      "Active behavior_verify dispatch has no traceable product cases",
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

async function resolveOwnerRun(sourceRoot, env) {
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
        run?.activeWorkerRole === "behavior_verify" &&
        run?.activeWorkerDispatch?.role === "behavior_verify" &&
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
      "Multiple active behavior_verify Runs claim the current pane",
      5,
      { ownerRunIds: matches.map((item) => item.ownerRunId) },
    );
  }
  return matches[0] ?? null;
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
