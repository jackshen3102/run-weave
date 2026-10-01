#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { githubAccess } from "./github-access.mjs";

// Read-only collection: one failed probe must not suppress unrelated evidence.
const args = process.argv.slice(2);
const fallbackIndex = args.indexOf("--fallback-proxy");
let fallbackProxy;
if (fallbackIndex >= 0) {
  fallbackProxy = args[fallbackIndex + 1];
  if (!fallbackProxy)
    throw new Error("--fallback-proxy requires an HTTP(S) proxy URL.");
  args.splice(fallbackIndex, 2);
}
if (args.length > 1 || args[0]?.startsWith("--"))
  throw new Error("Usage: preflight.mjs [workspace] [--fallback-proxy URL]");
const cwd = path.resolve(args[0] || process.cwd());
const env = {
  ...process.env,
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  GH_PROMPT_DISABLED: "1",
};
delete env.GH_DEBUG;

function run(file, args, accepted = [0], options = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd, env, timeout: 20_000, maxBuffer: 1024 * 1024, ...options },
      (error, stdout, stderr) =>
        resolve({
          status: !error || accepted.includes(error.code) ? "ok" : "failed",
          exitCode: error
            ? typeof error.code === "number"
              ? error.code
              : null
            : 0,
          error:
            error && !accepted.includes(error.code)
              ? error.killed
                ? "timeout"
                : String(error.code)
              : null,
          stdout: stdout.trimEnd(),
          stderr: stderr.trimEnd(),
        }),
    );
  });
}

function githubRepository(remote) {
  // Only accept the github.com transport forms supported by this skill.
  const match = remote.match(
    /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i,
  );
  return match ? `github.com/${match[1]}/${match[2]}` : null;
}

function privateResult(result) {
  // Never print auth output or raw remotes, which may contain credentials.
  return {
    status: result.status,
    exitCode: result.exitCode,
    error: result.error,
  };
}

const probes = {
  root: ["rev-parse", "--show-toplevel"],
  head: ["rev-parse", "--verify", "HEAD"],
  branch: ["symbolic-ref", "--quiet", "--short", "HEAD"],
  worktree: ["status", "--porcelain=v1", "--untracked-files=normal"],
  staged: ["diff", "--cached", "--name-status"],
  worktrees: ["worktree", "list", "--porcelain"],
  origin: ["remote", "get-url", "origin"],
  pushOrigin: ["remote", "get-url", "--push", "--all", "origin"],
  preCommitPath: [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "hooks/pre-commit",
  ],
  prePushPath: [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "hooks/pre-push",
  ],
};
const checks = Object.fromEntries(
  await Promise.all(
    Object.entries(probes).map(async ([name, args]) => [
      name,
      await run("git", args, name === "branch" ? [0, 1] : [0]),
    ]),
  ),
);

const repository =
  checks.origin.status === "ok" ? githubRepository(checks.origin.stdout) : null;
const gitHttps = checks.origin.stdout.startsWith("https://");
const pushRepositories =
  checks.pushOrigin.status === "ok"
    ? checks.pushOrigin.stdout.split("\n").map(githubRepository)
    : [];
const remoteMatches =
  repository !== null &&
  pushRepositories.length === 1 &&
  pushRepositories[0]?.toLowerCase() === repository.toLowerCase();
checks.origin = { ...privateResult(checks.origin), repository };
checks.pushOrigin = {
  ...privateResult(checks.pushOrigin),
  repositories: pushRepositories,
};
checks.remote = {
  status: remoteMatches ? "ok" : "failed",
  reason: remoteMatches
    ? null
    : "Expected one matching github.com fetch/push repository; inspect origin configuration before publishing.",
};

async function readHook(hookPath) {
  try {
    return {
      status: "ok",
      path: hookPath,
      content: await readFile(hookPath, "utf8"),
    };
  } catch (error) {
    return {
      status: error.code === "ENOENT" ? "absent" : "failed",
      path: hookPath,
      error: error.code,
    };
  }
}

// Hooks and Git state are collected even if GitHub credentials are unusable.
const hookPaths = [checks.preCommitPath, checks.prePushPath]
  .filter((result) => result.status === "ok")
  .map((result) => result.stdout);
if (checks.root.status === "ok") {
  hookPaths.push(
    ...["pre-commit", "pre-push"].map((name) =>
      path.join(checks.root.stdout, ".husky", name),
    ),
  );
}
const hooksPromise = Promise.all([...new Set(hookPaths)].map(readHook));

let github;
if (repository) {
  github = await githubAccess(run, env, repository, fallbackProxy, gitHttps);
  Object.assign(checks, github.checks);
} else {
  for (const name of ["auth", "account", "repositoryAccess"]) {
    checks[name] = {
      status: "skipped",
      reason: "No supported origin repository",
    };
  }
}

const hooks = await hooksPromise;
const failedChecks = Object.entries(checks)
  .filter(([, result]) => result.status === "failed")
  .map(([name]) => name);
const passed =
  failedChecks.length === 0 && hooks.every((hook) => hook.status !== "failed");
console.log(
  JSON.stringify(
    {
      cwd,
      passed,
      failedChecks,
      checks,
      ...(github
        ? { diagnosis: github.diagnosis, recovery: github.recovery }
        : {}),
      hooks,
      note: "Read-only snapshot, not permission to stage, push or merge. Recheck state before mutations; repository read access does not prove push permission.",
    },
    null,
    2,
  ),
);
process.exitCode = passed ? 0 : 1;
