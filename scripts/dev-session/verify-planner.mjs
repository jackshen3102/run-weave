import assert from "node:assert/strict";

import { INSTALLED_APP_CONTROL_PATH_PREFIXES } from "../runweave-update-core.mjs";
import { DevSessionError } from "./contracts.mjs";
import { buildDevSessionPlan } from "./planner.mjs";

export function expectDevSessionError(callback, exitCode) {
  assert.throws(callback, (error) => {
    assert(error instanceof DevSessionError);
    assert.equal(error.exitCode, exitCode);
    return true;
  });
}


export function verifyPlanner(sourceRoot) {
  const frontend = buildDevSessionPlan({
    sourceRoot,
    changedFiles: ["frontend/src/App.tsx"],
  });
  assert.equal(frontend.profile, "frontend");
  assert.equal(frontend.selectedBy, "changed-paths");

  const requiredSharedBackend = buildDevSessionPlan({
    sourceRoot,
    changedFiles: ["frontend/src/App.tsx"],
    explicitProfile: "frontend",
    serviceOverrides: [
      "backend=shared-declared",
      "appServer=dedicated",
    ],
  });
  assert.equal(
    requiredSharedBackend.services.backend.ownership,
    "shared-declared",
  );
  assert.equal(
    requiredSharedBackend.services.backend.selectedBy,
    "explicit-service",
  );

  const explicitFullstack = buildDevSessionPlan({
    sourceRoot,
    changedFiles: ["frontend/src/App.tsx"],
    explicitProfile: "fullstack",
  });
  assert.equal(explicitFullstack.profile, "fullstack");
  assert.equal(explicitFullstack.selectedBy, "explicit-profile");

  const explicitElectron = buildDevSessionPlan({
    sourceRoot,
    changedFiles: ["frontend/src/App.tsx"],
    explicitProfile: "electron",
    explicitSurface: "desktop",
  });
  assert.equal(explicitElectron.profile, "electron");
  assert.deepEqual(explicitElectron.targetEnvironment.acceptanceSurfaces, [
    "desktop",
  ]);
  assert.equal(explicitElectron.executable, true);
  assert.deepEqual(explicitElectron.unsupportedServices, []);
  assert.equal(
    explicitElectron.services.backend.ownership,
    "shared-declared",
  );
  assert.equal(
    explicitElectron.services.appServer.ownership,
    "shared-declared",
  );

  const explicitBeta = buildDevSessionPlan({
    sourceRoot,
    changedFiles: ["frontend/src/App.tsx"],
    explicitProfile: "beta",
    serviceOverrides: [
      "backend=shared-declared",
      "appServer=shared-declared",
    ],
  });
  assert.equal(explicitBeta.services.backend.ownership, "shared-declared");
  assert.equal(explicitBeta.services.appServer.ownership, "shared-declared");
  const betaWithBackendImpact = buildDevSessionPlan({
    sourceRoot,
    changedFiles: ["backend/src/index.ts"],
    explicitProfile: "beta",
  });
  assert.equal(betaWithBackendImpact.services.backend.ownership, "dedicated");
  assert.equal(
    betaWithBackendImpact.services.appServer.ownership,
    "shared-declared",
  );
  const betaWithAppServerImpact = buildDevSessionPlan({
    sourceRoot,
    changedFiles: ["app-server/src/index.ts"],
    explicitProfile: "beta",
  });
  assert.equal(
    betaWithAppServerImpact.services.backend.ownership,
    "dedicated",
  );
  assert.equal(
    betaWithAppServerImpact.services.appServer.ownership,
    "dedicated",
  );

  for (const backendChangedFile of [
    "backend/src/index.ts",
    "packages/shared/src/runtime-monitor.ts",
  ]) {
    const combinedBackendElectronImpact = buildDevSessionPlan({
      sourceRoot,
      changedFiles: [backendChangedFile, "electron/src/main.ts"],
    });
    assert.equal(combinedBackendElectronImpact.profile, "electron");
    assert.equal(
      combinedBackendElectronImpact.services.backend.ownership,
      "dedicated",
      backendChangedFile,
    );
    assert.equal(
      combinedBackendElectronImpact.services.appServer.ownership,
      "shared-declared",
      backendChangedFile,
    );
  }

  const sharedContract = buildDevSessionPlan({
    sourceRoot,
    changedFiles: ["packages/shared/src/runtime-monitor.ts"],
  });
  assert.equal(sharedContract.profile, "fullstack");
  assert.equal(sharedContract.impacts.length, 1);

  const betaControlPaths = [
    ...INSTALLED_APP_CONTROL_PATH_PREFIXES.map((prefix) =>
      prefix.endsWith("/") ? `${prefix}verify` : prefix,
    ),
    "scripts/runweave-beta-state.mjs",
    "scripts/runweave-beta-operations.mjs",
    "scripts/runweave-update-operations.mjs",
    "scripts/install-app-server-runtime.mjs",
  ];
  for (const changedFile of betaControlPaths) {
    const betaControlChange = buildDevSessionPlan({
      sourceRoot,
      changedFiles: [changedFile],
    });
    assert.equal(betaControlChange.profile, "beta", changedFile);
    assert.equal(betaControlChange.impacts.length, 1, changedFile);
  }

  const combinedDesktopContract = buildDevSessionPlan({
    sourceRoot,
    changedFiles: [
      "packages/shared/src/app-server/types.ts",
      "electron/src/main.ts",
    ],
  });
  assert.equal(combinedDesktopContract.profile, "beta");
  assert.equal(combinedDesktopContract.executable, true);

  const requestedBetaSlot = buildDevSessionPlan({
    sourceRoot,
    changedFiles: ["scripts/runweave-beta.mjs"],
    explicitProfile: "beta",
    explicitInstance: "pool-05",
  });
  assert.equal(requestedBetaSlot.targetEnvironment.instanceId, "pool-05");
  assert.deepEqual(requestedBetaSlot.targetEnvironment.betaSlot, {
    policy: "fixed-pool-v1",
    capacity: 5,
    requestedSlotId: "pool-05",
    assignedSlotId: null,
    leaseNonce: null,
  });
  expectDevSessionError(
    () =>
      buildDevSessionPlan({
        sourceRoot,
        changedFiles: ["scripts/runweave-beta.mjs"],
        explicitProfile: "beta",
        explicitInstance: "dvs-legacy",
      }),
    2,
  );

  expectDevSessionError(
    () =>
      buildDevSessionPlan({
        sourceRoot,
        changedFiles: ["frontend/src/App.tsx"],
        explicitProfile: "frontend",
        serviceOverrides: ["electron=dedicated"],
      }),
    4,
  );

  expectDevSessionError(
    () =>
      buildDevSessionPlan({
        sourceRoot,
        changedFiles: ["backend/src/index.ts"],
        explicitProfile: "fullstack",
        serviceOverrides: ["backend=shared-declared"],
      }),
    4,
  );
  expectDevSessionError(
    () =>
      buildDevSessionPlan({
        sourceRoot,
        changedFiles: ["frontend/src/App.tsx"],
        explicitProfile: "fullstack",
        serviceOverrides: ["appServer=disabled"],
      }),
    4,
  );

  let incompleteProfileError = null;
  try {
    buildDevSessionPlan({
      sourceRoot,
      changedFiles: ["app-server/src/index.ts"],
      explicitProfile: "frontend",
    });
  } catch (error) {
    incompleteProfileError = error;
  }
  assert(incompleteProfileError instanceof DevSessionError);
  assert.equal(incompleteProfileError.exitCode, 4);
  assert.deepEqual(incompleteProfileError.details.missingServices, [
    "appServer",
    "backend",
  ]);
  assert.deepEqual(incompleteProfileError.details.requiredOwnership, {
    backend: "dedicated",
    appServer: "dedicated",
  });
  assert.deepEqual(incompleteProfileError.details.requestedOwnership, {
    backend: "shared-declared",
    appServer: "shared-declared",
  });
}
