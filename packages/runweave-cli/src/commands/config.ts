import { resolveAuthContext } from "../client/auth-context.js";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  ConfigurationStore, ConfigurationError, resolveConfigurationContext,
  parseConfigurationYaml, emptyConfiguration, importEnvironment,
  discoverMigrationSources, retainSelectedStorage,
  prepareMigration, migrationPreview, redactConfiguration, backupMigrationSources,
  readInitialAuthFile, prepareInitialConfiguration, assertNewStableInstallation,
  type MigrationSource,
} from "@runweave/config-node";
import { CONFIGURATION_FIELDS, type ConfigurationValue } from "@runweave/shared/configuration";
import { parseArgs, getStringOption, resolveOutputMode } from "../args.js";
import { writeOutput } from "../output/format.js";
import { CliError } from "../errors.js";

export async function runConfigCommand(command: string | undefined, args: string[], io: {
  stdout: Pick<NodeJS.WriteStream, "write">;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const parsed = parseArgs(args, new Set(["json", "plain", "dry-run", "confirm-new-install"]));
  const mode = resolveOutputMode(parsed.options);
  const write = !["path", "show", "validate", "doctor", "keys", "backups"].includes(command ?? "");
  const context = resolveConfigurationContext({ args, requireExplicit: write });
  const store = new ConfigurationStore(context);
  const output = (value: unknown) => writeOutput(io.stdout, mode, mode === "plain" && typeof value !== "string" ? JSON.stringify(value, null, 2) : value);
  if (command === "path") { output(mode === "json" ? { ...context, file: store.file } : store.file); return; }
  if (command === "keys") { output(CONFIGURATION_FIELDS); return; }
  if (command === "backups") { output(store.backups()); return; }
  if (command === "init") {
    assertNewStableInstallation(context);
    const authFile = getStringOption(parsed.options, "auth-file");
    if (!authFile) throw new ConfigurationError("CONFIG_INITIAL_AUTH_FILE_REQUIRED");
    const draft = prepareInitialConfiguration(context, readInitialAuthFile(authFile));
    if (parsed.options["dry-run"]) {
      output({ environment: context, file: store.file, values: redactConfiguration(draft), state: "readyToInitialize" });
      return;
    }
    if (!parsed.options["confirm-new-install"]) throw new ConfigurationError("CONFIG_NEW_INSTALL_CONFIRMATION_REQUIRED");
    const next = store.initialize(draft);
    output({ environment: context, savedRevision: next.value.revision, digest: next.digest, state: "restartRequired" });
    return;
  }
  if (command === "restore") {
    const id = parsed.positionals[0];
    if (!id) throw new CliError("Usage: rw config restore <backup-id> --instance <id> --dry-run", 2);
    if (parsed.options["dry-run"]) { output({ environment: context, ...store.previewRestore(id) }); return; }
    const revision = getStringOption(parsed.options, "expected-revision");
    const digest = getStringOption(parsed.options, "expected-digest");
    const backupDigest = getStringOption(parsed.options, "expected-backup-digest");
    if (revision === undefined || !Number.isSafeInteger(Number(revision)) || Number(revision) < 0 || !/^[a-f0-9]{64}$/.test(digest ?? "") || !/^[a-f0-9]{64}$/.test(backupDigest ?? "")) throw new ConfigurationError("CONFIG_RESTORE_PREVIEW_REQUIRED");
    const next = store.restoreBackup(id, { revision: Number(revision), digest: digest!, backupDigest: backupDigest! });
    output({ environment: context, savedRevision: next.value.revision, digest: next.digest, state: "restartRequired" });
    return;
  }
  if (command === "show" || command === "validate" || command === "doctor") {
    const snapshot = store.read();
    const source = command === "doctor" ? {
      authoritativeFile: store.file,
      legacyFilesPresent: discoverMigrationSources(context, {}).map(({ domain, file }) => ({ domain, file })),
      legacyEnvironmentKeysPresent: [...new Set(CONFIGURATION_FIELDS.flatMap((field) => field.environmentKeys).filter((key) => io.env[key] !== undefined))].sort(),
      cwdDotenvPresent: existsSync(path.resolve(".env")),
    } : undefined;
    output({ environment: context, revision: snapshot.value.revision, digest: snapshot.digest, issues: snapshot.issues, ...(command === "show" ? { values: redactConfiguration(snapshot.value) } : {}), ...(source ? { source } : {}) });
    if (command !== "show" && Object.keys(snapshot.issues).length) throw new ConfigurationError("CONFIG_VALIDATION_FAILED");
    return;
  }
  if (command === "reload") {
    const auth = await resolveAuthContext({ profileName: getStringOption(parsed.options, "profile") });
    output(await auth.requestJson("/api/configuration/reload", { method: "POST" }));
    return;
  }
  if (command === "migrate") {
    const manifest = getStringOption(parsed.options, "source-manifest");
    const selected = { backendProfile: getStringOption(parsed.options, "backend-profile"), desktopData: getStringOption(parsed.options, "desktop-data") };
    const sources: MigrationSource[] = manifest ? parseJsonFile(manifest) as MigrationSource[] : discoverMigrationSources(context, selected);
    if (!Array.isArray(sources) || sources.some((source) => !source || typeof source.file !== "string" || typeof source.domain !== "string" || !["json", "env"].includes(source.format))) throw new ConfigurationError("CONFIG_SOURCE_MANIFEST_INVALID");
    const current = existsSync(store.file) ? store.read() : null;
    const draft = prepareMigration(context, sources);
    retainSelectedStorage(context, selected, draft);
    if (parsed.options["dry-run"]) { output({ environment: context, file: store.file, ...migrationPreview(draft) }); return; }
    if (draft.conflicts.length) throw new ConfigurationError("CONFIG_MIGRATION_CONFLICT", draft.conflicts);
    if (!sources.length && !current) throw new ConfigurationError("CONFIG_SOURCE_REQUIRED");
    backupMigrationSources(context, draft);
    const next = store.migrate(draft.value, current ? { revision: current.value.revision, digest: current.digest } : null);
    output({ environment: context, savedRevision: next.value.revision, digest: next.digest, state: "restartRequired" });
    return;
  }
  if (command === "import" || command === "import-env") {
    const current = existsSync(store.file) ? store.read() : null;
    const input = getStringOption(parsed.options, "file");
    const value = command === "import"
      ? parseConfigurationYaml(readFileSync(input ?? 0, "utf8"), context).value
      : structuredClone(current?.value ?? emptyConfiguration(context));
    if (command === "import-env") importEnvironment(value, io.env);
    if (parsed.options["dry-run"]) { output({ values: redactConfiguration(value) }); return; }
    const next = store.migrate(value, current ? { revision: current.value.revision, digest: current.digest } : null);
    output({ environment: context, savedRevision: next.value.revision, digest: next.digest, state: "restartRequired" });
    return;
  }
  if (command === "set") {
    const key = parsed.positionals[0];
    const file = getStringOption(parsed.options, "value-file");
    if (!key || !file) throw new CliError("Usage: rw config set <key> --value-file <JSON file or -> --instance <id>", 2);
    const value: ConfigurationValue = parseJsonFile(file) as ConfigurationValue;
    const current = store.read();
    const expectedRevision = getStringOption(parsed.options, "expected-revision");
    const expectedDigest = getStringOption(parsed.options, "expected-digest");
    if ((expectedRevision === undefined) !== (expectedDigest === undefined) || expectedRevision !== undefined && (!Number.isSafeInteger(Number(expectedRevision)) || Number(expectedRevision) < 0 || !/^[a-f0-9]{64}$/.test(expectedDigest!))) throw new ConfigurationError("CONFIG_EXPECTED_VERSION_INVALID");
    const next = store.patch({ expectedRevision: expectedRevision === undefined ? current.value.revision : Number(expectedRevision), expectedDigest: expectedDigest ?? current.digest, changes: { [key]: value } });
    output({ environment: context, savedRevision: next.value.revision, digest: next.digest, state: "restartRequired" });
    return;
  }
  throw new CliError("Usage: rw config <path|show|keys|init|validate|doctor|backups|restore|reload|set|import|import-env|migrate> [--instance <id>] [--config-dir <absolute path>]", 2);
}

function parseJsonFile(file: string): unknown {
  try { return JSON.parse(readFileSync(file === "-" ? 0 : file, "utf8")); }
  catch { throw new ConfigurationError("CONFIG_JSON_INPUT_INVALID"); }
}
