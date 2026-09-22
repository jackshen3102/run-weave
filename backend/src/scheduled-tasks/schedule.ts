import type { TaskSchedule } from "@runweave/shared/scheduled-tasks";

const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_SEARCH_DAYS = 370;
const LOCAL_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

export class ScheduleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleValidationError";
  }
}

export function validateSchedule(schedule: TaskSchedule): void {
  assertTimezone(schedule.timezone);
  if (schedule.kind === "once") {
    const runAt = Date.parse(schedule.runAt);
    if (!Number.isFinite(runAt) || !schedule.runAt.endsWith("Z")) {
      throw new ScheduleValidationError("runAt must be a UTC ISO timestamp");
    }
    return;
  }
  if (!LOCAL_TIME.test(schedule.localTime)) {
    throw new ScheduleValidationError("localTime must use HH:mm");
  }
  if (schedule.kind === "weekly") {
    const unique = new Set(schedule.weekdays);
    if (unique.size === 0 || unique.size !== schedule.weekdays.length) {
      throw new ScheduleValidationError(
        "weekly weekdays must be non-empty and unique",
      );
    }
    if (
      [...unique].some((day) => !Number.isInteger(day) || day < 0 || day > 6)
    ) {
      throw new ScheduleValidationError(
        "weekdays must be integers from 0 through 6",
      );
    }
  }
}

export function nextOccurrences(
  schedule: TaskSchedule,
  after: Date,
  limit = 3,
): string[] {
  validateSchedule(schedule);
  if (!Number.isFinite(after.getTime()) || limit < 1) {
    throw new ScheduleValidationError("invalid occurrence search");
  }
  if (schedule.kind === "once") {
    const runAt = new Date(schedule.runAt);
    return runAt.getTime() > after.getTime() ? [runAt.toISOString()] : [];
  }

  const [hour, minute] = schedule.localTime.split(":").map(Number) as [
    number,
    number,
  ];
  const localNow = localParts(after.getTime(), schedule.timezone);
  const cursor = new Date(
    Date.UTC(localNow.year, localNow.month - 1, localNow.day),
  );
  const results: string[] = [];
  for (
    let offset = 0;
    offset <= MAX_SEARCH_DAYS && results.length < limit;
    offset += 1
  ) {
    const date = new Date(cursor.getTime() + offset * DAY_MS);
    const weekday = date.getUTCDay();
    const eligible =
      schedule.kind === "daily" ||
      (schedule.kind === "weekdays" && weekday >= 1 && weekday <= 5) ||
      (schedule.kind === "weekly" && schedule.weekdays.includes(weekday));
    if (!eligible) continue;
    const occurrence = resolveLocalMinute(
      {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        hour,
        minute,
      },
      schedule.timezone,
    );
    // Non-existent DST minutes are deliberately skipped. Ambiguous minutes resolve
    // to the first occurrence in resolveLocalMinute.
    if (occurrence !== null && occurrence > after.getTime()) {
      results.push(new Date(occurrence).toISOString());
    }
  }
  return results;
}

function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
  } catch {
    throw new ScheduleValidationError("invalid IANA timezone");
  }
}

interface LocalMinute {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function resolveLocalMinute(
  target: LocalMinute,
  timezone: string,
): number | null {
  const naive = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute,
  );
  const sampleTimes = [
    naive,
    naive - DAY_MS,
    naive + DAY_MS,
    naive - DAY_MS / 2,
    naive + DAY_MS / 2,
  ];
  const offsets = new Set(
    sampleTimes.map((time) => timezoneOffsetAt(time, timezone)),
  );
  const matches = [...offsets]
    .map((offset) => naive - offset)
    .filter((candidate) =>
      sameLocalMinute(localParts(candidate, timezone), target),
    )
    .sort((left, right) => left - right);
  return matches[0] ?? null;
}

function timezoneOffsetAt(epochMs: number, timezone: string): number {
  const value = localParts(epochMs, timezone);
  const representedAsUtc = Date.UTC(
    value.year,
    value.month - 1,
    value.day,
    value.hour,
    value.minute,
  );
  return representedAsUtc - Math.floor(epochMs / 60_000) * 60_000;
}

function sameLocalMinute(left: LocalMinute, right: LocalMinute): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute
  );
}

function localParts(epochMs: number, timezone: string): LocalMinute {
  const formatter = new Intl.DateTimeFormat("en-US-u-ca-iso8601", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date(epochMs))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour!,
    minute: parts.minute!,
  };
}
