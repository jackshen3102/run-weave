import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ELECTRON_DIR = path.resolve(SCRIPT_DIR, "..");
const SOURCE = path.join(
  ELECTRON_DIR,
  "native",
  "companion",
  "RunweaveCompanion.swift",
);
const APP_NAME = "Runweave Companion.app";
const EXECUTABLE_NAME = "Runweave Companion";

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ELECTRON_DIR,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed (${signal ?? code})`));
    });
  });
}

export async function buildCompanionAgent(outputDir) {
  const destination = path.resolve(ELECTRON_DIR, outputDir, "companion");
  await rm(destination, { force: true, recursive: true });
  if (process.platform !== "darwin") {
    console.log("[companion] native macOS agent skipped on non-macOS host");
    return;
  }

  const packageJson = JSON.parse(
    await readFile(path.join(ELECTRON_DIR, "package.json"), "utf8"),
  );
  const version =
    process.env.RUNWEAVE_ELECTRON_BUILD_VERSION ?? packageJson.version;
  const appRoot = path.join(destination, APP_NAME);
  const contents = path.join(appRoot, "Contents");
  const macOSDir = path.join(contents, "MacOS");
  await mkdir(macOSDir, { recursive: true });
  const executable = path.join(macOSDir, EXECUTABLE_NAME);
  await run("xcrun", [
    "swiftc",
    SOURCE,
    "-o",
    executable,
    "-O",
    "-parse-as-library",
    "-swift-version",
    "5",
    "-target",
    "arm64-apple-macos13.0",
    "-framework",
    "AppKit",
    "-framework",
    "WebKit",
  ]);
  await chmod(executable, 0o755);
  await writeFile(
    path.join(contents, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>Runweave Companion</string>
  <key>CFBundleExecutable</key>
  <string>${EXECUTABLE_NAME}</string>
  <key>CFBundleIdentifier</key>
  <string>com.runweave.desktop.companion</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Runweave Companion</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleVersion</key>
  <string>${version}</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`,
    "utf8",
  );
  console.log(`[companion] built ${appRoot}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await buildCompanionAgent(process.argv[2] ?? "dist");
}
