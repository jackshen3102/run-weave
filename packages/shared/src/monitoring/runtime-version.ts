import type { RuntimeStatusFact } from "./runtime-status";

export interface RuntimeBuildInfo {
  version: string;
  buildId?: string;
  sourceRevision?: string;
  sourceDirty?: boolean;
  builtAt?: string;
}

declare const __RUNWEAVE_BUILD_INFO__: RuntimeBuildInfo;

export function runtimeBuildInfo(
  fallback: RuntimeBuildInfo = { version: "development" },
): RuntimeBuildInfo {
  return typeof __RUNWEAVE_BUILD_INFO__ === "object"
    ? __RUNWEAVE_BUILD_INFO__
    : fallback;
}

// These fact IDs are stable across owners and older protocol-v1 clients.
export const RUNTIME_VERSION_FACT_PREFIX = "runtime-version.";
export function runtimeVersionFacts(
  info: RuntimeBuildInfo,
): RuntimeStatusFact[] {
  const values: Array<[string, string, string | undefined]> = [
    ["number", "版本", info.version],
    ["build", "构建", info.buildId],
    ["revision", "源码提交", info.sourceRevision],
    [
      "dirty",
      "包含未提交改动",
      info.sourceDirty === undefined
        ? undefined
        : info.sourceDirty
          ? "是"
          : "否",
    ],
    ["built-at", "构建时间", info.builtAt],
  ];
  return values.flatMap(([id, label, value]) =>
    value
      ? [
          {
            id: `${RUNTIME_VERSION_FACT_PREFIX}${id}`,
            label,
            value,
            kind: id === "built-at" ? ("time" as const) : ("text" as const),
            copyable: true,
          },
        ]
      : [],
  );
}
