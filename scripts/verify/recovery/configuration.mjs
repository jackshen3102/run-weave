import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { configurationLibrary as config } from "../../lib/configuration.mjs";

export const tsxImport = pathToFileURL(
  createRequire(
    new URL("../../../backend/package.json", import.meta.url),
  ).resolve("tsx"),
).href;

export async function writeVerificationConfiguration(
  root,
  changes = {},
  kind = "dev",
) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const context = {
    kind,
    instanceId: kind === "stable" ? "stable" : "recovery-verification",
    configRoot: root,
  };
  const store = new config.ConfigurationStore(context);
  try {
    const snapshot = store.read();
    store.patch({
      expectedRevision: snapshot.value.revision,
      expectedDigest: snapshot.digest,
      changes,
    });
  } catch (error) {
    if (error.code !== "CONFIG_MIGRATION_REQUIRED") throw error;
    const value = config.prepareInitialConfiguration(context, {
      username: "isolated-verifier",
      password: randomBytes(24).toString("base64url"),
    });
    for (const [key, valueEntry] of Object.entries(changes))
      config.setConfigurationValue(value, key, valueEntry);
    // JSON is valid YAML; seed private fixtures without registering a Stable root.
    await writeFile(store.file, JSON.stringify(value, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
  }
  await writeFile(
    path.join(root, "verification-context.json"),
    JSON.stringify(context),
    { mode: 0o600 },
  );
  return context;
}
