import assert from "node:assert/strict";
import {
  selectLayersForChangedFiles,
  selectStepsForChangedFiles,
} from "./quality-gate.mjs";

assert.deepEqual(
  selectLayersForChangedFiles(["frontend/src/components/viewer-page.tsx"]),
  ["default", "e2e"],
);

assert.deepEqual(
  selectLayersForChangedFiles(["backend/src/live/provider-client.ts"]),
  ["default", "live"],
);

assert.deepEqual(selectLayersForChangedFiles(["backend/vitest.live.config.ts"]), [
  "default",
  "live",
]);

assert.deepEqual(
  selectLayersForChangedFiles([
    "backend/src/live/provider-client.ts",
    "backend/src/routes/session.ts",
  ]),
  ["default", "live"],
);

assert.deepEqual(
  selectLayersForChangedFiles(["backend/src/routes/session.ts"]),
  ["default"],
);

assert.deepEqual(selectLayersForChangedFiles(["electron/src/main.ts"]), [
  "default",
]);

assert.deepEqual(
  selectLayersForChangedFiles(["frontend/src/components/login-page.tsx"]),
  ["e2e"],
);

assert.deepEqual(selectLayersForChangedFiles(["scripts/quality-gate.mjs"]), [
  "default",
]);

assert.deepEqual(selectLayersForChangedFiles(["package.json"]), [
  "default",
  "e2e",
  "live",
]);

const gateSelection = selectStepsForChangedFiles(["scripts/quality-gate.mjs"]);
assert.deepEqual(gateSelection.selectedLayers, ["default"]);
assert.equal(
  gateSelection.selectedSteps.some(
    (step) => step.id === "quality-gate-self-test",
  ),
  true,
);

const rootInfraSelection = selectStepsForChangedFiles(["package.json"]);
assert.equal(rootInfraSelection.selectedSteps.length > 0, true);

const fullSelection = selectStepsForChangedFiles([]);
assert.equal(
  fullSelection.selectedSteps.some(
    (step) => step.id === "quality-gate-self-test",
  ),
  true,
);

assert.deepEqual(selectLayersForChangedFiles([]), ["default", "e2e", "live"]);

globalThis.console.log("quality-gate layer selection tests passed");
