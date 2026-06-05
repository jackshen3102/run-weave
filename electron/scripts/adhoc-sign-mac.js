import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";

export default async function adhocSignMac(context) {
  if (
    process.platform !== "darwin" ||
    context.electronPlatformName !== "darwin"
  ) {
    return;
  }

  const appName = readdirSync(context.appOutDir).find((entry) =>
    entry.endsWith(".app"),
  );
  if (!appName) {
    throw new Error(`No .app bundle found in ${context.appOutDir}`);
  }

  const appPath = path.join(context.appOutDir, appName);
  execFileSync("xattr", ["-cr", appPath], { stdio: "inherit" });
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
    stdio: "inherit",
  });
}
