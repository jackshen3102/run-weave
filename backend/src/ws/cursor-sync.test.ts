import { describe, expect, it, vi } from "vitest";
import { createCursorSyncController } from "./cursor-sync";
import * as cursorModule from "./cursor";

describe("createCursorSyncController", () => {
  it("resolves cursor and emits value", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(cursorModule, "resolveCursorAtPoint").mockResolvedValue("pointer");
      const state = {
        cdpSession: {},
        cursorLookupInFlight: false,
        pendingCursorPoint: null,
        lastCursorLookupAt: 0,
        cursorLookupTimer: null,
      } as never;
      const emitCursor = vi.fn();

      const controller = createCursorSyncController({
        state,
        cursorSyncIntervalMs: 50,
        emitCursor,
      });

      controller.scheduleLookup(11, 22);
      vi.runAllTimers();
      await Promise.resolve();

      expect(emitCursor).toHaveBeenCalledWith("pointer");
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
