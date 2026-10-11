import type { RuntimeBuildInfo } from "../../packages/shared/src/monitoring/runtime-version";

export function createBuildInfo(packageDirectory: string): RuntimeBuildInfo;
export function buildInfoDefine(packageDirectory: string): {
  __RUNWEAVE_BUILD_INFO__: string;
};
