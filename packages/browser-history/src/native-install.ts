import {
  copyFile,
  chmod,
  mkdir,
  readFile,
  writeFile,
  unlink,
  access,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { HISTORY_HOST } from "@runweave/shared/browser-history";
import { privateDirectory, privateJson, snapshot } from "./files.js";
const shell = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
export async function nativeInstall(options: {
  browser: string;
  id?: string;
  root: string;
  home?: string;
  uninstall?: boolean;
}) {
  if (process.platform !== "darwin") throw Error("MACOS_INSTALL_ONLY");
  if (!["chrome", "edge"].includes(options.browser))
    throw Error("INVALID_BROWSER");
  const home = options.home ?? os.homedir(),
    runtime = path.join(options.root, "runtime");
  const browserDir =
    options.browser === "chrome" ? "Google/Chrome" : "Microsoft Edge";
  const manifest = path.join(
    home,
    "Library/Application Support",
    browserDir,
    "NativeMessagingHosts",
    HISTORY_HOST + ".json",
  );
  const launcher = path.join(runtime, "native-host-" + options.browser);
  if (options.uninstall) {
    const old = JSON.parse((await snapshot(manifest)).toString());
    if (old.name !== HISTORY_HOST || old.path !== launcher)
      throw Error("FOREIGN_HOST_MANIFEST");
    await unlink(manifest);
    await unlink(launcher);
    await unlink(
      path.join(runtime, options.browser + ".installation.json"),
    ).catch(() => undefined);
    const other = path.join(
      runtime,
      "native-host-" + (options.browser === "chrome" ? "edge" : "chrome"),
    );
    try {
      await access(other);
    } catch {
      await unlink(path.join(runtime, "native-host.cjs")).catch(
        () => undefined,
      );
    }
    return { uninstalled: options.browser, dataPreserved: true };
  }
  if (!/^[a-p]{32}$/.test(options.id ?? ""))
    throw Error("ACTUAL_EXTENSION_ID_REQUIRED");
  try {
    const existing = JSON.parse(await readFile(manifest, "utf8"));
    if (existing.path !== launcher || existing.name !== HISTORY_HOST)
      throw Error("FOREIGN_HOST_MANIFEST");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const node = process.execPath;
  const version = execFileSync(node, ["--version"], {
    encoding: "utf8",
  }).trim();
  if (Number(version.replace(/^v/, "").split(".")[0]) < 22)
    throw Error("NODE_22_REQUIRED");
  await privateDirectory(options.root);
  await privateDirectory(runtime);
  const host = path.join(runtime, "native-host.cjs");
  // This CLI is bundled beside native-host.cjs; copy before registering any manifest.
  const builtHost = path.join(
    path.dirname(process.argv[1]!),
    "native-host.cjs",
  );
  if (path.resolve(builtHost) !== path.resolve(host))
    await copyFile(builtHost, host);
  await chmod(host, 0o600);
  const text = `#!/bin/sh\nexec ${shell(node)} ${shell(host)} --root ${shell(path.resolve(options.root))} --browser ${shell(options.browser)} --allowed-id ${shell(options.id!)} "$@"\n`;
  await writeFile(launcher, text, { mode: 0o700 });
  await chmod(launcher, 0o700);
  await mkdir(path.dirname(manifest), { recursive: true });
  await privateJson(manifest, {
    name: HISTORY_HOST,
    description: "Runweave local browsing history",
    path: launcher,
    type: "stdio",
    allowed_origins: [`chrome-extension://${options.id}/`],
  });
  await privateJson(
    path.join(runtime, options.browser + ".installation.json"),
    {
      browser: options.browser,
      node,
      version,
      manifest,
      extensionId: options.id,
      root: path.resolve(options.root),
    },
  );
  return {
    installed: options.browser,
    manifest,
    launcher,
    node,
    root: path.resolve(options.root),
  };
}
