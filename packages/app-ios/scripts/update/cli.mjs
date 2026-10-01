import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { command, readJSON } from "../device/support.mjs";
import { readTarget, validVersion } from "./state.mjs";
import { update } from "./pipeline.mjs";

const help = `Runweave iOS update (macOS + Xcode)
  pnpm ios:update --devices
  pnpm ios:update --device <hardware-UDID> --team <TEAM_ID> --save-target
  pnpm ios:update
Options: --configuration Debug|Profile|Release (default Release)
         --version X.Y.Z --dry-run --json --help
Builds current disk sources, installs and launches. No XCTest or Agent required.`;

export async function updateCLI(args) {
  let phase = "arguments";
  const json = args.includes("--json");
  const print = (result) =>
    console.log(JSON.stringify(result, null, json ? undefined : 2));
  try {
    const options = {},
      seen = new Set();
    for (let i = 0; i < args.length; i++) {
      const key = args[i].replace(/^--/, "");
      if (!args[i].startsWith("--") || seen.has(key))
        throw new Error(`Invalid option ${args[i]}`);
      seen.add(key);
      if (["devices", "save-target", "dry-run", "json", "help"].includes(key))
        options[key] = true;
      else if (
        ["device", "team", "configuration", "version"].includes(key) &&
        args[i + 1] &&
        !args[i + 1].startsWith("--")
      )
        options[key] = args[++i];
      else throw new Error(`Invalid option ${args[i]}`);
    }
    if (options.help) {
      if (json) print({ help });
      else console.log(help);
      return 0;
    }
    if (process.platform !== "darwin")
      throw Object.assign(new Error("macOS with Xcode is required"), {
        exitCode: 3,
      });
    if (options.devices) {
      if (seen.size > (json ? 2 : 1))
        throw new Error("--devices only accepts --json");
      const dir = mkdtempSync(resolve(tmpdir(), "runweave-ios-devices-"));
      try {
        const file = resolve(dir, "devices.json");
        const result = await command(
          "xcrun",
          [
            "devicectl",
            "list",
            "devices",
            "--timeout",
            "15",
            "--json-output",
            file,
          ],
          { dir, name: "devices", timeout: 20000 },
        );
        if (!result.ok)
          throw Object.assign(
            new Error("Cannot list devices; check Xcode and pairing"),
            { exitCode: 3 },
          );
        const data = readJSON(file);
        if (data.info?.outcome !== "success")
          throw Object.assign(new Error("Device discovery failed"), {
            exitCode: 3,
          });
        print({
          devices: data.result.devices.map((d) => ({
            device: d.hardwareProperties?.udid,
            name: d.deviceProperties?.name,
            model: d.hardwareProperties?.marketingName,
            pairing: d.connectionProperties?.pairingState,
            transport: d.connectionProperties?.transportType ?? null,
            state: d.connectionProperties?.tunnelState,
            developerMode: d.deviceProperties?.developerModeStatus,
          })),
        });
        return 0;
      } finally {
        rmSync(dir, { recursive: true });
      }
    }
    const saved = readTarget();
    // A different explicitly selected phone must not inherit another phone's signing defaults.
    const useSaved =
      !options.device || options.device.toUpperCase() === saved.device;
    options.device = (options.device || saved.device || "").toUpperCase();
    options.team ||= useSaved ? saved.team : undefined;
    options.configuration ||=
      (useSaved ? saved.configuration : undefined) || "Release";
    if (!/^[A-F0-9]{8}-[A-F0-9]{16}$/.test(options.device))
      throw new Error(
        "Select a hardware UDID with --device (see pnpm ios:update --devices)",
      );
    if (options.team && !/^[A-Z0-9]{10}$/.test(options.team))
      throw new Error("Invalid --team");
    if (!["Debug", "Profile", "Release"].includes(options.configuration))
      throw new Error("Invalid --configuration");
    if (options.version && !validVersion(options.version))
      throw new Error("Invalid --version; expected X.Y.Z");
    if (options["save-target"] && !seen.has("device"))
      throw new Error("--save-target requires an explicit --device");
    phase = "update";
    const result = await update(options);
    print(result);
    return result.exitCode;
  } catch (error) {
    print({
      schemaVersion: 1,
      state: "blocked",
      error: {
        phase,
        reason: phase === "arguments" ? "invalid_arguments" : "update_failed",
        message: error.message,
      },
      nextAction: "Run pnpm ios:update --help",
      exitCode: error.exitCode || (phase === "arguments" ? 2 : 3),
    });
    return error.exitCode || (phase === "arguments" ? 2 : 3);
  }
}
