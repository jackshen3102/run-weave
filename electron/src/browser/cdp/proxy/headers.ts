import { normalizeTerminalBrowserHeaderRules } from "@runweave/shared/terminal-browser-headers";
import {
  getTerminalBrowserHeaderState,
  setTerminalBrowserHeaderRules,
} from "../../security/network.js";
import type { CdpProxyConnectionState } from "./types.js";
import { canUseTarget, sendJson } from "./utils.js";

/** Header rules belong to the connection's Profile, including its other Groups. */
export function handleHeaderCommand(
  conn: CdpProxyConnectionState,
  id: number,
  method: string,
  params: Record<string, unknown>,
  sessionId?: string,
): boolean {
  if (
    method !== "Runweave.getHeaderRules" &&
    method !== "Runweave.updateHeaderRule"
  )
    return false;
  const envelope = { id, ...(sessionId ? { sessionId } : {}) };
  const fail = (code: number, message: string) =>
    sendJson(conn.ws, { ...envelope, error: { code, message } });
  if (sessionId && !conn.browserSessionIds.has(sessionId)) {
    const targetId = conn.sessionManager.getTargetIdForSession(sessionId);
    if (!targetId || !canUseTarget(conn, targetId)) {
      fail(-32602, "Target is outside this Profile/Group or closed");
      return true;
    }
  }
  const writing = method === "Runweave.updateHeaderRule";
  const allowed = writing
    ? [
        "operation",
        "expectedRevision",
        params.operation === "set" ? "rule" : "id",
      ]
    : [];
  if (
    Object.keys(params).some((key) => !allowed.includes(key)) ||
    (writing &&
      (typeof params.expectedRevision !== "string" ||
        !params.expectedRevision ||
        (params.operation !== "set" && params.operation !== "remove") ||
        (params.operation === "remove" &&
          (typeof params.id !== "string" || !params.id.trim()))))
  ) {
    fail(
      -32602,
      "Expected set with rule, or remove with id, and expectedRevision; get takes no parameters",
    );
    return true;
  }
  try {
    let state = getTerminalBrowserHeaderState(conn.scopedProfileId);
    if (writing) {
      let rule;
      try {
        if (params.operation === "set")
          [rule] = normalizeTerminalBrowserHeaderRules([params.rule]);
      } catch (error) {
        fail(
          -32602,
          error instanceof Error ? error.message : "Invalid header rule",
        );
        return true;
      }
      const rules = [...state.rules];
      const ruleId = rule?.id ?? params.id;
      const index = rules.findIndex((candidate) => candidate.id === ruleId);
      if (rule) {
        if (index < 0) rules.push(rule);
        else rules[index] = rule;
      } else if (index >= 0) rules.splice(index, 1);
      state = setTerminalBrowserHeaderRules(
        conn.scopedProfileId,
        rules,
        params.expectedRevision as string,
      );
    }
    sendJson(conn.ws, {
      ...envelope,
      result: {
        ...state,
        profileId: conn.scopedProfileId,
        scope: "profile",
        appliesTo: "future-requests",
      },
    });
  } catch (error) {
    fail(
      -32000,
      error instanceof Error ? error.message : "Header operation failed",
    );
  }
  return true;
}
