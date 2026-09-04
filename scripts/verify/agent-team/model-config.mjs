import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentTeamError } from "../../../backend/src/agent-team/errors.ts";
import { AgentTeamModelConfigStore } from "../../../backend/src/agent-team/runtime/model-config-store.ts";
import { AgentTeamModelSettingsService } from "../../../backend/src/agent-team/model-catalog/service.ts";
import {
  cloneAgentTeamRoleRuntimeSnapshot,
  compileAgentTeamRoleTerminal,
  createLegacyAgentTeamRoleRuntimeSnapshot,
  resolveAgentTeamRoleTerminal,
} from "../../../backend/src/agent-team/runtime/model-runtime.ts";
import { AgentTeamService } from "../../../backend/src/agent-team/service.ts";
import { withHarness } from "./review-checkpoints/bootstrap/harness.mjs";

const checks = [];
const roots = [];

function check(name, condition, detail) {
  if (!condition) {
    throw new Error(`${name}: ${JSON.stringify(detail)}`);
  }
  checks.push(name);
}

function roleConfig(modelIds = { codex: "codex-a", traex: "traex-a" }) {
  return {
    main: {
      provider: "codex",
      model: modelIds.codex,
      reasoningEffort: "high",
      fast: false,
    },
    code: {
      provider: "traex",
      model: modelIds.traex,
      reasoningEffort: "high",
      max: false,
    },
    code_review: {
      provider: "codex",
      model: modelIds.codex,
      reasoningEffort: null,
      fast: true,
    },
    behavior_verify: {
      provider: "traex",
      model: modelIds.traex,
      reasoningEffort: null,
      max: true,
    },
  };
}

async function createCliShims(binDir) {
  await mkdir(binDir, { recursive: true });
  const shebang = `#!${process.execPath}\n`;
  const codex = `${shebang}
const args = process.argv.slice(2);
const mode = process.env.MODEL_FIXTURE_MODE || "first";
if (args[0] === "--version") {
  console.log("codex-cli fixture");
} else if (args.join(" ") === "debug models") {
  if (mode === "fail") process.exit(9);
  const suffix = mode === "second" ? "b" : "a";
  console.log(JSON.stringify({ models: [{
    slug: "codex-" + suffix,
    display_name: "Codex " + suffix.toUpperCase(),
    description: "fixture",
    context_window: 100000,
    default_reasoning_level: "high",
    supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
    additional_speed_tiers: ["fast"],
    base_instructions: "SHOULD_NOT_BE_PERSISTED"
  }] }));
} else {
  process.exit(2);
}
`;
  const traex = `${shebang}
const args = process.argv.slice(2);
const mode = process.env.MODEL_FIXTURE_MODE || "first";
if (args[0] === "--version") {
  console.log("traecli fixture");
} else if (args.join(" ") === "models --json") {
  if (mode === "fail") process.exit(9);
  const suffix = mode === "second" ? "b" : "a";
  console.log(JSON.stringify([{
    name: "traex-" + suffix,
    description: "fixture",
    context_window: 200000,
    _meta: { trae: { contextWindow: 200000, supportsMaxMode: true } },
    secret: "SHOULD_NOT_BE_PERSISTED"
  }]));
} else if (args.join(" ") === "debug models") {
  if (mode === "fail") process.exit(9);
  const suffix = mode === "second" ? "b" : "a";
  console.log(JSON.stringify({ models: [{
    slug: "traex-" + suffix,
    default_reasoning_level: "high",
    supported_reasoning_levels: [{ effort: "high" }],
    business_metadata: { variants: { max_key: "max-fixture" } },
    base_instructions: "SHOULD_NOT_BE_PERSISTED"
  }] }));
} else {
  process.exit(2);
}
`;
  const codexPath = path.join(binDir, "codex");
  const traexPath = path.join(binDir, "traex");
  await Promise.all([
    writeFile(codexPath, codex),
    writeFile(traexPath, traex),
  ]);
  await Promise.all([chmod(codexPath, 0o755), chmod(traexPath, 0o755)]);
}

async function verifyCatalogStoreAndRuntime() {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "runweave-agent-team-model-config-"),
  );
  roots.push(root);
  const binDir = path.join(root, "bin");
  await createCliShims(binDir);
  const storeFile = path.join(root, "agent-team-model-settings.json");
  const store = new AgentTeamModelConfigStore(storeFile);
  await store.initialize();
  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    MODEL_FIXTURE_MODE: "first",
  };
  const service = new AgentTeamModelSettingsService(store, env);
  try {
    const fresh = await service.getSettings();
    check(
      "fresh-catalogs-are-normalized",
      fresh.catalogs.codex.source === "fresh" &&
        fresh.catalogs.codex.models[0]?.id === "codex-a" &&
        fresh.catalogs.codex.models[0]?.supportsFast === true &&
        fresh.catalogs.traex.source === "fresh" &&
        fresh.catalogs.traex.models[0]?.id === "traex-a" &&
        fresh.catalogs.traex.models[0]?.supportsMax === true,
      fresh.catalogs,
    );

    const saved = await service.saveSettings({ roles: roleConfig() });
    check(
      "four-role-config-is-saved",
      saved.config?.roles.main.model === "codex-a" &&
        saved.config.roles.code.model === "traex-a",
      saved.config,
    );
    const disk = await readFile(storeFile, "utf8");
    check(
      "catalog-cache-excludes-raw-cli-fields",
      !disk.includes("base_instructions") &&
        !disk.includes("SHOULD_NOT_BE_PERSISTED") &&
        !disk.includes('"secret"'),
      disk,
    );

    env.MODEL_FIXTURE_MODE = "fail";
    const cached = await service.getSettings();
    check(
      "soft-catalog-failure-uses-cache",
      cached.catalogs.codex.availability === "available" &&
        cached.catalogs.codex.source === "cache" &&
        cached.catalogs.codex.errorCode === "catalog_unavailable" &&
        cached.catalogs.traex.availability === "available" &&
        cached.catalogs.traex.source === "cache",
      cached.catalogs,
    );

    const missingService = new AgentTeamModelSettingsService(store, {
      ...env,
      PATH: path.join(root, "empty-bin"),
    });
    const missing = await missingService.getSettings();
    check(
      "missing-cli-never-uses-cache-as-available",
      missing.catalogs.codex.availability === "unavailable" &&
        missing.catalogs.codex.source === "cache" &&
        missing.catalogs.codex.errorCode === "cli_missing" &&
        missing.catalogs.traex.availability === "unavailable",
      missing.catalogs,
    );

    env.MODEL_FIXTURE_MODE = "second";
    const refreshed = await service.getSettings();
    check(
      "fresh-success-overwrites-provider-caches-independently",
      refreshed.catalogs.codex.models[0]?.id === "codex-b" &&
        refreshed.catalogs.traex.models[0]?.id === "traex-b" &&
        store.getCatalog("codex")?.models[0]?.id === "codex-b" &&
        store.getCatalog("traex")?.models[0]?.id === "traex-b",
      refreshed.catalogs,
    );

    env.MODEL_FIXTURE_MODE = "first";
    await service.saveSettings({ roles: roleConfig() });
    const snapshot = await service.resolveGlobalRuntimeSnapshot();
    const retrySnapshot = cloneAgentTeamRoleRuntimeSnapshot(snapshot, {
      source: "retry_snapshot",
      capturedAt: "2026-07-25T00:00:00.000Z",
    });
    const legacySnapshot = createLegacyAgentTeamRoleRuntimeSnapshot({
      command: "traex",
      args: ["-m", "legacy-model"],
      cwd: null,
      runtimePreference: "auto",
    });
    check(
      "runtime-sources-preserve-role-terminals",
      snapshot.source === "global_config" &&
        resolveAgentTeamRoleTerminal(
          { terminal: snapshot.roles.main.terminal, roleRuntimes: snapshot },
          "code",
        ).command === "traex" &&
        retrySnapshot.source === "retry_snapshot" &&
        retrySnapshot.roles.code.terminal.command === "traex" &&
        legacySnapshot.source === "legacy_terminal" &&
        legacySnapshot.roles.code.terminal.command === "traex",
      { snapshot, retrySnapshot, legacySnapshot },
    );

    const codexOff = compileAgentTeamRoleTerminal({
      provider: "codex",
      model: "codex-a",
      reasoningEffort: null,
      fast: false,
    });
    const traexOff = compileAgentTeamRoleTerminal({
      provider: "traex",
      model: "traex-a",
      reasoningEffort: null,
      max: false,
    });
    check(
      "disabled-fast-and-max-explicitly-override-ambient-config",
      codexOff.args?.includes("features.fast_mode=false") &&
        codexOff.args.includes('service_tier="standard"') &&
        traexOff.args?.includes('model_backend_variant="standard"'),
      { codexOff, traexOff },
    );

    let validationError = null;
    try {
      await service.saveSettings({
        roles: roleConfig({ codex: "missing-model", traex: "traex-a" }),
      });
    } catch (error) {
      validationError = error;
    }
    check(
      "invalid-model-identifies-role-provider-and-model",
      validationError instanceof AgentTeamError &&
        validationError.statusCode === 409 &&
        validationError.details?.code === "model_unavailable" &&
        validationError.details?.role === "main" &&
        validationError.details?.provider === "codex" &&
        validationError.details?.model === "missing-model",
      validationError,
    );
  } finally {
    await store.dispose();
  }
}

async function verifyPreflightHasNoSideEffects() {
  await withHarness(roots, async (harness) => {
    let writes = 0;
    let modelResolutionCalls = 0;
    let checkpointCalls = 0;
    const service = new AgentTeamService({
      terminalSessionManager: harness.manager,
      terminalEventService: { record() {}, subscribe() {} },
      ptyService: harness.options.ptyService,
      runtimeRegistry: harness.options.runtimeRegistry,
      terminalStateService: harness.options.terminalStateService,
      tmuxService: harness.tmuxService,
      cwd: harness.session.cwd,
      modelSettingsService: {
        async resolveGlobalRuntimeSnapshot() {
          modelResolutionCalls += 1;
          throw new AgentTeamError(409, "config required", {
            code: "config_required",
          });
        },
      },
    });
    service.runStore.writeRun = async () => {
      writes += 1;
    };
    service.reviewCheckpointGit.preflight = async () => {
      checkpointCalls += 1;
      throw new Error("checkpoint should not run");
    };
    const panelCountBefore = harness.manager.listPanels(harness.session.id).length;

    let conflictError = null;
    try {
      await service.startRun({
        projectId: harness.session.projectId,
        terminalSessionId: harness.session.id,
        task: "conflicting runtime source",
        retryOfRunId: "atr_failed_source",
        terminal: { command: "codex" },
      });
    } catch (error) {
      conflictError = error;
    }
    check(
      "retry-and-explicit-terminal-conflict-is-400-without-side-effects",
      conflictError instanceof AgentTeamError &&
        conflictError.statusCode === 400 &&
        writes === 0 &&
        modelResolutionCalls === 0 &&
        checkpointCalls === 0 &&
        harness.manager.listPanels(harness.session.id).length === panelCountBefore,
      { conflictError, writes, modelResolutionCalls, checkpointCalls },
    );

    let configError = null;
    try {
      await service.startRun({
        projectId: harness.session.projectId,
        terminalSessionId: harness.session.id,
        task: "missing global config",
        options: { reviewCheckpointMode: "local_commit" },
      });
    } catch (error) {
      configError = error;
    }
    check(
      "model-preflight-fails-before-run-pane-or-checkpoint-effects",
      configError instanceof AgentTeamError &&
        configError.details?.code === "config_required" &&
        writes === 0 &&
        modelResolutionCalls === 1 &&
        checkpointCalls === 0 &&
        harness.manager.listPanels(harness.session.id).length === panelCountBefore,
      { configError, writes, modelResolutionCalls, checkpointCalls },
    );
  });
}

try {
  await verifyCatalogStoreAndRuntime();
  await verifyPreflightHasNoSideEffects();
  console.log(
    JSON.stringify(
      {
        ok: true,
        checkCount: checks.length,
        checks,
      },
      null,
      2,
    ),
  );
} finally {
  for (const root of roots.reverse()) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}
