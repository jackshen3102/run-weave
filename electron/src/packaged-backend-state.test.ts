import assert from "node:assert/strict";
import test from "node:test";
import {
  createAvailablePackagedBackendState,
  createUnavailablePackagedBackendStateFromError,
  createUnavailablePackagedBackendStateFromExit,
} from "./packaged-backend-state.js";

test("marks packaged backend state available when a backend url is present", () => {
  const state = createAvailablePackagedBackendState("http://127.0.0.1:5001");

  assert.deepEqual(state, {
    kind: "packaged-local",
    available: true,
    backendUrl: "http://127.0.0.1:5001",
    statusMessage: null,
    canReconnect: true,
  });
});

test("marks packaged backend state unavailable after an unexpected exit", () => {
  const state = createUnavailablePackagedBackendStateFromExit(
    "http://127.0.0.1:5001",
    {
      code: 9,
      signal: "SIGSEGV",
    },
  );

  assert.equal(state.kind, "packaged-local");
  assert.equal(state.available, false);
  assert.equal(state.backendUrl, "http://127.0.0.1:5001");
  assert.equal(state.canReconnect, true);
  assert.match(state.statusMessage ?? "", /code=9/);
  assert.match(state.statusMessage ?? "", /signal=SIGSEGV/);
});

test("marks packaged backend state unavailable after a startup failure", () => {
  const state = createUnavailablePackagedBackendStateFromError(
    "",
    new Error("spawn failed"),
  );

  assert.deepEqual(state, {
    kind: "packaged-local",
    available: false,
    backendUrl: "",
    statusMessage: "内置本地后端不可用: Error: spawn failed",
    canReconnect: true,
  });
});
