import { existsSync, statSync } from "node:fs";
import type {
  AppServerThreadDetailStatus,
  AppServerThreadRef,
} from "@runweave/shared/app-server-events";

export function normalizeDetailStatus(
  status: AppServerThreadRef["status"],
): AppServerThreadDetailStatus {
  if (status === "running" || status === "starting") return "active";
  if (status === "failed") return "systemError";
  if (status === "idle" || status === "completed") return "idle";
  return "notLoaded";
}

export function normalizeDate(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const date = new Date(typeof value === "number" ? value * 1_000 : value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

export function readMtimeMs(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

export function isExecutableFile(filePath: string): boolean {
  try {
    return existsSync(filePath) && statSync(filePath).isFile();
  } catch {
    return false;
  }
}
