// Distribution fixture: serve the actual built tarballs through npm's HTTP protocol.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

export const npmCommand = process.platform === "win32"
  ? [process.execPath, path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")]
  : ["npm"];

export async function localRegistry(source, fixture, candidate) {
  const packages = new Map();
  for (const root of [source, ...(candidate ? [candidate] : [])]) {
  for (const directory of root === source ? ["cli-package", "package", `${process.platform}-${process.arch}`] : ["package", `${process.platform}-${process.arch}`]) {
    const cwd = path.join(root, directory);
    const [packed] = JSON.parse(execFileSync(npmCommand[0], [...npmCommand.slice(1), "pack", "--json", "--pack-destination", fixture], { cwd, encoding: "utf8" }));
    const pkg = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8"));
    const versions = packages.get(pkg.name) ?? new Map();
    versions.set(pkg.version, { pkg, bytes: readFileSync(path.join(fixture, packed.filename)) });
    packages.set(pkg.name, versions);
  }
  }
  const registry = createServer((request, response) => {
    const name = decodeURIComponent(request.url.split("?")[0]).slice(1);
    const tarball = name.endsWith("/-/package.tgz");
    const versions = packages.get(tarball ? name.slice(0, -"/-/package.tgz".length) : name);
    const entry = versions?.get(new URL(request.url, "http://fixture").searchParams.get("version"));
    if (!versions) { response.writeHead(404); response.end("{}"); return; }
    if (tarball) { if (!entry) { response.writeHead(404); response.end(); return; } response.end(entry.bytes); return; }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      name, "dist-tags": { latest: versions.keys().next().value, next: [...versions.keys()].at(-1) },
      versions: Object.fromEntries([...versions].map(([version, entry]) => [version, { ...entry.pkg, dist: {
        tarball: `http://127.0.0.1:${registry.address().port}/${name}/-/package.tgz?version=${version}`,
        integrity: `sha512-${createHash("sha512").update(entry.bytes).digest("base64")}`,
      } }])),
    }));
  });
  await new Promise(resolve => registry.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${registry.address().port}`, close: () => new Promise(resolve => registry.close(resolve)) };
}
