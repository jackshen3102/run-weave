import { describe, expect, it } from "vitest";
import {
  MAX_CACHED_TERMINAL_SURFACES,
  resolveCachedTerminalSurfaceIds,
} from "./surface-cache";

describe("resolveCachedTerminalSurfaceIds", () => {
  it("keeps the active terminal as most recently used", () => {
    expect(
      resolveCachedTerminalSurfaceIds({
        activeSessionId: "terminal-2",
        cachedSessionIds: ["terminal-1"],
        sessionIds: ["terminal-1", "terminal-2", "terminal-3"],
      }),
    ).toEqual(["terminal-1", "terminal-2"]);
  });

  it("limits cached terminal surfaces to the five most recent sessions", () => {
    const sessionIds = [
      "terminal-1",
      "terminal-2",
      "terminal-3",
      "terminal-4",
      "terminal-5",
      "terminal-6",
    ];

    expect(
      resolveCachedTerminalSurfaceIds({
        activeSessionId: "terminal-6",
        cachedSessionIds: sessionIds.slice(0, 5),
        sessionIds,
      }),
    ).toEqual(sessionIds.slice(1, 6));
    expect(MAX_CACHED_TERMINAL_SURFACES).toBe(5);
  });

  it("drops cached terminals that no longer exist", () => {
    expect(
      resolveCachedTerminalSurfaceIds({
        activeSessionId: "terminal-3",
        cachedSessionIds: ["terminal-1", "terminal-2"],
        sessionIds: ["terminal-2", "terminal-3"],
      }),
    ).toEqual(["terminal-2", "terminal-3"]);
  });
});
