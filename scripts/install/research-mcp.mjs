import { spawnSync } from "node:child_process";
import path from "node:path";
import { explicitConfigurationArguments } from "../lib/configuration.mjs";

const context = explicitConfigurationArguments();
for (const name of ["@runweave/mcp", "@runweave/cli"]) {
  const result = spawnSync("pnpm", ["--filter", name, "build"], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${name} build failed`);
}
const extra = process.argv.slice(2).filter((arg, index, all) => arg !== "--" && !/^--(instance|config-dir)(=|$)/.test(arg) && !["--instance", "--config-dir"].includes(all[index - 1]));
const result = spawnSync(process.execPath, [path.resolve("packages/runweave-cli/dist/index.js"), "research-mcp", "install", "--entry", path.resolve("packages/runweave-mcp/dist/index.cjs"), ...context, ...extra], { stdio: "inherit" });
process.exitCode = result.status ?? 1;
