import { createHash, randomUUID } from "node:crypto";
import type { TerminalBrowserAutomationActor } from "@runweave/shared/terminal-browser-automation";
import type { TerminalBrowserProfileId } from "@runweave/shared/terminal-browser-profile";
import { TerminalBrowserError } from "../errors.js";

const TOKEN_TTL_MS = 5 * 60_000;
const TERMINAL_SESSION_ID_MAX_LENGTH = 512;

interface AttributionTokenRecord {
  terminalSessionId: string;
  profileId: TerminalBrowserProfileId;
  browserGroupId: string;
  expiresAt: number;
}

interface TerminalBinding {
  profileId: TerminalBrowserProfileId;
  connectionCount: number;
}

const tokens = new Map<string, AttributionTokenRecord>();
const terminalBindings = new Map<string, TerminalBinding>();

export function normalizeAutomationTerminalSessionId(
  value: unknown,
): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length > TERMINAL_SESSION_ID_MAX_LENGTH ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    throw new TerminalBrowserError(
      "INVALID_TERMINAL_SESSION_ID",
      "Invalid Terminal session identity",
    );
  }
  return value;
}

export function deriveAutomationBrowserGroupId(
  terminalSessionId: string,
): string {
  const digest = createHash("sha256")
    .update(terminalSessionId)
    .digest("hex")
    .slice(0, 16);
  return `browser-group-terminal-${digest}`;
}

export function assertAutomationProfileAvailable(
  terminalSessionId: string,
  requestedProfileId: TerminalBrowserProfileId,
): void {
  const binding = terminalBindings.get(terminalSessionId);
  if (!binding || binding.profileId === requestedProfileId) {
    return;
  }
  throw new TerminalBrowserError(
    "AUTOMATION_PROFILE_CONFLICT",
    "Terminal already has active browser automation on another Profile",
    {
      currentProfileId: binding.profileId,
      requestedProfileId,
    },
  );
}

export function mintAutomationAttributionToken(input: {
  terminalSessionId: string;
  profileId: TerminalBrowserProfileId;
  browserGroupId: string;
}): string {
  pruneExpiredTokens();
  const token = randomUUID();
  tokens.set(token, { ...input, expiresAt: Date.now() + TOKEN_TTL_MS });
  return token;
}

export function acceptAutomationAttribution(input: {
  token: string | null;
  connectionId: string;
  profileId: TerminalBrowserProfileId;
  browserGroupId: string | null;
}): TerminalBrowserAutomationActor {
  pruneExpiredTokens();
  const record = input.token ? tokens.get(input.token) : undefined;
  if (input.token) {
    tokens.delete(input.token);
  }
  if (
    !record ||
    record.profileId !== input.profileId ||
    record.browserGroupId !== input.browserGroupId
  ) {
    return { kind: "unattributed", connectionId: input.connectionId };
  }

  assertAutomationProfileAvailable(record.terminalSessionId, input.profileId);
  const binding = terminalBindings.get(record.terminalSessionId);
  terminalBindings.set(record.terminalSessionId, {
    profileId: input.profileId,
    connectionCount: (binding?.connectionCount ?? 0) + 1,
  });
  return { kind: "terminal", terminalSessionId: record.terminalSessionId };
}

export function releaseAutomationAttribution(
  actor: TerminalBrowserAutomationActor,
): void {
  if (actor.kind !== "terminal") {
    return;
  }
  const binding = terminalBindings.get(actor.terminalSessionId);
  if (!binding || binding.connectionCount <= 1) {
    terminalBindings.delete(actor.terminalSessionId);
    return;
  }
  binding.connectionCount -= 1;
}

function pruneExpiredTokens(): void {
  const now = Date.now();
  for (const [token, record] of tokens) {
    if (record.expiresAt <= now) {
      tokens.delete(token);
    }
  }
}
