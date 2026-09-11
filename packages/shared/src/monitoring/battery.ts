import { unknownBattery, type DeviceBattery } from "./device-status";

/** Parses only a successful pmset response; failure is not proof of an absent battery. */
export function parseMacBattery(output: string): DeviceBattery {
  const source = /Now drawing from '([^']+)'/i.exec(output)?.[1];
  if (!source) throw new Error("Invalid power source response");
  const powerSource =
    source === "AC Power"
      ? "ac"
      : source === "Battery Power"
        ? "battery"
        : "unknown";
  const line = output
    .split("\n")
    .find((value) => /InternalBattery/i.test(value));
  if (!line) return { ...unknownBattery(), presence: "absent", powerSource };
  const match = /(?:^|\s)(\d+)%;\s*([^;]+);/i.exec(line);
  const percent = match ? Number(match[1]) : NaN;
  if (!Number.isInteger(percent) || percent < 0 || percent > 100)
    throw new Error("Invalid battery percentage");
  const state = match?.[2]?.trim().toLowerCase();
  const chargeState =
    state === "charging"
      ? "charging"
      : state === "discharging"
        ? "discharging"
        : state === "charged"
          ? "full"
          : state === "not charging" || state === "finishing charge"
            ? "not_charging"
            : "unknown";
  const time = /(\d+):(\d+)\s+remaining/i.exec(line);
  return {
    presence: "present",
    percent,
    powerSource,
    chargeState,
    remainingMinutes:
      time && chargeState === "discharging"
        ? Number(time[1]) * 60 + Number(time[2])
        : null,
  };
}
