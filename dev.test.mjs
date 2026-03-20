import test from "node:test";
import assert from "node:assert/strict";

import { createBackendEnv, createFrontendEnv } from "./dev.mjs";

test("createBackendEnv pins backend port and strict mode", () => {
  const env = createBackendEnv({
    baseEnv: { AUTH_USERNAME: "admin" },
    backendPort: 5005,
  });

  assert.equal(env.PORT, "5005");
  assert.equal(env.PORT_STRICT, "true");
  assert.equal(env.AUTH_USERNAME, "admin");
});

test("createFrontendEnv pins proxy target and strict port mode", () => {
  const env = createFrontendEnv({
    baseEnv: { NODE_ENV: "development" },
    backendPort: 5005,
    frontendHost: "0.0.0.0",
  });

  assert.equal(env.VITE_PROXY_TARGET, "http://localhost:5005");
  assert.equal(env.VITE_STRICT_PORT, "true");
  assert.equal(env.VITE_DEV_HOST, "0.0.0.0");
  assert.equal(env.VITE_API_BASE_URL, "");
  assert.equal(env.NODE_ENV, "development");
});
