import fs from "node:fs";
import path from "node:path";

export interface CliVersionInfo {
  name: string;
  version: string;
  build?: {
    sourceRevision: string;
    sourceDirty: boolean;
    builtAt: string;
    contentSha256?: string;
  };
}

export function readCliVersion(): CliVersionInfo {
  const packageJsonPath = path.resolve(__dirname, "..", "package.json");
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
    name?: unknown;
    version?: unknown;
  };

  let build: CliVersionInfo["build"];
  for (const name of ["release.json", "build-info.json"]) {
    try {
      build = JSON.parse(fs.readFileSync(path.join(__dirname, name), "utf8"));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  return {
    name: typeof pkg.name === "string" ? pkg.name : "@runweave/cli",
    version: typeof pkg.version === "string" ? pkg.version : "0.0.0",
    ...(build ? { build } : {}),
  };
}
