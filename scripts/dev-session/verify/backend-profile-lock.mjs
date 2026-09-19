import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import {
  backendHealthHeaders,
  persistBackendHealthAuth,
  readBackendHealthAuth,
} from "../../lib/backend-health-auth.mjs";
import { fetchHealthJson } from "../services/runtime.mjs";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { once } from "node:events";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);

export async function verifyBackendProfileLockPublication(
  sourceRoot,
  temporaryHome,
) {
  const profileDir = path.join(temporaryHome, "backend-profile-lock");
  const verificationSource = `
    import { mkdir, open, readFile, rm, utimes } from "node:fs/promises";
    import path from "node:path";
    import { execFileSync } from "node:child_process";
    import {
      acquireBackendProfileLock,
      BackendProfileLockConflictError,
    } from "./src/server/profile-lock.ts";

    void (async () => {
    const profileDir = process.env.RUNWEAVE_VERIFY_PROFILE_DIR;
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    const lockFile = path.join(profileDir, "backend.lock.json");
    const partialCreator = await open(lockFile, "wx", 0o600);
    await utimes(lockFile, new Date(0), new Date(0));
    let partialFailedClosed = false;
    try {
      await acquireBackendProfileLock({
        devSessionId: "dvs-profile-competitor",
        profileDir,
        port: 6206,
        host: "127.0.0.1",
      });
    } catch (error) {
      partialFailedClosed = error instanceof BackendProfileLockConflictError;
    }
    await partialCreator.close();
    await rm(lockFile);

    const lock = await acquireBackendProfileLock({
      devSessionId: "dvs-profile-owner",
      profileDir,
      port: 6206,
      host: "127.0.0.1",
    });
    const createdOwner = JSON.parse(await readFile(lockFile, "utf8"));
    await lock.update({ port: 6207 });
    const updatedOwner = JSON.parse(await readFile(lockFile, "utf8"));
    await lock.release();
    process.stdout.write(JSON.stringify({
      partialFailedClosed,
      createdDevSessionId: createdOwner.devSessionId,
      createdPort: createdOwner.port,
      updatedPort: updatedOwner.port,
      generationPublished: createdOwner.processSignature === execFileSync(
        "/bin/ps", ["-p", String(process.pid), "-o", "lstart=", "-o", "command="],
        { encoding: "utf8", env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" } },
      ).trim(),
      generationStable: createdOwner.processSignature === updatedOwner.processSignature,
      identityStable:
        createdOwner.backendId === updatedOwner.backendId &&
        createdOwner.pid === updatedOwner.pid,
    }) + "\\n");
    })().catch((error) => {
      console.error(error);
      process.exit(1);
    });
  `;
  const { stdout } = await execFileAsync(
    "pnpm",
    ["-C", "backend", "exec", "tsx", "-e", verificationSource],
    {
      cwd: sourceRoot,
      env: {
        ...process.env,
        RUNWEAVE_VERIFY_PROFILE_DIR: profileDir,
      },
    },
  );
  const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
  assert.deepEqual(result, {
    partialFailedClosed: true,
    createdDevSessionId: "dvs-profile-owner",
    createdPort: 6206,
    updatedPort: 6207,
    generationPublished: true,
    generationStable: true,
    identityStable: true,
  });
}

export async function verifyPrivateBackendHealth(temporaryHome) {
  const profileDir = path.join(temporaryHome, "health-profile");
  const secret = randomBytes(32).toString("hex");
  const owner = "dvs-health";
  let expectedSecret = secret;
  let redirect = false;
  let redirectRequests = 0;
  let authenticatedRequests = 0;
  const destination = createServer((_request, response) => {
    redirectRequests += 1;
    response.end("{}");
  });
  const server = createServer((request, response) => {
    if (request.headers.authorization) authenticatedRequests += 1;
    if (
      request.headers.authorization !==
      (expectedSecret ? `Bearer ${expectedSecret}` : undefined)
    ) {
      response.writeHead(401).end();
      return;
    }
    if (redirect) {
      response
        .writeHead(302, {
          Location: `http://127.0.0.1:${destination.address().port}/healthz`,
        })
        .end();
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ status: "ok" }));
  });
  // Self-published fixture generations, captured before probes, model the
  // Backend publication boundary; never manufacture trust from a stale lock.
  const unrelated = spawn(
    process.execPath,
    [
      "-e",
      `
    const {execFileSync}=require('node:child_process');
    process.send({pid:process.pid,processSignature:execFileSync('/bin/ps',
      ['-p',String(process.pid),'-o','lstart=','-o','command='],
      {encoding:'utf8',env:{...process.env,LC_ALL:'C',LANG:'C',TZ:'UTC'}}).trim()});
    let server;
    let authenticated = 0;
    process.on('message', async (options) => {
      try {
        if (server) { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
        server = undefined;
        if (options.host) {
          server = require('node:http').createServer((request,response)=>{
            if (request.headers.authorization) authenticated++;
            response.end('{}');
          });
          await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(options,resolve);});
        }
        process.send({port:server?.address().port,authenticated});
      } catch(error) { process.send({error:error.code || 'fixture listener failed'}); }
    });
  `,
    ],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  const originalLocale = {
    LC_ALL: process.env.LC_ALL,
    LANG: process.env.LANG,
    TZ: process.env.TZ,
  };
  try {
    const [unrelatedIdentity] = await once(unrelated, "message");
    const childListen = async (options) => {
      const message = once(unrelated, "message");
      unrelated.send(options);
      const [result] = await message;
      assert.equal(result.error, undefined);
      assert.equal(result.authenticated, 0);
      return result;
    };
    const { stdout } = await execFileAsync(
      "/bin/ps",
      ["-p", String(process.pid), "-o", "lstart=", "-o", "command="],
      {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" },
      },
    );
    const generation = stdout.trim();
    const { build } = createRequire(path.resolve("electron/package.json"))(
      "esbuild",
    );
    const electronHelper = path.join(temporaryHome, "electron-health-auth.mjs");
    const adapters = [];
    for (const [file, outfile] of [
      ["electron/src/backend/health-auth.ts", electronHelper],
      [
        "scripts/lib/backend-health-auth.mjs",
        path.join(temporaryHome, "scripts-health-auth.mjs"),
      ],
    ]) {
      // Fixture-only exports exercise the actual private parsers, without a
      // production API/test hook or replacing the real HTTP probe helpers.
      await build({
        stdin: {
          contents: `${await readFile(file, "utf8")}\nexport { healthListenerPidsForEndpoint, healthListenerMatchesEndpoint };`,
          resolveDir: path.dirname(path.resolve(file)),
          loader: file.endsWith(".ts") ? "ts" : "js",
        },
        outfile,
        bundle: true,
        platform: "node",
        format: "esm",
        logLevel: "silent",
      });
      adapters.push(await import(pathToFileURL(outfile).href));
    }
    const { localBackendAuthHeaders, restoreOwnedBackendHealthEnv } =
      adapters[0];
    for (const name of [
      "healthListenerPidsForEndpoint",
      "healthListenerMatchesEndpoint",
    ])
      assert.equal(adapters[0][name].toString(), adapters[1][name].toString());
    const inventory = (pid, family, name) =>
      `p${pid}\0\nf12\0t${family}\0n${name}\0\n`;
    for (const { healthListenerPidsForEndpoint: parse } of adapters) {
      const v4 = new URL("http://127.0.0.1:42424/health");
      const v6 = new URL("http://[::1]:42424/health");
      for (const [family, address, match4, match6] of [
        ["IPv4", "127.0.0.1", true, false],
        ["IPv4", "172.20.10.2", false, false],
        ["IPv4", "*", true, false],
        ["IPv4", "0.0.0.0", true, false],
        ["IPv6", "*", true, true],
        ["IPv6", "[::]", true, true],
        ["IPv6", "[0:0:0:0:0:0:0:1]", false, true],
        ["IPv6", "127.0.0.1", true, false],
        ["IPv6", "0.0.0.0", true, false],
        ["IPv6", "[::ffff:127.0.0.1]", true, false],
        ["IPv6", "[::ffff:0.0.0.0]", true, false],
        ["IPv6", "[::ffff:7f00:1]", true, false],
        ["IPv6", "[::ffff:0:0]", true, false],
        ["IPv6", "[::ffff:172.20.10.2]", false, false],
        ["IPv6", "[2001:db8::1]", false, false],
        ["IPv6", "[fe80::1%en0]", false, false],
      ]) {
        const text = inventory(7, family, `${address}:42424`);
        assert.deepEqual(parse(text, v4), match4 ? [7] : []);
        assert.deepEqual(parse(text, v6), match6 ? [7] : []);
      }
      const own = inventory(7, "IPv4", "127.0.0.1:42424");
      assert.deepEqual(
        parse(own + inventory(8, "IPv4", "172.20.10.2:42424"), v4),
        [7],
      );
      assert.deepEqual(
        parse(own + inventory(8, "IPv6", "*:42424"), v4),
        [7, 8],
      );
      for (const bad of [
        "",
        own.slice(0, -1),
        "p7\0\n",
        own.replace("p7\0\n", ""),
        own.replace("tIPv4", "tunknown"),
        own.replace("tIPv4", "f13"),
        own.replace("f12", "f12\0xunknown"),
        own.replace("p7", "p0"),
        inventory(7, "IPv4", "localhost:42424"),
        inventory(7, "IPv4", "127.0.0.1:42425"),
        inventory(7, "IPv4", "[::1]:42424"),
        inventory(7, "IPv6", "[not-numeric]:42424"),
        inventory(7, "IPv6", "[127.0.0.1]:42424"),
        inventory(7, "IPv6", "[::1%]:42424"),
      ])
        assert.throws(() => parse(bad, v4));
    }
    const electronProbe = async (url, ownedEnv, expectedPid) => {
      try {
        const headers = localBackendAuthHeaders(
          url,
          profileDir,
          ownedEnv,
          expectedPid,
        );
        const response = await fetch(url, {
          headers,
          redirect: "error",
          signal: AbortSignal.timeout(1_000),
        });
        return response.ok ? await response.json() : null;
      } catch {
        return null;
      }
    };
    const probes = [
      (url) => fetchHealthJson(url, profileDir),
      (url) => electronProbe(url),
      (url) =>
        electronProbe(
          url,
          { RUNWEAVE_TUNNEL_TOKEN: secret, RUNWEAVE_DEV_SESSION_ID: owner },
          process.pid,
        ),
    ];
    await new Promise((resolve) => destination.listen(0, "127.0.0.1", resolve));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}/health`;
    const lockPath = path.join(profileDir, "backend.lock.json");
    await persistBackendHealthAuth(profileDir, owner, {
      RUNWEAVE_TUNNEL_TOKEN: secret,
      RUNWEAVE_TUNNEL_AUTH_SCOPE: "all",
    });
    const configPath = path.join(profileDir, "backend-health-auth.json");
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    const lock = {
      pid: process.pid,
      processSignature: generation,
      host: "127.0.0.1",
      port: server.address().port,
      devSessionId: owner,
    };
    await writeFile(lockPath, JSON.stringify(lock), { mode: 0o600 });
    assert.equal(await fetchHealthJson(url), null);
    // Later callers need neither the original tunnel env nor original locale.
    Object.assign(process.env, {
      LC_ALL: "C.UTF-8",
      LANG: "C.UTF-8",
      TZ: "Asia/Tokyo",
    });
    for (const probe of probes)
      assert.deepEqual(await probe(url), { status: "ok" });
    // Real simultaneous different-PID, same-port, different IPv4 address.
    // Bind only this fixture's ephemeral port; never inspect or touch port 5003.
    const otherAddress =
      Object.values(networkInterfaces())
        .flat()
        .find(
          (entry) => entry?.family === "IPv4" && entry.address !== "127.0.0.1",
        )?.address ?? "127.0.0.2";
    await childListen({ host: otherAddress, port: lock.port });
    const emitted = (
      await execFileAsync(
        process.platform === "darwin" ? "/usr/sbin/lsof" : "/usr/bin/lsof",
        ["-nP", `-iTCP:${lock.port}`, "-sTCP:LISTEN", "-F0pftn"],
        { encoding: "utf8", timeout: 1_000, maxBuffer: 65_536 },
      )
    ).stdout;
    assert(emitted.includes(`p${unrelatedIdentity.pid}\0`));
    for (const adapter of adapters)
      assert(
        adapter
          .healthListenerPidsForEndpoint(emitted, new URL(url))
          .every((pid) => pid === process.pid),
      );
    for (const probe of probes)
      assert.deepEqual(await probe(url), { status: "ok" });

    // V6ONLY is not reported by lsof: a foreign IPv6 wildcard must still
    // block IPv4 credential delivery, even alongside our own IPv4 listener.
    await childListen({ host: "::", port: lock.port, ipv6Only: true });
    const beforeWildcardRefusal = authenticatedRequests;
    for (const probe of probes) assert.equal(await probe(url), null);
    assert.equal(authenticatedRequests, beforeWildcardRefusal);
    const foreignWildcard = await childListen({ host: "0.0.0.0", port: 0 });
    await writeFile(
      lockPath,
      JSON.stringify({ ...lock, port: foreignWildcard.port }),
    );
    for (const probe of probes)
      assert.equal(
        await probe(`http://127.0.0.1:${foreignWildcard.port}/health`),
        null,
      );
    await childListen({}); // Also proves the foreign listeners received no credentials.

    // Actual lsof output + HTTP for own wildcard, IPv6 loopback and mapped
    // sockets (macOS emits a dotted IPv4 name with tIPv6 for mapped binds).
    for (const [host, targetHost] of [
      ["0.0.0.0", "127.0.0.1"],
      ["::", "[::1]"],
      ["::", "127.0.0.1"],
      ["::1", "[::1]"],
      ["::ffff:127.0.0.1", "127.0.0.1"],
    ]) {
      const listener = createServer(server.listeners("request")[0]);
      try {
        await new Promise((resolve, reject) => {
          listener.once("error", reject);
          listener.listen({ port: 0, host }, resolve);
        });
        const port = listener.address().port;
        await writeFile(
          lockPath,
          JSON.stringify({
            ...lock,
            port,
            host: targetHost === "127.0.0.1" ? "0.0.0.0" : "::",
          }),
        );
        for (const probe of probes)
          assert.deepEqual(await probe(`http://${targetHost}:${port}/health`), {
            status: "ok",
          });
      } finally {
        listener.closeAllConnections();
        await new Promise((resolve) => listener.close(resolve));
      }
    }
    await writeFile(lockPath, JSON.stringify(lock));
    await childListen({ host: otherAddress, port: lock.port });
    const beforeExpectedPidFailure = authenticatedRequests;
    assert.equal(
      await electronProbe(
        url,
        { RUNWEAVE_TUNNEL_TOKEN: secret, RUNWEAVE_DEV_SESSION_ID: owner },
        unrelatedIdentity.pid,
      ),
      null,
    );
    assert.equal(authenticatedRequests, beforeExpectedPidFailure);
    redirect = true;
    for (const probe of probes) assert.equal(await probe(url), null);
    assert.equal(redirectRequests, 0);
    redirect = false;
    for (const rejected of [
      "http://example.com/health",
      `${url}?token=forbidden`,
      url.replace("/health", "/healthz"),
      url.replace("/health", "/json/version"),
    ]) {
      await assert.rejects(backendHealthHeaders(rejected, profileDir));
      assert.throws(() => localBackendAuthHeaders(rejected, profileDir));
    }
    for (const change of [
      { port: destination.address().port },
      { devSessionId: "another-owner" },
      { host: "::1" },
      { processSignature: undefined },
      // Same PID/port but signature from a different original generation: PID reuse model.
      { processSignature: unrelatedIdentity.processSignature },
      // A matching original/live generation and unrelated socket do not prove target ownership.
      unrelatedIdentity,
    ]) {
      await writeFile(lockPath, JSON.stringify({ ...lock, ...change }));
      const before = authenticatedRequests;
      for (const probe of probes) assert.equal(await probe(url), null);
      assert.equal(authenticatedRequests, before);
    }
    await writeFile(lockPath, JSON.stringify({ ...lock, devSessionId: null }));
    await persistBackendHealthAuth(profileDir, null, {
      RUNWEAVE_TUNNEL_TOKEN: secret,
    });
    assert.deepEqual(await fetchHealthJson(url, profileDir), { status: "ok" });
    assert.deepEqual(await electronProbe(url), { status: "ok" });
    await writeFile(lockPath, JSON.stringify(lock));
    // A valid transport identity may still fail the application handshake.
    // Its diagnostic retry must be unauthenticated, not a second secret send.
    const sourceRoot = path.resolve(process.cwd());
    const diagnosticProfile = path.join(
      temporaryHome,
      ".runweave",
      "browser-profile",
      createHash("sha256").update(sourceRoot).digest("hex").slice(0, 8),
    );
    await persistBackendHealthAuth(diagnosticProfile, null, {
      RUNWEAVE_TUNNEL_TOKEN: secret,
    });
    await writeFile(
      path.join(diagnosticProfile, "backend.lock.json"),
      JSON.stringify({
        ...lock,
        devSessionId: null,
        backendId: "fixture",
        startedAt: new Date().toISOString(),
        cwd: sourceRoot,
      }),
      { mode: 0o600 },
    );
    const beforeDiagnostic = authenticatedRequests;
    const diagnostic = await execFileAsync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { resolveSharedBackend } from './scripts/dev-session/services/shared.mjs';
      const service = await resolveSharedBackend(process.cwd(), 'fixture-revision');
      console.log(JSON.stringify({unavailable: service === null}));
    `,
      ],
      { cwd: sourceRoot, env: { ...process.env, HOME: temporaryHome } },
    );
    assert.equal(JSON.parse(diagnostic.stdout.trim()).unavailable, true);
    assert.equal(authenticatedRequests - beforeDiagnostic, 1);
    await writeFile(configPath, `invalid-${secret}`);
    await assert.rejects(
      backendHealthHeaders(url, profileDir),
      (error) => !error.message.includes(secret),
    );
    assert.throws(
      () => localBackendAuthHeaders(url, profileDir),
      (error) => !error.message.includes(secret),
    );

    // Byte limit applies to the serialized JSON, not unescaped token length.
    const overhead = Buffer.byteLength(
      JSON.stringify({ ownerDevSessionId: owner, token: "", scope: "all" }),
    );
    const remaining = 16_384 - overhead;
    const boundaryToken =
      '"'.repeat(Math.floor(remaining / 2)) + (remaining % 2 ? "a" : "");
    await persistBackendHealthAuth(profileDir, owner, {
      RUNWEAVE_TUNNEL_TOKEN: boundaryToken,
      RUNWEAVE_TUNNEL_AUTH_SCOPE: "all",
    });
    assert.equal((await stat(configPath)).size, 16_384);
    assert.equal(
      (await readBackendHealthAuth(profileDir)).token === boundaryToken,
      true,
    );
    assert.equal(
      restoreOwnedBackendHealthEnv({
        BROWSER_PROFILE_DIR: profileDir,
        RUNWEAVE_DEV_SESSION_ID: owner,
      }).RUNWEAVE_TUNNEL_TOKEN === boundaryToken,
      true,
    );
    const previous = await readFile(configPath, "utf8");
    for (const token of [
      boundaryToken + "a",
      '"'.repeat(8_192),
      "\\".repeat(8_192),
    ]) {
      await assert.rejects(
        persistBackendHealthAuth(profileDir, owner, {
          RUNWEAVE_TUNNEL_TOKEN: token,
          RUNWEAVE_TUNNEL_AUTH_SCOPE: "all",
        }),
        (error) =>
          error.message === "oversized private Backend health configuration",
      );
      assert.equal((await readFile(configPath, "utf8")) === previous, true);
    }
    await persistBackendHealthAuth(profileDir, owner, {});
    expectedSecret = null;
    // No-token legacy health must not depend on new lock metadata/OS proof.
    await writeFile(
      lockPath,
      JSON.stringify({ ...lock, processSignature: undefined }),
    );
    assert.deepEqual(await fetchHealthJson(url, profileDir), { status: "ok" });
    assert.deepEqual(await electronProbe(url), { status: "ok" });
  } finally {
    for (const [key, value] of Object.entries(originalLocale)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    server.closeAllConnections();
    destination.closeAllConnections();
    await Promise.all(
      [server, destination].map(
        (fixture) => new Promise((resolve) => fixture.close(resolve)),
      ),
    );
    const exited = once(unrelated, "exit");
    unrelated.kill("SIGTERM");
    await exited;
  }
}
