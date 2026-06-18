import DailyRotateFile from "winston-daily-rotate-file";
import winston from "winston";
import { resolveStoragePaths } from "../utils/path";
import { getRequestLogContext } from "./request-context";
import { redactValue, serializeError } from "./redaction";

type LogLevel = "debug" | "info" | "warn" | "error";
type LegacyConsoleLevel = "warn" | "error";

interface LegacyConsoleFields {
  method: LegacyConsoleLevel;
  message: string;
  meta: Record<string, unknown>;
}

export interface LogFields extends Record<string, unknown> {
  message?: string;
  error?: unknown;
  legacyConsole?: LegacyConsoleFields;
}

export interface LoggerDefaults extends Record<string, unknown> {
  component?: string;
}

export interface BackendLogger {
  child(defaults: LoggerDefaults): BackendLogger;
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

interface CreateLoggerOptions {
  env?: NodeJS.ProcessEnv;
  defaultFields?: LoggerDefaults;
}

interface InitializedLogger {
  logger: BackendLogger;
  logDir: string;
  logToFile: boolean;
}

const jsonLineFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.printf((record) => {
    const { level, message, timestamp, ...rest } = record;
    return JSON.stringify({
      timestamp,
      level,
      event: rest.event,
      ...rest,
      message,
    });
  }),
);

function resolveLogLevel(env: NodeJS.ProcessEnv): string {
  return env.RUNWEAVE_LOG_LEVEL?.trim() || "info";
}

function resolveLogToFile(env: NodeJS.ProcessEnv): boolean {
  return env.RUNWEAVE_LOG_TO_FILE?.trim().toLowerCase() !== "false";
}

function shouldWriteLegacyConsole(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === "test" || env.VITEST === "true";
}

function writeLegacyConsole(fields: LegacyConsoleFields | undefined): void {
  if (!fields || !shouldWriteLegacyConsole(process.env)) {
    return;
  }

  const write = globalThis.console[fields.method];
  if (typeof write === "function") {
    write.call(globalThis.console, fields.message, fields.meta);
  }
}

function buildTransports(env: NodeJS.ProcessEnv): winston.transport[] {
  const storagePaths = resolveStoragePaths(env);
  const transports: winston.transport[] = [
    makeResilientTransport(
      new winston.transports.Console({
        level: "error",
      }),
      "console",
    ),
  ];

  if (resolveLogToFile(env)) {
    transports.push(
      makeResilientTransport(
        new DailyRotateFile({
          dirname: storagePaths.backendLogDir,
          filename: "backend-%DATE%.jsonl",
          datePattern: "YYYY-MM-DD",
          maxFiles: "3d",
          maxSize: "50m",
          zippedArchive: false,
          level: resolveLogLevel(env),
        }),
        "file",
      ),
    );
  }

  return transports;
}

function makeResilientTransport<T extends winston.transport>(
  transport: T,
  name: string,
): T {
  let reportedFailure = false;
  transport.on("error", (error: unknown) => {
    (transport as T & { silent?: boolean }).silent = true;
    if (reportedFailure) {
      return;
    }
    reportedFailure = true;
    const serializedError = serializeError(error);
    try {
      process.stderr.write(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "error",
          event: "backend.logger.transport.disabled",
          transport: name,
          error: serializedError,
          message: "Backend logger transport disabled after write failure",
        }) + "\n",
      );
    } catch {
      // Ignore secondary logging failures; the logger must not crash the backend.
    }
  });
  return transport;
}

class WinstonBackendLogger implements BackendLogger {
  constructor(
    private readonly winstonLogger: winston.Logger,
    private readonly defaults: LoggerDefaults = {},
  ) {}

  child(defaults: LoggerDefaults): BackendLogger {
    return new WinstonBackendLogger(this.winstonLogger, {
      ...this.defaults,
      ...defaults,
    });
  }

  debug(event: string, fields: LogFields = {}): void {
    this.write("debug", event, fields);
  }

  info(event: string, fields: LogFields = {}): void {
    this.write("info", event, fields);
  }

  warn(event: string, fields: LogFields = {}): void {
    this.write("warn", event, fields);
  }

  error(event: string, fields: LogFields = {}): void {
    this.write("error", event, fields);
  }

  private write(level: LogLevel, event: string, fields: LogFields): void {
    const { error, legacyConsole, message, ...restFields } = fields;
    const record = {
      ...getRequestLogContext(),
      ...this.defaults,
      ...restFields,
      event,
      ...(error === undefined ? {} : { error: serializeError(error) }),
    };
    const redactedRecord = redactValue(record) as Record<string, unknown>;
    this.winstonLogger.log({
      level,
      message: message ?? event,
      ...redactedRecord,
    });
    writeLegacyConsole(legacyConsole);
  }
}

function createWinstonLogger(env: NodeJS.ProcessEnv): winston.Logger {
  return winston.createLogger({
    level: resolveLogLevel(env),
    format: jsonLineFormat,
    transports: buildTransports(env),
    exitOnError: false,
  });
}

let activeWinstonLogger = winston.createLogger({
  level: "info",
  format: jsonLineFormat,
  transports: [new winston.transports.Console({ level: "error" })],
  exitOnError: false,
});
let activeLogger: BackendLogger = new WinstonBackendLogger(activeWinstonLogger);

function createDynamicLogger(defaults: LoggerDefaults = {}): BackendLogger {
  return {
    child(nextDefaults: LoggerDefaults): BackendLogger {
      return createDynamicLogger({ ...defaults, ...nextDefaults });
    },
    debug(event: string, fields?: LogFields): void {
      activeLogger.child(defaults).debug(event, fields);
    },
    info(event: string, fields?: LogFields): void {
      activeLogger.child(defaults).info(event, fields);
    },
    warn(event: string, fields?: LogFields): void {
      activeLogger.child(defaults).warn(event, fields);
    },
    error(event: string, fields?: LogFields): void {
      activeLogger.child(defaults).error(event, fields);
    },
  };
}

export const logger: BackendLogger = createDynamicLogger();

export function initializeLogger(
  options: CreateLoggerOptions = {},
): InitializedLogger {
  const env = options.env ?? process.env;
  const previousWinstonLogger = activeWinstonLogger;
  activeWinstonLogger = createWinstonLogger(env);
  activeLogger = new WinstonBackendLogger(
    activeWinstonLogger,
    options.defaultFields,
  );
  previousWinstonLogger.close();

  return {
    logger: activeLogger,
    logDir: resolveStoragePaths(env).backendLogDir,
    logToFile: resolveLogToFile(env),
  };
}

export async function flushAndCloseLogger(): Promise<void> {
  const loggerToClose = activeWinstonLogger;
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 100);
  });
  await new Promise<void>((resolve) => {
    loggerToClose.once("finish", resolve);
    loggerToClose.end();
  });
}
