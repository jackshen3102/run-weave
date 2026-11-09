// Publish exactly the selected CI artifacts. No rebuild here.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { serverTargets } from "./server-targets.mjs";

const root = path.resolve(
  process.argv.find((a) => a.startsWith("--artifacts="))?.slice(12) ??
    "release-artifacts",
);
const registry = "https://registry.npmjs.org";
const targets = serverTargets.map((row) => row.target);
const server = JSON.parse(
  readFileSync("packages/runweave-server/package.json"),
);
const cli = JSON.parse(readFileSync("packages/runweave-cli/package.json"));
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const channel = process.env.RELEASE_CHANNEL ?? "next";
if (!["next", "latest"].includes(channel))
  throw new Error("Invalid release channel");
const scope = process.env.RELEASE_SCOPE ?? "all";
if (!["all", "server", "cli"].includes(scope))
  throw new Error("Invalid release scope");
const assert = (ok, message) => {
  if (!ok) throw new Error(message);
};
const entry = (file, name) =>
  JSON.parse(
    execFileSync("tar", ["-xOf", file, `package/${name}`], {
      encoding: "utf8",
    }),
  );
const packages = [];
for (const target of scope === "cli" ? ["linux-x64"] : targets) {
  const directory = path.join(root, `npm-server-${target}`);
  const artifacts = readdirSync(directory)
    .filter((name) => name.endsWith(".tgz"))
    .map((name) => {
      const file = path.join(directory, name);
      const pkg = entry(file, "package.json");
      const integrity = `sha512-${createHash("sha512").update(readFileSync(file)).digest("base64")}`;
      return { file, pkg, integrity };
    });
  const names =
    scope === "cli"
      ? [cli.name]
      : [`@runweave/server-${target}`, server.name, cli.name];
  assert(
    artifacts.length === names.length,
    `Unexpected tarballs for ${target}`,
  );
  for (const name of names) {
    const matches = artifacts.filter((a) => a.pkg.name === name);
    assert(matches.length === 1, `Missing/duplicate ${name} on ${target}`);
    const artifact = matches[0],
      pkg = artifact.pkg;
    assert(
      pkg.version === (name === cli.name ? cli.version : server.version),
      `Wrong version: ${name}`,
    );
    assert(
      pkg.repository?.url ===
        "git+https://github.com/jackshen3102/run-weave.git",
      `Wrong repository: ${name}`,
    );
    if (name === `@runweave/server-${target}`) {
      const manifest = entry(artifact.file, "manifest.json");
      assert(
        manifest.version === server.version &&
          manifest.sourceRevision === revision,
        `Wrong source: ${target}`,
      );
      assert(
        `${manifest.platform}-${manifest.arch}` === target,
        `Wrong platform: ${target}`,
      );
      packages.push(artifact);
    } else if (name === server.name) {
      assert(
        targets.every(
          (t) =>
            pkg.optionalDependencies?.[`@runweave/server-${t}`] ===
            server.version,
        ),
        "Platform versions must match Server",
      );
    } else {
      const files = execFileSync("tar", ["-tzf", artifact.file], {
        encoding: "utf8",
      });
      assert(
        files.includes("package/node_modules/fs-native-extensions/"),
        "CLI bundled dependency missing",
      );
      for (const t of targets)
        assert(
          files.includes(`prebuilds/${t}/`),
          `CLI native prebuild missing: ${t}`,
        );
    }
    // The platform jobs may contain platform-specific build metadata in the CLI.
    // Publish the public packages once, from the verified Linux x64 job.
    if (
      target === "linux-x64" &&
      (name === server.name || (name === cli.name && scope !== "server"))
    )
      packages.push(artifact);
  }
}
packages.sort((a, b) => {
  const order = (p) =>
    p.pkg.name === server.name ? 1 : p.pkg.name === cli.name ? 2 : 0;
  return order(a) - order(b);
});
console.log(
  JSON.stringify(
    {
      revision,
      channel,
      scope,
      packages: packages.map(({ pkg, integrity }) => ({
        name: pkg.name,
        version: pkg.version,
        integrity,
      })),
    },
    null,
    2,
  ),
);
if (process.argv.includes("--check")) process.exit(0);
assert(
  process.env.GITHUB_ACTIONS === "true" &&
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
  "Publishing requires GitHub Actions OIDC",
);
const receipt = { revision, channel, scope, packages: [], phase: "preflight" };
const save = () =>
  writeFileSync(
    path.join(root, "release-receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function metadata(name, version) {
  const response = await fetch(
    `${registry}/${encodeURIComponent(name)}/${version}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Registry ${response.status}: ${name}`);
  return response.json();
}
function npm(args) {
  execFileSync("npm", [...args, `--registry=${registry}`], {
    stdio: "inherit",
    env: { ...process.env, NPM_CONFIG_IGNORE_SCRIPTS: "true" },
  });
}
async function verify(artifact) {
  const { pkg, integrity } = artifact;
  // npm may accept a publish before registry processing makes it visible.
  // Keep polling the exact version; never republish while it is still processing.
  for (let attempt = 0; attempt < 90; attempt++) {
    const published = await metadata(pkg.name, pkg.version);
    if (published) {
      assert(
        published.dist?.integrity === integrity,
        `Published integrity differs: ${pkg.name}@${pkg.version}`,
      );
      const response = await fetch(published.dist.tarball, {
        signal: AbortSignal.timeout(120_000),
      });
      // Registry metadata can become visible before its tarball reaches the CDN.
      // Retry that propagation gap without publishing the immutable version again.
      if (response.status === 404) {
        await response.body?.cancel();
      } else {
        assert(
          response.ok,
          `Cannot download ${pkg.name}: HTTP ${response.status}`,
        );
        const downloaded = `sha512-${createHash("sha512")
          .update(Buffer.from(await response.arrayBuffer()))
          .digest("base64")}`;
        assert(
          downloaded === integrity,
          `Downloaded bytes differ: ${pkg.name}`,
        );
        return;
      }
    }
    if (attempt % 6 === 0)
      console.log(
        `Waiting for npm processing: ${pkg.name}@${pkg.version} (${attempt * 10}s / 900s)`,
      );
    await sleep(10_000);
  }
  throw new Error(
    `Registry visibility timeout: ${pkg.name}@${pkg.version}; inspect staged publish status before retry`,
  );
}
const existing = new Set();
async function checkedTogether(actions) {
  // Finish all in-flight verification and receipt writes before reporting failure.
  const results = await Promise.allSettled(actions);
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
}
async function publishGroup(group) {
  // Upload the group before waiting for registry processing. A pending upload
  // is never submitted twice; retries must reuse these exact CI artifacts.
  for (const { pkg, file } of group) {
    if (!existing.has(pkg.name)) {
      assert(
        !process.argv.includes("--promote"),
        `Cannot promote missing package: ${pkg.name}`,
      );
      npm(["publish", file, "--access=public", "--tag=next", "--provenance"]);
    }
  }
  await checkedTogether(
    group.map(async (artifact) => {
      const { pkg, integrity } = artifact;
      await verify(artifact);
      receipt.packages.push({
        name: pkg.name,
        version: pkg.version,
        integrity,
        verified: true,
      });
      save();
    }),
  );
}
async function verifyTag({ pkg }) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await fetch(
      `${registry}/-/package/${encodeURIComponent(pkg.name)}/dist-tags`,
      { signal: AbortSignal.timeout(30_000) },
    );
    assert(response.ok, `Cannot read tags: ${pkg.name} (${response.status})`);
    if ((await response.json())[channel] === pkg.version) return;
    if (attempt % 6 === 0)
      console.log(`Waiting for npm tag propagation: ${pkg.name} ${channel}`);
    await sleep(10_000);
  }
  throw new Error(`Tag verification timed out: ${pkg.name}`);
}
try {
  // Reject conflicts across the whole selected release before the first upload.
  await checkedTogether(
    packages.map(async ({ pkg, integrity }) => {
      const published = await metadata(pkg.name, pkg.version);
      assert(
        !published || published.dist?.integrity === integrity,
        `Version already contains different bytes: ${pkg.name}@${pkg.version}`,
      );
      if (published) existing.add(pkg.name);
    }),
  );
  receipt.phase = "publishing";
  save();
  await checkedTogether([
    publishGroup(packages.filter((a) => a.pkg.name === cli.name)),
    (async () => {
      await publishGroup(
        packages.filter((a) => ![server.name, cli.name].includes(a.pkg.name)),
      );
      // Keep the main package installable: its exact platform dependencies must
      // be publicly downloadable before moving the main package's next tag.
      await publishGroup(packages.filter((a) => a.pkg.name === server.name));
    })(),
  ]);
  receipt.packages.sort(
    (a, b) =>
      packages.findIndex((p) => p.pkg.name === a.name) -
      packages.findIndex((p) => p.pkg.name === b.name),
  );
  if (!process.argv.includes("--promote")) {
    receipt.phase = "published";
    save();
    process.exit(0);
  }
  receipt.phase = "tagging";
  save();
  for (const { pkg } of packages) {
    npm(["dist-tag", "add", `${pkg.name}@${pkg.version}`, channel]);
  }
  await checkedTogether(packages.map(verifyTag));
  receipt.phase = "complete";
  save();
  if (process.env.GITHUB_STEP_SUMMARY)
    writeFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `Released ${packages.map(({ pkg }) => `${pkg.name}@${pkg.version}`).join(", ")} to ${channel}.\nSource: ${revision}\nAll ${packages.length} selected registry tarballs verified by SHA-512.\n`,
      { flag: "a" },
    );
} catch (error) {
  receipt.error = error.message;
  save();
  throw error;
}
