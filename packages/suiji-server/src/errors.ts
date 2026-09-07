import type { SuijiErrorCode } from "@runweave/shared/suiji";
export class ServiceError extends Error {
  constructor(
    public status: number,
    public code: SuijiErrorCode,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
export const invalid = (message: string) =>
  new ServiceError(400, "INVALID_ARGUMENT", message);
export const missing = () => new ServiceError(404, "NOT_FOUND", "对象不存在");
export const unauthenticated = () =>
  new ServiceError(401, "UNAUTHENTICATED", "请重新登录");
