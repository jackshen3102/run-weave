const MINUTE_MS = 60_000;
const MAX_SEARCH_MINUTES = 5 * 366 * 24 * 60;

interface CronField {
  any: boolean;
  values: Set<number>;
}

interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

interface ZonedMinute {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
}

const WEEKDAYS = new Map([
  ["Sun", 0],
  ["Mon", 1],
  ["Tue", 2],
  ["Wed", 3],
  ["Thu", 4],
  ["Fri", 5],
  ["Sat", 6],
]);

export function validateCronExpression(expression: string): void {
  parseCronExpression(expression);
}

export function nextCronOccurrence(
  expression: string,
  timezone: string,
  after: Date,
): Date {
  const cron = parseCronExpression(expression);
  const formatter = createFormatter(timezone);
  let timestamp =
    Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (let index = 0; index < MAX_SEARCH_MINUTES; index += 1) {
    if (matchesCron(cron, toZonedMinute(formatter, timestamp))) {
      return new Date(timestamp);
    }
    timestamp += MINUTE_MS;
  }
  throw new Error("evolution_schedule_next_due_not_found");
}

export function latestCronOccurrenceAtOrBefore(
  expression: string,
  timezone: string,
  atOrBefore: Date,
): Date {
  const cron = parseCronExpression(expression);
  const formatter = createFormatter(timezone);
  let timestamp = Math.floor(atOrBefore.getTime() / MINUTE_MS) * MINUTE_MS;
  for (let index = 0; index < MAX_SEARCH_MINUTES; index += 1) {
    if (matchesCron(cron, toZonedMinute(formatter, timestamp))) {
      return new Date(timestamp);
    }
    timestamp -= MINUTE_MS;
  }
  throw new Error("evolution_schedule_previous_due_not_found");
}

function parseCronExpression(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/u);
  if (fields.length !== 5) {
    throw new Error("evolution_schedule_cron_invalid");
  }
  return {
    minute: parseField(fields[0] ?? "", 0, 59),
    hour: parseField(fields[1] ?? "", 0, 23),
    dayOfMonth: parseField(fields[2] ?? "", 1, 31),
    month: parseField(fields[3] ?? "", 1, 12),
    dayOfWeek: parseField(fields[4] ?? "", 0, 7, true),
  };
}

function parseField(
  source: string,
  minimum: number,
  maximum: number,
  normalizeSunday = false,
): CronField {
  const values = new Set<number>();
  const tokens = source.split(",");
  if (tokens.length === 0 || tokens.some((token) => token.length === 0)) {
    throw new Error("evolution_schedule_cron_invalid");
  }
  for (const token of tokens) {
    addTokenValues(values, token, minimum, maximum, normalizeSunday);
  }
  if (values.size === 0) throw new Error("evolution_schedule_cron_invalid");
  return { any: source === "*", values };
}

function addTokenValues(
  target: Set<number>,
  token: string,
  minimum: number,
  maximum: number,
  normalizeSunday: boolean,
): void {
  const [rangeSource, stepSource, extra] = token.split("/");
  if (extra !== undefined || !rangeSource) {
    throw new Error("evolution_schedule_cron_invalid");
  }
  const step = stepSource === undefined ? 1 : parseInteger(stepSource);
  if (step < 1) throw new Error("evolution_schedule_cron_invalid");

  let start: number;
  let end: number;
  if (rangeSource === "*") {
    start = minimum;
    end = maximum;
  } else if (rangeSource.includes("-")) {
    const parts = rangeSource.split("-");
    if (parts.length !== 2) throw new Error("evolution_schedule_cron_invalid");
    start = parseInteger(parts[0] ?? "");
    end = parseInteger(parts[1] ?? "");
  } else {
    start = parseInteger(rangeSource);
    end = start;
  }
  if (start < minimum || end > maximum || start > end) {
    throw new Error("evolution_schedule_cron_invalid");
  }
  for (let value = start; value <= end; value += step) {
    target.add(normalizeSunday && value === 7 ? 0 : value);
  }
}

function parseInteger(value: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new Error("evolution_schedule_cron_invalid");
  }
  return Number(value);
}

function createFormatter(timezone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
  } catch {
    throw new Error("evolution_schedule_timezone_invalid");
  }
}

function toZonedMinute(
  formatter: Intl.DateTimeFormat,
  timestamp: number,
): ZonedMinute {
  const parts = new Map(
    formatter
      .formatToParts(timestamp)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const weekday = WEEKDAYS.get(parts.get("weekday") ?? "");
  if (weekday === undefined) {
    throw new Error("evolution_schedule_timezone_invalid");
  }
  return {
    minute: Number(parts.get("minute")),
    hour: Number(parts.get("hour")),
    dayOfMonth: Number(parts.get("day")),
    month: Number(parts.get("month")),
    dayOfWeek: weekday,
  };
}

function matchesCron(cron: ParsedCron, value: ZonedMinute): boolean {
  if (
    !cron.minute.values.has(value.minute) ||
    !cron.hour.values.has(value.hour) ||
    !cron.month.values.has(value.month)
  ) {
    return false;
  }
  const dayOfMonthMatches = cron.dayOfMonth.values.has(value.dayOfMonth);
  const dayOfWeekMatches = cron.dayOfWeek.values.has(value.dayOfWeek);
  if (cron.dayOfMonth.any) return cron.dayOfWeek.any || dayOfWeekMatches;
  if (cron.dayOfWeek.any) return dayOfMonthMatches;
  return dayOfMonthMatches || dayOfWeekMatches;
}
