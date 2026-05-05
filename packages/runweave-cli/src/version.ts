import fs from "node:fs";
import path from "node:path";

export interface CliVersionInfo {
  name: string;
  version: string;
}

export function readCliVersion(): CliVersionInfo {
  const packageJsonPath = path.resolve(__dirname, "..", "package.json");
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
    name?: unknown;
    version?: unknown;
  };

  return {
    name: typeof pkg.name === "string" ? pkg.name : "@runweave/cli",
    version: typeof pkg.version === "string" ? pkg.version : "0.0.0",
  };
}
