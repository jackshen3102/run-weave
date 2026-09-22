#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

// Read-only collection: one failed probe must not suppress unrelated evidence.
const cwd = path.resolve(process.argv[2] || process.cwd());
const env = {
  ...process.env,
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  GH_PROMPT_DISABLED: "1",
};
delete env.GH_DEBUG;

function run(file, args, accepted = [0]) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd, env, timeout: 20_000, maxBuffer: 1024 * 1024 },
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

if (repository) {
  const [auth, account, access] = await Promise.all([
    run("gh", ["auth", "status", "--active", "--hostname", "github.com"]),
    run("gh", ["api", "--hostname", "github.com", "user", "--jq", ".login"]),
    run("gh", [
      "repo",
      "view",
      repository,
      "--json",
      "nameWithOwner,viewerPermission,defaultBranchRef",
    ]),
  ]);
  checks.auth = privateResult(auth);
  checks.account = {
    ...privateResult(account),
    login: account.status === "ok" ? account.stdout : null,
  };
  checks.repositoryAccess = privateResult(access);
  if (access.status === "ok") {
    try {
      checks.repositoryAccess.details = JSON.parse(access.stdout);
    } catch {
      checks.repositoryAccess.status = "failed";
      checks.repositoryAccess.error = "invalid-json";
    }
  }
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
      hooks,
      note: "Read-only snapshot, not permission to stage, push or merge. Recheck state before mutations; repository read access does not prove push permission.",
    },
    null,
    2,
  ),
);
process.exitCode = passed ? 0 : 1;
