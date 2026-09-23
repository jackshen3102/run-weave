declare module "fs-native-extensions" {
  /** Nonblocking exclusive descriptor lock; released by closing the descriptor. */
  export function tryLock(fd: number): boolean;
}
