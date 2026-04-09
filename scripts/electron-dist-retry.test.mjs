import assert from "node:assert/strict";
import test from "node:test";

import {
  isRetriableHdiutilResizeBusyError,
  runWithRetries,
} from "./electron-dist-retry.mjs";

test("detects the localized hdiutil resize busy failure", () => {
  const output = `hdiutil: resize: failed. 资源暂时不可用 (35)
failedTask=build stackTrace=Error: Exit code: 35. Command failed: hdiutil resize -size 324992742.8 /private/var/folders/example/0.dmg`;

  assert.equal(isRetriableHdiutilResizeBusyError(output), true);
});

test("ignores unrelated hdiutil failures", () => {
  const output = `hdiutil: resize: failed. No space left on device (28)`;

  assert.equal(isRetriableHdiutilResizeBusyError(output), false);
});

test("retries retriable failures until success", async () => {
  const attempts = [];
  const waits = [];

  const result = await runWithRetries({
    maxAttempts: 3,
    waitMs: 250,
    shouldRetry: isRetriableHdiutilResizeBusyError,
    wait: async (delay) => {
      waits.push(delay);
    },
    run: async (attempt) => {
      attempts.push(attempt);
      if (attempt < 3) {
        return {
          ok: false,
          code: 35,
          combinedOutput:
            "hdiutil: resize: failed. Resource temporarily unavailable (35)",
        };
      }
      return {
        ok: true,
        code: 0,
        combinedOutput: "",
      };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.deepEqual(waits, [250, 250]);
});

test("does not retry non-retriable failures", async () => {
  const attempts = [];

  const result = await runWithRetries({
    maxAttempts: 3,
    waitMs: 250,
    shouldRetry: isRetriableHdiutilResizeBusyError,
    wait: async () => {},
    run: async (attempt) => {
      attempts.push(attempt);
      return {
        ok: false,
        code: 1,
        combinedOutput: "hdiutil: resize: failed. No space left on device (28)",
      };
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(attempts, [1]);
});
