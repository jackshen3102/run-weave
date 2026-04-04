import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_LOCAL_UPDATE_BASE_URL,
  getCustomUpdateBaseUrl,
  shouldEnableAutoUpdates,
} from "./updater-config.js";

test("enables auto updates only for packaged mac builds", () => {
  assert.equal(shouldEnableAutoUpdates({ isPackaged: true, platform: "darwin" }), true);
  assert.equal(shouldEnableAutoUpdates({ isPackaged: false, platform: "darwin" }), false);
  assert.equal(shouldEnableAutoUpdates({ isPackaged: true, platform: "win32" }), false);
});

test("does not override the update base url when env is empty", () => {
  assert.equal(getCustomUpdateBaseUrl(undefined), null);
  assert.equal(getCustomUpdateBaseUrl("   "), null);
});

test("normalizes a custom local update base url with trailing slash", () => {
  assert.equal(
    getCustomUpdateBaseUrl("http://127.0.0.1:6600/custom-feed"),
    "http://127.0.0.1:6600/custom-feed/",
  );
});

test("returns the default local update base url when explicitly requested", () => {
  assert.equal(
    getCustomUpdateBaseUrl(DEFAULT_LOCAL_UPDATE_BASE_URL),
    DEFAULT_LOCAL_UPDATE_BASE_URL,
  );
});
