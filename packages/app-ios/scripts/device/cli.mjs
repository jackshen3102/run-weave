import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { DeviceError, root } from "./support.mjs";
import { preflight } from "./preflight.mjs";
import { runBatch, status } from "./run.mjs";

export async function deviceCLI(args) {
  let phase = "arguments";
  const json = args.includes("--json");
  const print = (value) =>
    console.log(json ? JSON.stringify(value) : JSON.stringify(value, null, 2));
  try {
    const [command, ...raw] = args;
    if (!["doctor", "run", "status"].includes(command))
      throw new Error("Expected device doctor|run|status");
    const options = { configuration: "Debug" };
    const allowed =
      command === "status"
        ? ["run"]
        : command === "doctor"
          ? ["device", "team"]
          : ["device", "team", "suite", "configuration", "runner-bundle-id"];
    const seen = new Set();
    for (let i = 0; i < raw.length; i += 1) {
      if (raw[i] === "--json") continue;
      const key = raw[i].slice(2);
      if (
        !raw[i].startsWith("--") ||
        !allowed.includes(key) ||
        seen.has(key) ||
        !raw[i + 1] ||
        raw[i + 1].startsWith("--")
      )
        throw new Error(`Invalid option ${raw[i]}`);
      options[key] = raw[++i];
      seen.add(key);
    }
    if (command === "status") {
      if (!/^[0-9a-f-]{36}$/.test(options.run || ""))
        throw new Error("Explicit --run UUID is required");
      phase = "status";
      const result = status(options.run);
      print(result);
      return result.state === "unknown" ? 5 : result.exitCode || 0;
    }
    if (!/^[A-Za-z0-9-]{8,64}$/.test(options.device || ""))
      throw new Error(
        "Explicit --device hardware UDID is required (not a name or CoreDevice alias)",
      );
    if (options.team && !/^[A-Z0-9]{10}$/.test(options.team))
      throw new Error("Invalid --team");
    if (!["Debug", "Profile"].includes(options.configuration))
      throw new Error("Device runner supports Debug and Profile only");
    if (command === "run" && !options.suite)
      throw new Error("Explicit --suite directory is required");
    options.runnerBundleID =
      options["runner-bundle-id"] || "com.runweave.device-runner";
    if (
      !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+){2,}$/.test(options.runnerBundleID) ||
      options.runnerBundleID.endsWith(".xctrunner")
    )
      throw new Error(
        "--runner-bundle-id must be a runner base Bundle ID, without the .xctrunner suffix",
      );
    phase = "checking";
    if (process.platform !== "darwin")
      throw new DeviceError(
        "toolchain_unavailable",
        "checking",
        "Use macOS with Xcode",
        3,
      );
    if (command === "doctor") {
      const data = await preflight(
        options,
        resolve(root, "diagnostics", randomUUID()),
      );
      print(data);
      return data.state === "blocked" ? 3 : 0;
    }
    const result = await runBatch(options);
    print(result.data);
    return result.exitCode;
  } catch (error) {
    print({
      schemaVersion: 1,
      state: "blocked",
      error: {
        phase: error.phase || phase,
        reason:
          error.reason ||
          (phase === "arguments" ? "invalid_arguments" : "runner_failed"),
        message: error.message,
        evidencePath: error.evidencePath,
      },
      nextAction:
        error.nextAction ||
        "Use device doctor --device <UDID>, run --device <UDID> --suite <directory>, or status --run <UUID>",
    });
    return error.exitCode || (phase === "arguments" ? 2 : 5);
  }
}
