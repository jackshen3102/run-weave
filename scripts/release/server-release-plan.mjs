import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { serverTargets } from "./server-targets.mjs";

const readVersion = (name) =>
  JSON.parse(readFileSync(`packages/runweave-${name}/package.json`, "utf8"))
    .version;
const versions = { server: readVersion("server"), cli: readVersion("cli") };
const requested = process.env.RELEASE_REQUESTED_SCOPE ?? "auto";
const publishing = process.env.RELEASE_PUBLISH === "true";
const windowsOnly =
  process.env.RELEASE_WINDOWS_ONLY === "true" ||
  process.env.RELEASE_PTY_SPIKE_ONLY === "true";
if (!["auto", "all", "server", "cli"].includes(requested))
  throw new Error("Invalid release scope");
const registry = "https://registry.npmjs.org";
async function metadata(name, version) {
  const response = await fetch(
    `${registry}/${encodeURIComponent(`@runweave/${name}`)}/${version}`,
    {
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Registry ${response.status}: ${name}`);
  return response.json();
}
const published = publishing
  ? Object.fromEntries(
      await Promise.all(
        Object.entries(versions).map(async ([name, version]) => [
          name,
          await metadata(name, version),
        ]),
      ),
    )
  : {};
// Only changed components receive new versions. Auto publishes precisely those
// new versions; an unchanged component keeps its already-published exact version.
const selected =
  requested === "auto"
    ? publishing
      ? Object.keys(versions).filter((name) => !published[name])
      : ["server", "cli"]
    : requested === "all"
      ? ["server", "cli"]
      : [requested];
if (!selected.length)
  throw new Error(
    "No new package versions; bump only the components being released",
  );
if (publishing) {
  for (const name of Object.keys(versions)) {
    if (selected.includes(name) && published[name])
      throw new Error(
        `${name}@${versions[name]} is already published; use a new version`,
      );
    if (!selected.includes(name) && !published[name])
      throw new Error(
        `Unselected ${name}@${versions[name]} must already be published`,
      );
  }
}
const scope = selected.length === 2 ? "all" : selected[0];
if (publishing && windowsOnly)
  throw new Error("Windows-only verification cannot publish");
if (
  process.env.GITHUB_REF_TYPE === "tag" &&
  (process.env.GITHUB_REF_NAME !== `server-v${versions.server}` ||
    !selected.includes("server"))
)
  throw new Error("Release tag must match a new selected Server version");

let fullRegression = scope !== "cli";
function versionOnly(file, baseline) {
  if (!/^packages\/runweave-(?:server|cli)\/package\.json$/.test(file))
    return false;
  const before = JSON.parse(
    execFileSync("git", ["show", `${baseline}:${file}`], { encoding: "utf8" }),
  );
  const after = JSON.parse(readFileSync(file, "utf8"));
  delete before.version;
  delete after.version;
  return JSON.stringify(before) === JSON.stringify(after);
}
if (publishing && selected.includes("server")) {
  const previous = await metadata("server", "latest");
  if (previous) {
    const baseline = `server-v${previous.version}`;
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", baseline, "HEAD"], {
        stdio: "pipe",
      });
      const files = execFileSync(
        "git",
        ["diff", "--name-only", `${baseline}..HEAD`],
        { encoding: "utf8" },
      )
        .trim()
        .split("\n")
        .filter((file) => !versionOnly(file, baseline));
      // Unknown history always retains full regression. Platform/runtime,
      // configuration, storage, build and dependency changes also retain it.
      fullRegression = files.some(
        (file) =>
          !/^(?:docs\/|frontend\/(?:src|public)\/|packages\/(?:app-ios|browser-ios|suiji-ios)\/|backend\/src\/routes\/)/.test(
            file,
          ) ||
          /^backend\/src\/routes\/(?:auth|terminal|scheduled-tasks|configuration)/.test(
            file,
          ),
      );
    } catch {
      fullRegression = true;
    }
  }
}
const matrix = windowsOnly
  ? serverTargets.filter((row) => row.target === "win32-x64")
  : scope === "cli"
    ? serverTargets.filter((row) => row.target === "linux-x64")
    : serverTargets;
const plan = {
  scope,
  server: selected.includes("server"),
  cli: selected.includes("cli"),
  fullRegression,
  versions,
  matrix: { include: matrix },
};
console.log(JSON.stringify(plan, null, 2));
if (process.env.GITHUB_OUTPUT) {
  for (const [key, value] of Object.entries({
    scope,
    server: plan.server,
    cli: plan.cli,
    full_regression: fullRegression,
    matrix: plan.matrix,
    registry_matrix: { include: serverTargets },
    server_version: versions.server,
    cli_version: versions.cli,
  }))
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `${key}=${typeof value === "object" ? JSON.stringify(value) : value}\n`,
    );
}
