// Rehydrate the exact immutable tarballs used by publication, including on retry.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { serverTargets } from "./server-targets.mjs";

const root = path.resolve(".runtime-artifacts/server");
const target = process.argv
  .find((arg) => arg.startsWith("--target="))
  ?.slice(9);
const scope = process.env.RELEASE_SCOPE ?? "all";
if (
  !serverTargets.some((row) => row.target === target) ||
  !["all", "server", "cli"].includes(scope)
)
  throw new Error("Invalid candidate target or scope");
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const versions = Object.fromEntries(
  ["server", "cli"].map((name) => [
    name,
    JSON.parse(readFileSync(`packages/runweave-${name}/package.json`, "utf8"))
      .version,
  ]),
);
const expected = new Map([
  ["@runweave/cli", "cli-package"],
  ...(scope === "cli"
    ? []
    : [
        ["@runweave/server", "package"],
        [`@runweave/server-${target}`, target],
      ]),
]);
const entry = (file, name) =>
  JSON.parse(
    execFileSync("tar", ["-xOf", file, `package/${name}`], {
      encoding: "utf8",
    }),
  );
const files = readdirSync(root).filter((name) => name.endsWith(".tgz"));
if (files.length !== expected.size)
  throw new Error("Incomplete candidate tarballs");
const candidates = files.map((name) => {
  const file = path.join(root, name),
    pkg = entry(file, "package.json");
  const directory = expected.get(pkg.name);
  if (
    !directory ||
    pkg.version !== versions[pkg.name === "@runweave/cli" ? "cli" : "server"] ||
    pkg.repository?.url !== "git+https://github.com/jackshen3102/run-weave.git"
  )
    throw new Error(`Candidate identity mismatch: ${pkg.name}`);
  expected.delete(pkg.name);
  if (pkg.name === "@runweave/cli") {
    if (entry(file, "dist/build-info.json").sourceRevision !== revision)
      throw new Error("Candidate CLI source mismatch");
  } else if (directory === target) {
    const manifest = entry(file, "manifest.json");
    if (
      manifest.sourceRevision !== revision ||
      manifest.version !== versions.server ||
      `${manifest.platform}-${manifest.arch}` !== target
    )
      throw new Error("Candidate Server source/target mismatch");
  } else if (
    !serverTargets.every(
      (row) =>
        pkg.optionalDependencies?.[`@runweave/server-${row.target}`] ===
        versions.server,
    )
  ) {
    throw new Error("Candidate platform dependencies mismatch");
  }
  return { file, directory };
});
if (expected.size) throw new Error("Missing candidate package");
for (const { file, directory } of candidates) {
  const destination = path.join(root, directory);
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  execFileSync("tar", [
    "-xzf",
    file,
    "-C",
    destination,
    "--strip-components=1",
  ]);
}
console.log(
  JSON.stringify({
    revision,
    target,
    scope,
    restored: candidates.map((row) => row.directory),
  }),
);
