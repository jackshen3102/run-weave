export type SuijiErrorCode =
  | "INVALID_ARGUMENT"
  | "UNAUTHENTICATED"
  | "NOT_FOUND"
  | "VERSION_CONFLICT"
  | "INVALID_TRANSITION"
  | "IDEMPOTENCY_KEY_REUSED"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "DEPENDENCY_UNAVAILABLE";
export type SuijiErrorResponse = {
  ok: false;
  error: {
    code: SuijiErrorCode;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
  requestId: string;
};
