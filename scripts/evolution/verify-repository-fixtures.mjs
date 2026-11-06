import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile, symlink, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { resolveRepositoryIdentity } from "../../backend/src/repository/identity.ts";
import { EvolutionRepositoryScopes } from "../../backend/src/evolution/repository-scope.ts";
import { ExperienceService } from "../../backend/src/experience/service.ts";
import { createEvolutionFoundationRouter } from "../../backend/src/routes/evolution/foundation.ts";
import evolutionCommand from "../../packages/runweave-cli/src/commands/evolution.ts";
import profileStore from "../../packages/runweave-cli/src/config/profile-store.ts";
import {
  resolveConfigurationContext,
  withConfigurationArguments,
  ConfigurationStore,
  emptyConfiguration,
} from "../../packages/config-node/src/index.ts";
const { runEvolutionCommand } = evolutionCommand;
function runGit(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Exercise removal against the existing worker-backed database over HTTP and CLI. */
export async function verifyRepositoryRemoval(
  root,
  store,
  scopes,
  service,
  file,
  passed,
) {
  const require = createRequire(
    new URL("../../backend/package.json", import.meta.url),
  );
  const express = require("express");
  const Database = require("better-sqlite3");
  const instanceId = `${path.basename(root)}-removal`;
  const configArgs = ["--instance", instanceId];
  const configRoot = path.join(
    os.userInfo().homedir,
    ".runweave",
    "dev-sessions",
    instanceId,
  );
  const repo = path.join(root, "removable"),
    moved = `${repo}-moved`;
  await mkdir(repo);
  runGit(repo, "init");
  const { repositoryId } = await scopes.register(repo);
  const app = express();
  app.use(express.json());
  app.get("/health", (_request, response) =>
    response.json({
      environment: resolveConfigurationContext({ args: configArgs }),
    }),
  );
  app.use(
    "/api/evolution",
    (request, response, next) => {
      if (request.headers.authorization !== "Bearer fixture-token")
        return response.sendStatus(401);
      next();
    },
    createEvolutionFoundationRouter(service),
  );
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (suffix, body, token = "fixture-token") => {
    const response = await fetch(`${base}/api/evolution/scopes${suffix}`, {
      method: body ? "DELETE" : "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, text: await response.text() };
  };
  const cli = async (args) => {
    let output = "";
    await withConfigurationArguments(configArgs, () =>
      runEvolutionCommand(
        "repository",
        [...args, "--backend-port", String(server.address().port), "--json"],
        {
          stdout: {
            write: (text) => {
              output += text;
            },
          },
          env: process.env,
        },
      ),
    );
    return JSON.parse(output);
  };
  const snapshot = () => {
    const db = new Database(file, { readonly: true });
    try {
      return Object.fromEntries(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('evolution_repositories', 'evolution_repository_removals') ORDER BY name",
          )
          .all()
          .map(({ name }) => [
            name,
            db
              .prepare(
                `SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`,
              )
              .all(),
          ]),
      );
    } finally {
      db.close();
    }
  };
  try {
    await mkdir(configRoot, { recursive: true, mode: 0o700 });
    const context = resolveConfigurationContext({ args: configArgs });
    new ConfigurationStore(context).initialize(emptyConfiguration(context));
    await withConfigurationArguments(configArgs, () =>
      new profileStore.ProfileStore().saveProfile("local", {
        baseUrl: base,
        accessToken: "fixture-token",
      }),
    );
    const entry = (await cli(["list"])).repositories.find(
      (r) => r.repositoryId === repositoryId,
    );
    const request = {
      expectedRegistrationVersion: entry.registrationVersion,
      reason: "Fixture checkout no longer accessible",
    };
    assert.equal(
      (await api(`/${repositoryId}`, request, "wrong-token")).status,
      401,
    );
    assert.equal((await api(`/${repositoryId}`, {})).status, 400);
    assert.equal((await api(`/${repositoryId}`, request)).status, 409);
    await rename(repo, moved);
    // A concurrent registration change must invalidate the previously read version.
    const stored = (await store.repository({ op: "list" })).find(
      (r) => r.repositoryId === repositoryId,
    );
    await store.repository({
      op: "put",
      repository: { ...stored, projectIds: ["concurrent-registration"] },
    });
    assert.equal((await api(`/${repositoryId}`, request)).status, 409);
    const current = (await cli(["list"])).repositories.find(
      (r) => r.repositoryId === repositoryId,
    );
    const before = snapshot();
    const removed = await cli([
      "remove",
      repositoryId,
      "--expected-registration-version",
      current.registrationVersion,
      "--reason",
      request.reason,
    ]);
    assert.equal(removed.registrationHistory.at(-1).action, "removed");
    assert.notEqual(removed.registrationVersion, current.registrationVersion);
    assert.deepEqual(snapshot(), before);
    assert.ok(
      !(await cli(["list"])).repositories.some(
        (r) => r.repositoryId === repositoryId,
      ),
    );
    const readback = (
      await cli(["list", "--include-removed"])
    ).repositories.find((r) => r.repositoryId === repositoryId);
    assert.deepEqual(readback, removed);
    assert.equal(await scopes.queryScope(repositoryId), repositoryId);
    assert.equal(
      (
        await api(`/${repositoryId}`, {
          ...request,
          expectedRegistrationVersion: current.registrationVersion,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await api(`/${repositoryId}`, {
          ...request,
          expectedRegistrationVersion: removed.registrationVersion,
        })
      ).status,
      200,
    );
    assert.deepEqual(snapshot(), before);
    await rename(moved, repo);
    await assert.rejects(scopes.register(repo), /evolution_repository_removed/);
    const restoredProject = new EvolutionRepositoryScopes(
      store,
      () => [{ id: "restored-project", name: "Restored", path: repo }],
      () => repo,
    );
    assert.ok(
      !(await restoredProject.list()).some(
        (r) => r.repositoryId === repositoryId,
      ),
    );
    assert.ok(
      !(await cli(["list"])).repositories.some(
        (r) => r.repositoryId === repositoryId,
      ),
    );
    const archive = (
      await cli(["list", "--include-removed"])
    ).repositories.find((r) => r.repositoryId === repositoryId);
    assert.equal(archive.available, true);
    assert.equal(archive.registrationVersion, removed.registrationVersion);
    assert.deepEqual(archive.registrationHistory, removed.registrationHistory);
    // Execute the previous writer's exact SQL on an independent real connection.
    const legacy = new Database(file);
    try {
      assert.equal(
        legacy
          .prepare(
            "SELECT 1 FROM evolution_repositories WHERE repository_id = ?",
          )
          .get(repositoryId),
        undefined,
      );
      assert.throws(
        () =>
          legacy
            .prepare(
              "INSERT INTO evolution_repositories VALUES (?,?) ON CONFLICT(repository_id) DO UPDATE SET payload_json=excluded.payload_json",
            )
            .run(repositoryId, JSON.stringify(stored)),
        /evolution_repository_removed/,
      );
      assert.throws(
        () =>
          legacy
            .prepare(
              "UPDATE evolution_repository_removals SET payload_json = ? WHERE repository_id = ?",
            )
            .run("{}", repositoryId),
        /evolution_repository_removal_immutable/,
      );
      assert.throws(
        () =>
          legacy
            .prepare(
              "DELETE FROM evolution_repository_removals WHERE repository_id = ?",
            )
            .run(repositoryId),
        /evolution_repository_removal_immutable/,
      );
    } finally {
      legacy.close();
    }
    const afterLegacy = (
      await cli(["list", "--include-removed"])
    ).repositories.find((r) => r.repositoryId === repositoryId);
    assert.deepEqual(afterLegacy, archive);
    assert.deepEqual(snapshot(), before);
    assert.equal(await scopes.queryScope(repositoryId), repositoryId);
    passed(
      "repository-removal",
      "Authenticated HTTP and CLI against real Git/SQLite worker: live checkout rejected, stale version rejected, removed registration hidden and read back, historical scope and other data preserved; recovered paths, project discovery and real legacy SQL cannot restore the registration or overwrite its archive",
    );
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(configRoot, { recursive: true, force: true });
  }
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
