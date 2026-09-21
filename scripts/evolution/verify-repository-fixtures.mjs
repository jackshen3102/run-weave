import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import { resolveRepositoryIdentity } from "../../backend/src/repository/identity.ts";
import { ExperienceService } from "../../backend/src/experience/service.ts";
function runGit(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
export async function verifyRepositoryEntrypoints(root, passed) {
  const repo = path.join(root, "repo"),
    other = path.join(root, "clone"),
    worktree = path.join(root, "worktree"),
    plain = path.join(root, "plain");
  await mkdir(repo);
  await mkdir(plain);
  runGit(repo, "init");
  runGit(repo, "config", "user.email", "fixture@example.invalid");
  runGit(repo, "config", "user.name", "Fixture");
  await writeFile(
    path.join(repo, "AGENTS.md"),
    "Repository identity integration fixture\n",
  );
  runGit(repo, "add", ".");
  runGit(repo, "commit", "-m", "fixture");
  runGit(repo, "worktree", "add", "-b", "linked", worktree);
  runGit(root, "clone", repo, other);
  await mkdir(path.join(repo, "subdir"));
  await symlink(worktree, path.join(root, "link"));
  const identity = await resolveRepositoryIdentity(repo),
    id = identity.repositoryId;
  const experience = new ExperienceService({
    home: path.join(root, "experience"),
    namespace: "identity-fixture",
  });
  const savedExperience = await experience.save(repo, {
    id: "identity-preserved",
    title: "Preserved experience",
    triggers: [["fixture"]],
    applicability: "Identity fixture",
    avoid: ["Cross repository lookup"],
    actions: ["Use common directory"],
    verification: ["Compare saved revision"],
    expiresAt: "2099-01-01T00:00:00.000Z",
    state: "active",
    evidence: [
      {
        path: path.join(repo, "AGENTS.md"),
        startLine: 1,
        endLine: 1,
        note: "Fixture",
      },
    ],
  });
  for (const cwd of [
    repo,
    worktree,
    path.join(repo, "subdir"),
    path.join(root, "link"),
  ]) {
    assert.equal((await resolveRepositoryIdentity(cwd)).repositoryId, id);
    assert.equal((await experience.scope(cwd)).repositoryId, id);
    assert.deepEqual(
      (await experience.show(cwd, "identity-preserved")).record,
      savedExperience.record,
    );
  }
  assert.equal(
    id,
    createHash("sha256")
      .update(
        runGit(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"),
      )
      .digest("hex"),
  );
  passed(
    "identity-equivalence",
    "Main, worktree, subdirectory, symlink and Experience share the exact hash",
  );
  const otherId = (await resolveRepositoryIdentity(other)).repositoryId;
  assert.notEqual(id, otherId);
  process.env.GIT_DIR = path.join(other, ".git");
  assert.equal((await resolveRepositoryIdentity(repo)).repositoryId, id);
  delete process.env.GIT_DIR;
  await assert.rejects(
    resolveRepositoryIdentity(plain),
    /repository_git_required/,
  );
  runGit(
    repo,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    other,
    "module",
  );
  assert.notEqual(
    (await resolveRepositoryIdentity(path.join(repo, "module"))).repositoryId,
    id,
  );
  passed(
    "identity-isolation",
    "Clone and submodule differ; inherited Git variables and non-Git paths cannot select another repository",
  );

  return { repo, other, worktree, plain, identity, id, otherId };
}
