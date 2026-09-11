import { execFile } from "node:child_process";
import { parseMacBattery } from "@runweave/shared/battery";
import type { DeviceBattery } from "@runweave/shared/device-status";

export type BatterySampler = (
  signal: AbortSignal,
) => Promise<DeviceBattery | null>;

export const sampleBattery: BatterySampler = async (signal) => {
  if (process.platform !== "darwin") return null;
  // pmset provides all fields used by the mobile contract; no need to read the full ioreg tree.
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      "/usr/bin/pmset",
      ["-g", "batt"],
      {
        timeout: 3_000,
        maxBuffer: 64 * 1024,
        signal,
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
  return parseMacBattery(output);
};
