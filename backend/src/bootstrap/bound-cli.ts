import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, cpSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { EnvironmentContext } from "@runweave/shared/configuration";

export function installBoundCli(context: EnvironmentContext): void {
  const directory = path.dirname(process.argv[1] ?? "");
  const entry = [
    path.resolve(directory, "../cli/index.cjs"),
    path.resolve(directory, "../cli/index.js"),
    path.resolve(directory, "../app.asar/dist/cli/index.cjs"),
    path.resolve(directory, "../../packages/runweave-cli/dist/index.js"),
  ].find(existsSync);
  if (!entry) {
    if (context.kind === "dev") throw new Error("CONFIG_BOUND_CLI_BUILD_REQUIRED");
    return;
  }
  const modules = [path.join(path.dirname(entry), "node_modules"), path.resolve(directory, "../node_modules")].find(existsSync);
  if (!modules) throw new Error("CONFIG_BOUND_CLI_DEPENDENCIES_REQUIRED");
  const bin = path.join(context.configRoot, "runtime", "bin");
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  const digest = createHash("sha256").update(readFileSync(entry)).digest("hex");
  const release = path.join(context.configRoot, "runtime", "cli", `${digest}-cjs`);
  if (!existsSync(path.join(release, "index.cjs"))) {
    const temporary = `${release}.${randomUUID()}.tmp`;
    mkdirSync(temporary, { recursive: true, mode: 0o700 });
    cpSync(entry, path.join(temporary, "index.cjs"));
    cpSync(modules, path.join(temporary, "node_modules"), { recursive: true, dereference: true });
    renameSync(temporary, release);
  }
  const binding = { ...context, entry: path.join(release, "index.cjs"), digest };
  const source = `const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const binding=${JSON.stringify(binding)};
try {
  if (binding.kind==='dev') {
    const manifest=JSON.parse(fs.readFileSync(path.join(binding.configRoot,'manifest.json'),'utf8'));
    if(manifest.devSessionId!==binding.instanceId||manifest.state!=='ready')throw Error();
  }
  if(crypto.createHash('sha256').update(fs.readFileSync(binding.entry)).digest('hex')!==binding.digest)throw Error();
} catch { process.stderr.write('CONFIG_BOUND_CLI_IDENTITY_INVALID\\n');process.exit(2); }
const result=cp.spawnSync(process.execPath,[binding.entry,'--instance',binding.instanceId,'--config-dir',binding.configRoot,...process.argv.slice(2)],{stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
process.exit(result.status??1);
`;
  const runner = path.join(bin, "bound-cli.cjs");
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  for (const [file, content, mode] of [
    [runner, source, 0o600],
    [path.join(bin, "rw"), `#!/bin/sh\nexec env ELECTRON_RUN_AS_NODE=1 ${quote(process.execPath)} ${quote(runner)} "$@"\n`, 0o700],
  ] as const) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, content, { mode, flag: "wx" });
    renameSync(temporary, file);
  }
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
}
