export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

export class HttpError extends CliError {
  readonly status: number;
  readonly code?: string;
  readonly payload?: Record<string, unknown>;

  constructor(
    status: number,
    message: string,
    options?: { code?: string; payload?: Record<string, unknown> },
  ) {
    super(
      message,
      status === 401 ? 3 : status === 404 || status === 409 ? 4 : 1,
    );
    this.name = "HttpError";
    this.status = status;
    this.code = options?.code;
    this.payload = options?.payload;
  }
}

export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) {
    return error;
  }
  return new CliError(error instanceof Error ? error.message : String(error));
}
