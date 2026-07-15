export function parseRunweaveUpdateArgs(argv) {
  const result = {
    appPath: null,
    appServerHome: null,
    appServerMode: "auto",
    dryRun: false,
    mode: "auto",
    noRestart: false,
    runtimeHome: null,
    sourceRoot: process.cwd(),
    statePath: null,
    verifyDesktop: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = (name) => {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${name} requires a value`);
      }
      index += 1;
      return value;
    };

    if (arg === "--dry-run") {
      result.dryRun = true;
      continue;
    }
    if (arg === "--no-restart") {
      result.noRestart = true;
      continue;
    }
    if (arg === "--verify-desktop") {
      result.verifyDesktop = true;
      continue;
    }
    if (arg === "--mode") {
      result.mode = readValue("--mode");
      continue;
    }
    if (arg.startsWith("--mode=")) {
      result.mode = arg.slice("--mode=".length);
      continue;
    }
    if (arg === "--app-server") {
      result.appServerMode = readValue("--app-server");
      continue;
    }
    if (arg.startsWith("--app-server=")) {
      result.appServerMode = arg.slice("--app-server=".length);
      continue;
    }
    if (arg === "--app-server-home") {
      result.appServerHome = readValue("--app-server-home");
      continue;
    }
    if (arg.startsWith("--app-server-home=")) {
      result.appServerHome = arg.slice("--app-server-home=".length);
      continue;
    }
    if (arg === "--repo" || arg === "--source-root") {
      result.sourceRoot = readValue(arg);
      continue;
    }
    if (arg.startsWith("--repo=")) {
      result.sourceRoot = arg.slice("--repo=".length);
      continue;
    }
    if (arg.startsWith("--source-root=")) {
      result.sourceRoot = arg.slice("--source-root=".length);
      continue;
    }
    if (arg === "--app-path") {
      result.appPath = readValue("--app-path");
      continue;
    }
    if (arg.startsWith("--app-path=")) {
      result.appPath = arg.slice("--app-path=".length);
      continue;
    }
    if (arg === "--runtime-home") {
      result.runtimeHome = readValue("--runtime-home");
      continue;
    }
    if (arg.startsWith("--runtime-home=")) {
      result.runtimeHome = arg.slice("--runtime-home=".length);
      continue;
    }
    if (arg === "--state-path") {
      result.statePath = readValue("--state-path");
      continue;
    }
    if (arg.startsWith("--state-path=")) {
      result.statePath = arg.slice("--state-path=".length);
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return result;
}
