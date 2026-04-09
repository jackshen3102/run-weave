import assert from "node:assert/strict";
import test from "node:test";
import { shouldAutoOpenWindowDevtools } from "./window-devtools.js";

test("does not auto-open devtools in development", () => {
  assert.equal(shouldAutoOpenWindowDevtools({ isDev: true }), false);
});

test("does not auto-open devtools in packaged builds", () => {
  assert.equal(shouldAutoOpenWindowDevtools({ isDev: false }), false);
});
