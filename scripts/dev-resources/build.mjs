import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import path from "node:path";
import { copyNativeLockRuntime } from "../../packages/config-node/scripts/native-runtime.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { build } = createRequire(path.join(root, "electron/package.json"))(
  "esbuild",
);

export async function buildDevResources(backendDir) {
  copyNativeLockRuntime(backendDir);
  const pythonDir = path.join(backendDir, "ios-simulators");
  await fs.mkdir(pythonDir, { recursive: true });
  for (const file of ["monitor.py", "pool.py", "device_shutdown.py"]) {
    await fs.copyFile(
      path.join(root, "scripts/ios-simulators", file),
      path.join(pythonDir, file),
    );
  }
  await build({
    entryPoints: [path.join(root, "scripts/dev-resources/control.mjs")],
    outfile: path.join(backendDir, "dev-resources/control.cjs"),
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    external: ["fs-native-extensions"],
    define: { "import.meta.url": "__IMPORT_META_URL__" },
    banner: {
      js: "const __IMPORT_META_URL__ = require('url').pathToFileURL(__filename).href;",
    },
    plugins: [
      {
        name: "static-configuration-library",
        setup(builder) {
          builder.onLoad(
            { filter: /scripts[/\\]lib[/\\]configuration\.mjs$/ },
            () => ({
              contents: `import * as configurationLibrary from ${JSON.stringify(path.join(root, "packages/config-node/src/index.ts"))};
          export { configurationLibrary };
          export function explicitConfigurationArguments() { return configurationLibrary.configurationArguments(configurationLibrary.resolveConfigurationContext({ requireExplicit: true })); }`,
              loader: "js",
              resolveDir: root,
            }),
          );
        },
      },
    ],
  });
}
