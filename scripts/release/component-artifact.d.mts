import type { RuntimeBuildInfo } from "../../packages/shared/src/monitoring/runtime-version";

export interface ArtifactRoot {
  name: string;
  directory: string;
  exclude?: string[];
}
export function componentContentHash(
  roots: ArtifactRoot[],
  descriptor?: object,
): Promise<string>;
export function publishComponentArtifact(options: {
  component: string;
  packageDirectory: string;
  roots: ArtifactRoot[];
  metadataFile: string;
  entries?: string[];
  htmlEntries?: string[];
  descriptor?: object;
  minimumVersion?: string;
  registryRoot?: string;
}): Promise<RuntimeBuildInfo & { contentSha256: string }>;
