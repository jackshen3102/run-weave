import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

import { isInstalledAppControlPath } from "../runweave-update-core.mjs";

import {
  DevSessionError,
  assertBetaInstanceId,
  assertDevSessionId,
  assertOwnership,
  assertProfile,
  assertSurface,
} from "./contracts.mjs";

const execFileAsync = promisify(execFile);

const PROFILE_REQUIREMENTS = {
  frontend: new Set(["frontend", "backend"]),
  fullstack: new Set(["frontend", "backend"]),
  "app-server": new Set(["frontend", "backend", "appServer"]),
  electron: new Set([
    "frontend",
    "backend",
    "electron",
    "desktopCdp",
    "terminalBrowserCdp",
  ]),
  beta: new Set([
    "frontend",
    "backend",
    "appServer",
    "electron",
    "desktopCdp",
    "terminalBrowserCdp",
    "beta",
  ]),
};

const EXECUTABLE_PROFILES = new Set([
  "frontend",
  "fullstack",
  "app-server",
  "electron",
  "beta",
]);

const PROFILE_PRIORITY = {
  frontend: 1,
  fullstack: 2,
  "app-server": 3,
  electron: 4,
  beta: 5,
};

const OWNERSHIP_PRIORITY = {
  disabled: 0,
  "shared-declared": 1,
  dedicated: 2,
};

function normalizeChangedFile(sourceRoot, file) {
  const absolute = path.resolve(sourceRoot, file);
  const relative = path.relative(sourceRoot, absolute);
  if (
    relative === "" ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new DevSessionError("changed file must be inside source root", 2, {
      file,
      sourceRoot,
    });
  }
  return relative.split(path.sep).join("/");
}

function classifyChangedFile(file) {
  if (file.startsWith("frontend/")) {
    return { profile: "frontend", reason: "Web frontend changed" };
  }
  if (file.startsWith("backend/")) {
    return {
      profile: "fullstack",
      reason: "Backend behavior or contract changed",
    };
  }
  if (file.startsWith("app-server/") || file.includes("/app-server/")) {
    return {
      profile: "app-server",
      reason: "App Server state or protocol changed",
    };
  }
  if (
    isInstalledAppControlPath(file) ||
    file.startsWith("scripts/runweave-beta-") ||
    file.startsWith("scripts/runweave-update-") ||
    file === "scripts/build-runtime-package.mjs" ||
    file === "scripts/install-runtime-package.mjs" ||
    file === "scripts/install-app-server-runtime.mjs" ||
    file.includes("updater") ||
    file.includes("runtime-package")
  ) {
    return { profile: "beta", reason: "Installed runtime or updater changed" };
  }
  if (file.startsWith("electron/")) {
    return { profile: "electron", reason: "Electron or CDP surface changed" };
  }
  if (file.startsWith("packages/shared/")) {
    const isAppServerContract = file.includes("/app-server/");
    const isBackendHealthContract = file.endsWith("/runtime-monitor.ts");
    const profile = isAppServerContract
      ? "app-server"
      : isBackendHealthContract
        ? "fullstack"
        : "beta";
    return {
      profile,
      reason: isAppServerContract
        ? "Shared App Server contract changed"
        : isBackendHealthContract
          ? "Shared Backend health contract changed"
          : "Shared contract consumers are not narrow enough to exclude installed desktop surfaces",
    };
  }
  if (
    file === "dev.mjs" ||
    file === "electron-dev.mjs" ||
    file.startsWith("scripts/dev-session/") ||
    file === "scripts/verify-dev-session.mjs" ||
    file === "package.json"
  ) {
    return {
      profile: "fullstack",
      reason: "Development control layer changed",
    };
  }
  return null;
}

export async function collectChangedFiles(sourceRoot, explicitFiles = []) {
  const gitFiles = new Set();
  const commands = [
    ["diff", "--name-only", "HEAD"],
    ["ls-files", "--others", "--exclude-standard"],
  ];
  for (const args of commands) {
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd: sourceRoot,
        encoding: "utf8",
      });
      for (const file of stdout
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean)) {
        gitFiles.add(normalizeChangedFile(sourceRoot, file));
      }
    } catch (error) {
      throw new DevSessionError("failed to inspect changed files", 1, {
        command: `git ${args.join(" ")}`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  for (const file of explicitFiles) {
    gitFiles.add(normalizeChangedFile(sourceRoot, file));
  }
  return [...gitFiles].sort();
}

function selectRequiredProfile(impacts) {
  if (impacts.length === 0) {
    return {
      profile: "fullstack",
      reason:
        "No actionable code impact was detected; preserving legacy pnpm dev semantics",
    };
  }
  const requiredCapabilities = new Set();
  let minimumPriority = 0;
  for (const impact of impacts) {
    minimumPriority = Math.max(
      minimumPriority,
      PROFILE_PRIORITY[impact.profile],
    );
    for (const capability of PROFILE_REQUIREMENTS[impact.profile]) {
      requiredCapabilities.add(capability);
    }
  }
  const profile = Object.keys(PROFILE_REQUIREMENTS)
    .filter((candidate) => PROFILE_PRIORITY[candidate] >= minimumPriority)
    .sort((left, right) => PROFILE_PRIORITY[left] - PROFILE_PRIORITY[right])
    .find((candidate) =>
      [...requiredCapabilities].every((capability) =>
        PROFILE_REQUIREMENTS[candidate].has(capability),
      ),
    );
  if (!profile) {
    throw new DevSessionError(
      "no profile satisfies the changed-path capability closure",
      4,
      {
        requiredCapabilities: [...requiredCapabilities],
      },
    );
  }
  return {
    profile,
    reason:
      impacts
        .filter((impact) => impact.profile === profile)
        .map((impact) => impact.reason)
        .join("; ") || "Combined changed-path capability closure",
  };
}

function assertProfileSatisfies(selectedProfile, requiredProfile, impacts) {
  const selected = PROFILE_REQUIREMENTS[selectedProfile];
  const required = PROFILE_REQUIREMENTS[requiredProfile];
  const missingCapabilities = [...required].filter(
    (service) => !selected.has(service),
  );
  const selectedServices = defaultServices(
    selectedProfile,
    impacts,
    requiredProfile,
  );
  const requiredServices = defaultServices(
    requiredProfile,
    impacts,
    requiredProfile,
  );
  const ownershipMismatches = ["backend", "appServer"]
    .filter(
      (service) =>
        OWNERSHIP_PRIORITY[selectedServices[service].ownership] <
        OWNERSHIP_PRIORITY[requiredServices[service].ownership],
    )
    .map((service) => ({
      service,
      requiredOwnership: requiredServices[service].ownership,
      requestedOwnership: selectedServices[service].ownership,
    }));
  const missingServices = [
    ...new Set([
      ...missingCapabilities,
      ...ownershipMismatches.map(({ service }) => service),
    ]),
  ];
  if (
    missingServices.length > 0 ||
    PROFILE_PRIORITY[selectedProfile] < PROFILE_PRIORITY[requiredProfile]
  ) {
    throw new DevSessionError(
      `profile ${selectedProfile} is below the required ${requiredProfile} boundary`,
      4,
      {
        selectedProfile,
        requiredProfile,
        missingServices,
        ownershipMismatches,
        requiredOwnership: Object.fromEntries(
          ownershipMismatches.map(({ service, requiredOwnership }) => [
            service,
            requiredOwnership,
          ]),
        ),
        requestedOwnership: Object.fromEntries(
          ownershipMismatches.map(({ service, requestedOwnership }) => [
            service,
            requestedOwnership,
          ]),
        ),
      },
    );
  }
}

function defaultServices(profile, impacts, requiredProfile) {
  const impactProfiles = new Set(
    impacts.length > 0
      ? impacts.map((impact) => impact.profile)
      : [requiredProfile],
  );
  const backendAffected = ["fullstack", "app-server", "beta"].some(
    (impactProfile) => impactProfiles.has(impactProfile),
  );
  const appServerAffected = ["app-server", "beta"].some((impactProfile) =>
    impactProfiles.has(impactProfile),
  );
  const services = {
    frontend: { ownership: "disabled" },
    backend: { ownership: "disabled" },
    appServer: { ownership: "disabled" },
    electron: { ownership: "disabled" },
    beta: { ownership: "disabled" },
    cdp: {
      desktop: { ownership: "disabled" },
      terminalBrowser: { ownership: "disabled" },
    },
  };
  if (profile === "frontend") {
    services.frontend = { ownership: "dedicated" };
    services.backend = {
      ownership: "shared-declared",
      sharedReason: "Backend code and shared contract are unchanged",
    };
    services.appServer = {
      ownership: "shared-declared",
      sharedReason: "App Server code and lifecycle are unchanged",
    };
  } else if (profile === "fullstack") {
    services.frontend = { ownership: "dedicated" };
    services.backend = { ownership: "dedicated" };
    services.appServer = {
      ownership: "shared-declared",
      sharedReason: "App Server code and lifecycle are unchanged",
    };
  } else if (profile === "app-server") {
    services.frontend = { ownership: "dedicated" };
    services.backend = { ownership: "dedicated" };
    services.appServer = { ownership: "dedicated" };
  } else if (profile === "electron") {
    services.frontend = { ownership: "dedicated" };
    services.backend = backendAffected
      ? { ownership: "dedicated" }
      : {
          ownership: "shared-declared",
          sharedReason: "Backend is outside the changed-path impact closure",
        };
    services.appServer = {
      ownership: appServerAffected ? "dedicated" : "shared-declared",
      ...(!appServerAffected
        ? {
            sharedReason:
              "App Server is outside the changed-path impact closure",
          }
        : {}),
    };
    services.electron = { ownership: "dedicated" };
    services.cdp.desktop = { ownership: "dedicated" };
    services.cdp.terminalBrowser = { ownership: "dedicated" };
  } else {
    services.frontend = { ownership: "dedicated" };
    services.backend = backendAffected
      ? { ownership: "dedicated" }
      : {
          ownership: "shared-declared",
          sharedReason: "Backend is outside the changed-path impact closure",
        };
    services.appServer = appServerAffected
      ? { ownership: "dedicated" }
      : {
          ownership: "shared-declared",
          sharedReason: "App Server is outside the changed-path impact closure",
        };
    services.beta = { ownership: "dedicated" };
    services.electron = { ownership: "dedicated" };
    services.cdp.desktop = { ownership: "dedicated" };
    services.cdp.terminalBrowser = { ownership: "dedicated" };
  }
  return services;
}

function applyServiceOverrides(services, overrides) {
  const allowed = new Set([
    "frontend",
    "backend",
    "appServer",
    "electron",
    "beta",
  ]);
  for (const override of overrides) {
    const separator = override.indexOf("=");
    if (separator < 1) {
      throw new DevSessionError("service override must be name=ownership", 2, {
        override,
      });
    }
    const service = override.slice(0, separator);
    const ownership = assertOwnership(override.slice(separator + 1));
    if (!allowed.has(service)) {
      throw new DevSessionError(`unsupported service override: ${service}`, 2);
    }
    services[service] = { ownership, selectedBy: "explicit-service" };
  }
}

export function buildDevSessionPlan({
  sourceRoot,
  changedFiles,
  explicitProfile,
  explicitSurface,
  explicitInstance,
  serviceOverrides = [],
}) {
  const normalizedFiles = [...new Set(changedFiles)].sort();
  const impacts = normalizedFiles
    .map((file) => {
      const classification = classifyChangedFile(file);
      return classification ? { file, ...classification } : null;
    })
    .filter(Boolean);
  const required = selectRequiredProfile(impacts);
  const profile = explicitProfile
    ? assertProfile(explicitProfile)
    : required.profile;
  if (explicitProfile) {
    assertProfileSatisfies(profile, required.profile, impacts);
  }
  const minimumServices = defaultServices(profile, impacts, required.profile);
  const services = structuredClone(minimumServices);
  applyServiceOverrides(services, serviceOverrides);
  const crossProfileServices = Object.keys(minimumServices).filter(
    (service) =>
      service !== "cdp" &&
      minimumServices[service].ownership === "disabled" &&
      services[service].ownership !== "disabled",
  );
  if (crossProfileServices.length > 0) {
    throw new DevSessionError(
      "service overrides cannot enable services outside the selected profile",
      4,
      { profile, crossProfileServices },
    );
  }
  const downgradedServices = Object.keys(minimumServices).filter(
    (service) =>
      service !== "cdp" &&
      OWNERSHIP_PRIORITY[services[service].ownership] <
        OWNERSHIP_PRIORITY[minimumServices[service].ownership],
  );
  if (downgradedServices.length > 0) {
    throw new DevSessionError(
      "service overrides cannot lower the profile ownership boundary",
      4,
      {
        profile,
        downgradedServices: downgradedServices.map((service) => ({
          service,
          requiredOwnership: minimumServices[service].ownership,
          requestedOwnership: services[service].ownership,
        })),
      },
    );
  }
  const disabledRequiredServices = [...PROFILE_REQUIREMENTS[profile]].filter(
    (service) =>
      service !== "desktopCdp" && services[service]?.ownership === "disabled",
  );
  if (disabledRequiredServices.length > 0) {
    throw new DevSessionError(
      "service overrides disable required services",
      4,
      {
        profile,
        missingServices: disabledRequiredServices,
      },
    );
  }
  const defaultSurface =
    profile === "electron" || profile === "beta" ? "desktop" : "web";
  const surface = assertSurface(explicitSurface ?? defaultSurface);
  return {
    profile,
    selectedBy: explicitProfile
      ? "explicit-profile"
      : impacts.length > 0
        ? "changed-paths"
        : "compatibility-default",
    selectionReason: explicitProfile
      ? `Explicit profile ${profile} accepted after impact validation`
      : required.reason,
    requiredProfile: required.profile,
    changedFiles: normalizedFiles,
    impacts,
    services,
    targetEnvironment: {
      kind: profile,
      acceptanceSurfaces: [surface],
      instanceId: explicitInstance
        ? profile === "beta"
          ? assertBetaInstanceId(explicitInstance)
          : assertDevSessionId(explicitInstance)
        : null,
    },
    sourceRoot,
    executable: EXECUTABLE_PROFILES.has(profile),
    unsupportedServices: EXECUTABLE_PROFILES.has(profile)
      ? []
      : [...PROFILE_REQUIREMENTS[profile]].filter((service) =>
          ["electron", "desktopCdp", "terminalBrowserCdp", "beta"].includes(
            service,
          ),
        ),
  };
}
