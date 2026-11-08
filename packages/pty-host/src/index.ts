import path from "node:path";
import { readPrivateFile } from "@runweave/config-node";
import type { EnvironmentContext } from "@runweave/shared/configuration";
import { startHost } from "./server";

const root = process.argv[process.argv.indexOf("--root") + 1];
if (!process.argv.includes("--root") || !root || !path.isAbsolute(root)) throw new Error("HOST_ROOT_REQUIRED");
const launch = JSON.parse(readPrivateFile(path.join(root, "launch.json"), 16_384)) as { scope: EnvironmentContext; release: string };
if (path.join(launch.scope.configRoot, "runtime/pty-host") !== root) throw new Error("HOST_IDENTITY_MISMATCH");
void startHost(launch.scope, launch.release).catch(error => { process.stderr.write((error as Error).message + "\n"); process.exitCode = 1; });
