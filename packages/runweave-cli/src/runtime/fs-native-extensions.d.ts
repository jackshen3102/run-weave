declare module "fs-native-extensions" {
  /** Nonblocking exclusive descriptor lock; released by closing the descriptor. */
  export function tryLock(fd: number, offset?: number, length?: number, options?: { shared?: boolean }): boolean;
}
