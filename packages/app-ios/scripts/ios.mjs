import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(pkg, "../..");
const buildRoot = resolve(repo, ".runweave/ios-native-build");
const project = resolve(pkg, "ios/RunweaveNative.xcodeproj");
const lock = resolve(
  project,
  "project.xcworkspace/xcshareddata/swiftpm/Package.resolved",
);
const [command, ...raw] = process.argv.slice(2);
const args = raw.filter((arg) => arg !== "--");
function run(program, argv, capture = false) {
  const result = spawnSync(program, argv, {
    cwd: repo,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.error || result.status !== 0) {
    if (capture) process.stderr.write(result.stderr || "");
    throw result.error || new Error(`${program} exited ${result.status}`);
  }
  return result.stdout;
}
function options() {
  const result = { configuration: "Debug" };
  for (let i = 0; i < args.length; i += 2) {
    if (!["--simulator", "--configuration"].includes(args[i]) || !args[i + 1]) {
      throw new Error(
        "Usage: ios:build|ios:run -- --simulator <UDID> [--configuration Debug|Profile|Release]",
      );
    }
    result[args[i].slice(2)] = args[i + 1];
  }
  if (!["Debug", "Profile", "Release"].includes(result.configuration))
    throw new Error("Unknown configuration");
  return result;
}
try {
  if (process.platform !== "darwin")
    throw new Error("iOS builds require macOS and Xcode");
  const flags = [
    "-project",
    project,
    "-scheme",
    "RunweaveNative",
    "-derivedDataPath",
    resolve(buildRoot, "DerivedData"),
    "-clonedSourcePackagesDirPath",
    resolve(buildRoot, "SourcePackages"),
    "-packageCachePath",
    resolve(buildRoot, "PackageCache"),
  ];
  if (command === "doctor") {
    run("xcodebuild", ["-version"]);
    run("xcodebuild", ["-showsdks"]);
    run("xcrun", ["simctl", "list", "runtimes"]);
    run("xcodebuild", [...flags, "-showdestinations"]);
    console.log(
      existsSync(lock)
        ? readFileSync(lock, "utf8")
        : "Package.resolved: not resolved yet",
    );
  } else {
    if (!["build", "run"].includes(command))
      throw new Error("Expected doctor, build, or run");
    const { simulator, configuration } = options();
    if (!simulator) throw new Error("An explicit --simulator UDID is required");
    const devices = JSON.parse(
      run("xcrun", ["simctl", "list", "devices", "available", "--json"], true),
    );
    const device = Object.values(devices.devices)
      .flat()
      .find((item) => item.udid === simulator);
    if (!device)
      throw new Error("Simulator is not available in the installed runtimes");
    const app = resolve(
      buildRoot,
      `DerivedData/Build/Products/${configuration}-iphonesimulator/RunweaveNative.app`,
    );
    if (command === "build") {
      mkdirSync(buildRoot, { recursive: true });
      run("xcodebuild", [
        ...flags,
        "-configuration",
        configuration,
        "-destination",
        `platform=iOS Simulator,id=${simulator}`,
        "CODE_SIGNING_ALLOWED=YES",
        "CODE_SIGN_IDENTITY=-",
        "build",
      ]);
      if (!existsSync(app))
        throw new Error("Build completed without expected app product");
      console.log(`APP_PATH=${app}`);
    } else {
      if (!existsSync(app))
        throw new Error("Build this configuration before installing");
      if (device.state !== "Booted")
        run("xcrun", ["simctl", "boot", simulator]);
      run("xcrun", ["simctl", "bootstatus", simulator, "-b"]);
      run("xcrun", ["simctl", "install", simulator, app]);
      run("xcrun", ["simctl", "launch", simulator, "com.runweave.app.native"]);
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
