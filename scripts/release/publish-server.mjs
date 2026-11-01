// Publish exactly the artifacts verified by the four platform jobs. No rebuild here.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(
  process.argv.find((a) => a.startsWith("--artifacts="))?.slice(12) ??
    "release-artifacts",
);
const registry = "https://registry.npmjs.org";
const targets = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
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
for (const target of targets) {
  const directory = path.join(root, `npm-server-${target}`);
  const artifacts = readdirSync(directory)
    .filter((name) => name.endsWith(".tgz"))
    .map((name) => {
      const file = path.join(directory, name);
      const pkg = entry(file, "package.json");
      const integrity = `sha512-${createHash("sha512").update(readFileSync(file)).digest("base64")}`;
      return { file, pkg, integrity };
    });
  assert(artifacts.length === 3, `Expected three tarballs for ${target}`);
  for (const name of [`@runweave/server-${target}`, server.name, cli.name]) {
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
    if (target === "linux-x64" && [server.name, cli.name].includes(name))
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
const receipt = { revision, channel, packages: [], phase: "preflight" };
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
  for (let attempt = 0; attempt < 12; attempt++) {
    const published = await metadata(pkg.name, pkg.version);
    if (published) {
      assert(
        published.dist?.integrity === integrity,
        `Published integrity differs: ${pkg.name}@${pkg.version}`,
      );
      const response = await fetch(published.dist.tarball, {
        signal: AbortSignal.timeout(120_000),
      });
      assert(response.ok, `Cannot download ${pkg.name}`);
      const downloaded = `sha512-${createHash("sha512")
        .update(Buffer.from(await response.arrayBuffer()))
        .digest("base64")}`;
      assert(downloaded === integrity, `Downloaded bytes differ: ${pkg.name}`);
      return;
    }
    await sleep(10_000);
  }
  throw new Error(
    `Registry visibility timeout: ${pkg.name}@${pkg.version}; inspect staged publish status before retry`,
  );
}
try {
  // Reject conflicts across the whole release before publishing the first package.
  for (const { pkg, integrity } of packages) {
    const published = await metadata(pkg.name, pkg.version);
    assert(
      !published || published.dist?.integrity === integrity,
      `Version already contains different bytes: ${pkg.name}@${pkg.version}`,
    );
  }
  receipt.phase = "publishing";
  save();
  for (const artifact of packages) {
    const { pkg, integrity } = artifact;
    if (!(await metadata(pkg.name, pkg.version))) {
      assert(
        !process.argv.includes("--promote"),
        `Cannot promote missing package: ${pkg.name}`,
      );
      npm([
        "publish",
        artifact.file,
        "--access=public",
        "--tag=next",
        "--provenance",
      ]);
    }
    await verify(artifact);
    receipt.packages.push({
      name: pkg.name,
      version: pkg.version,
      integrity,
      verified: true,
    });
    save();
  }
  if (!process.argv.includes("--promote")) {
    receipt.phase = "published";
    save();
    process.exit(0);
  }
  receipt.phase = "tagging";
  save();
  for (const { pkg } of packages) {
    npm(["dist-tag", "add", `${pkg.name}@${pkg.version}`, channel]);
    const response = await fetch(
      `${registry}/-/package/${encodeURIComponent(pkg.name)}/dist-tags`,
      { signal: AbortSignal.timeout(30_000) },
    );
    assert(
      response.ok && (await response.json())[channel] === pkg.version,
      `Tag verification failed: ${pkg.name}`,
    );
  }
  receipt.phase = "complete";
  save();
  if (process.env.GITHUB_STEP_SUMMARY)
    writeFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `Released ${server.name}@${server.version}, ${cli.name}@${cli.version} to ${channel}.\nSource: ${revision}\nAll six registry tarballs verified by SHA-512.\n`,
      { flag: "a" },
    );
} catch (error) {
  receipt.error = error.message;
  save();
  throw error;
}
