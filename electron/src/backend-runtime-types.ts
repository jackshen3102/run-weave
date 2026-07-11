import type { ChildProcess } from "node:child_process";
import type { RuntimeRelease } from "./runtime-release.js";

export interface PackagedBackendPaths {
  backendEntry: string;
  frontendDistDir: string;
  nodePtyDir: string;
  releaseId: string;
  source: "external" | "bundled";
}

export interface PackagedBackendRuntime {
  backendUrl: string;
  stop(): Promise<void>;
  child: ChildProcess;
  getOutputTail(): string[];
  runtimeRelease: RuntimeRelease;
  startupWarning: string | null;
}

export interface PackagedBackendRuntimeCandidatePlan {
  activeRelease: RuntimeRelease;
  candidates: RuntimeRelease[];
  currentReleaseId: string | null;
  currentReleaseInvalid: boolean;
}

export interface PackagedBackendRuntimeIncidentEvent {
  event: string;
  level?: "info" | "warn" | "error";
  details?: Record<string, unknown>;
}
