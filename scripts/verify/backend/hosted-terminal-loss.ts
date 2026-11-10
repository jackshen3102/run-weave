import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configuration } from "@runweave/config-node";
import type { PtyHostSession } from "@runweave/shared/terminal/pty-host";
import { isolateLifecycle as isolate } from "../recovery/lifecycle-fixture.mjs";

// Integration fixture: real native Host, durable terminal store and WebSocket.
export async function verifyHostedTerminalLoss(): Promise<string> {
  const directory = await isolate("hosted-terminal-loss");
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const release = path.join(directory, "release");
  const require = createRequire(path.join(repo, "packages/runweave-cli/package.json"));
  const { build } = require("esbuild");
  const { copyNativeLockRuntime } = await import("../../../packages/config-node/scripts/native-runtime.mjs");
  const { ensureHost, readHost } = await import("../../../packages/pty-host/src/lifecycle");
  const { PtyHostClient } = await import("../../../packages/pty-host/src/client");
  const { ensureHostedTerminal } = await import("../../../backend/src/terminal/runtime/pty-host-runtime");
  const { createHostedPty, disconnectPtyHost } = await import("../../../backend/src/terminal/runtime/pty-host-client");
  const { TerminalSessionManager } = await import("../../../backend/src/terminal/manager/manager");
  const { LowDbTerminalSessionStore } = await import("../../../backend/src/terminal/store/lowdb-store");
  const { TerminalRuntimeRegistry } = await import("../../../backend/src/terminal/runtime/registry");
  const { TerminalStateService } = await import("../../../backend/src/terminal/state/terminal-state-service");
  const { TerminalStateStore } = await import("../../../backend/src/terminal/state/terminal-state-store");
  const { processTerminalAgentHook } = await import("../../../backend/src/terminal/application/agent-hook-processor");
  const { toSessionListItem, toStatusPayload } = await import("../../../backend/src/terminal/application/payloads");
  const { createHttpUpgradeRouter } = await import("../../../backend/src/server/http-upgrade-router");
  const { attachTerminalWebSocketServer } = await import("../../../backend/src/ws/terminal-server");
  const { WebSocket } = createRequire(path.join(repo, "backend/package.json"))("ws");
  await build({ bundle: true, platform: "node", target: "node22", format: "cjs",
    external: ["node-pty", "fs-native-extensions"],
    define: { "import.meta.url": "__IMPORT_META_URL__" },
    banner: { js: "const __IMPORT_META_URL__ = require('url').pathToFileURL(__filename).href;" },
    entryPoints: [path.join(repo, "packages/pty-host/src/index.ts")], outfile: path.join(release, "pty-host/index.cjs") });
  copyNativeLockRuntime(path.join(release, "pty-host"));
  await cp(path.join(repo, "backend/node_modules/node-pty"), path.join(release, "pty-host/node_modules/node-pty"), { recursive: true, dereference: true });
  const scope = configuration().context;
  // The lifecycle bootstrap overrides os.tmpdir(); detached Hosts must use
  // the same directory when deriving their private local socket endpoint.
  process.env.TMPDIR = os.tmpdir();
  process.env.TEMP = os.tmpdir();
  process.env.TMP = os.tmpdir();
  const storeFile = path.join(directory, "sessions.json");
  const registry = new TerminalRuntimeRegistry();
  const state = new TerminalStateService(new TerminalStateStore());
  let manager = new TerminalSessionManager(new LowDbTerminalSessionStore(storeFile));
  let observer: InstanceType<typeof PtyHostClient> | undefined;
  const server = createServer();
  const sockets: InstanceType<typeof WebSocket>[] = [];
  const terminalIds: string[] = [];
  const originalBindings = new Map<string, string>();
  // Recovery must not launch real user CLIs. Exercise the native Host and shell
  // with tiny executable fixtures that capture the actual resume arguments.
  const bin = path.join(directory, "bin");
  await mkdir(bin, { recursive: true });
  for (const provider of ["traex", "traecli"]) {
    const capture = path.join(directory, `${provider}.args`);
    const script = process.platform === "win32"
      ? `@echo off\r\n>> "${capture}" echo %1\r\n>> "${capture}" echo %2\r\necho HOST_RESUME_${provider}\r\n`
      : `#!/bin/sh\nprintf '%s\\n' "$@" >> '${capture.replaceAll("'", "'\\''")}'\nprintf 'HOST_RESUME_${provider}\\n'\n`;
    await writeFile(path.join(bin, `${provider}${process.platform === "win32" ? ".cmd" : ""}`), script, { mode: 0o700 });
  }
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
  const command = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
  const args = process.platform === "win32" ? ["-NoProfile", "-NoLogo"] : [];
  const wait = async (predicate: () => boolean, label: string) => {
    const deadline = Date.now() + 10_000;
    while (!predicate()) {
      assert(Date.now() < deadline, label);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  const startHost = async () => {
    try { await ensureHost(scope, release); }
    catch (error) {
      const log = await readFile(path.join(scope.configRoot, "runtime/pty-host/host.log"), "utf8").catch(() => "no Host log");
      throw new Error(`${String(error)}: ${log.slice(-6000)}`);
    }
  };
  try {
    await manager.initialize();
    await startHost();
    observer = await PtyHostClient.connect(scope);
    const oldHostId = observer.descriptor.hostInstanceId;
    for (const provider of ["traex", "traecli"] as const) {
      const providerCommand = process.platform === "win32" ? `${provider}.exe` : provider;
      const session = await manager.createSession({ command, args, cwd: directory });
      terminalIds.push(session.id);
      await ensureHostedTerminal({ session, terminalSessionManager: manager, runtimeRegistry: registry });
      originalBindings.set(session.id, session.ptyHost!.sessionInstanceId);
      // Provider facts are supplied explicitly; no CLI conversation is fabricated.
      const started = await processTerminalAgentHook({ terminalSessionManager: manager, terminalStateService: state }, {
        terminalSessionId: session.id, agent: provider, hookEvent: "SessionStart", threadId: `saved-${provider}`, commandName: providerCommand,
      });
      assert.equal(started.status, "recorded");
      assert.equal(session.threadId, `saved-${provider}`);
      assert.equal(session.threadProvider, provider);
      await manager.updateSessionMetadata(session.id, { cwd: directory, activeCommand: providerCommand });
      const submitted = await processTerminalAgentHook({ terminalSessionManager: manager, terminalStateService: state }, {
        terminalSessionId: session.id, agent: provider, hookEvent: "UserPromptSubmit", threadId: `saved-${provider}`, commandName: providerCommand,
      });
      assert.equal(submitted.status, "recorded");
      if (provider === "traecli") {
        const stopped = await processTerminalAgentHook({ terminalSessionManager: manager, terminalStateService: state }, {
          terminalSessionId: session.id, agent: provider, hookEvent: "Stop", threadId: `saved-${provider}`, commandName: providerCommand,
        });
        assert.equal(stopped.status, "recorded");
        assert.equal(session.lastThreadId, `saved-${provider}`);
        assert.equal(session.lastThreadProvider, provider);
      }
      manager.appendOutput(session.id, `\r\nSAVED_HISTORY_${provider}\r\n`);
      await registry.disposeRuntime(session.id);
    }
    // Backend is offline before the Host is replaced, leaving persisted running records.
    await manager.dispose();
    await observer.request("stop", { terminateSessions: true });
    observer.close();
    await wait(() => { try { readHost(scope); return false; } catch { return true; } }, "old fixture Host stopped");
    await startHost();
    observer = await PtyHostClient.connect(scope);
    assert.notEqual(observer.descriptor.hostInstanceId, oldHostId);
    manager = new TerminalSessionManager(new LowDbTerminalSessionStore(storeFile));
    await manager.initialize();
    for (const id of terminalIds) {
      const session = manager.getSession(id)!;
      assert.equal(session.status, "running");
      const provider = session.threadProvider ?? session.lastThreadProvider;
      const { runtime, warning } = await ensureHostedTerminal({ session, terminalSessionManager: manager, runtimeRegistry: registry });
      assert.match(warning!, /Original PTY Host session was lost; starting .* resume/);
      assert.equal(session.status, "running");
      assert.equal(session.ptyHost!.hostInstanceId, observer.descriptor.hostInstanceId);
      assert.notEqual(session.ptyHost!.sessionInstanceId, originalBindings.get(id));
      assert.equal(session.threadId ?? session.lastThreadId, `saved-${provider}`);
      await wait(() => session.scrollback.includes(`HOST_RESUME_${provider}`), "saved provider resumed in replacement Host");
      const captured = await readFile(path.join(directory, `${provider}.args`), "utf8");
      assert.deepEqual(captured.trim().split(/\r?\n/).map(value => value.trim()), ["resume", `saved-${provider}`]);
      assert.equal((await ensureHostedTerminal({ session, terminalSessionManager: manager, runtimeRegistry: registry })).runtime, runtime,
        "reattach reuses the replacement instead of replaying resume");
      assert.equal(await readFile(path.join(directory, `${provider}.args`), "utf8"), captured);
    }
    // Creating with the wrong Host identity still rejects as an identity violation.
    await assert.rejects(createHostedPty({ terminalSessionId: terminalIds[0], binding: { hostInstanceId: oldHostId, sessionInstanceId: crypto.randomUUID() },
      create: { terminalSessionId: terminalIds[0], sessionInstanceId: crypto.randomUUID(), projectId: "fixture", command, args, cwd: directory, cols: 80, rows: 24, env: {} } }), /HOST_IDENTITY_MISMATCH/);
    assert.equal((await observer.request<unknown[]>("listSessions")).length, terminalIds.length,
      "each lost running terminal creates exactly one replacement");
    // Explicitly exited terminals remain historical. Losing a Host alone no
    // longer archives a running terminal under the current recovery contract.
    for (const id of terminalIds) {
      await registry.getSessionRuntime(id)!.hosted!.close();
      await wait(() => manager.getSession(id)!.status === "exited", "explicit terminal exit recorded");
      await registry.disposeRuntime(id);
    }
    await manager.dispose();
    manager = new TerminalSessionManager(new LowDbTerminalSessionStore(storeFile));
    await manager.initialize();
    for (const id of terminalIds) {
      const session = manager.getSession(id)!;
      assert.equal(session.status, "exited");
      const provider = session.threadProvider ?? session.lastThreadProvider;
      assert.equal(session.threadId ?? session.lastThreadId, `saved-${provider}`, "thread must persist after a second Backend restart");
      for (const payload of [toStatusPayload(session), toSessionListItem(session)]) {
        assert.equal(payload.status, "exited");
        assert.equal(payload.threadId ?? payload.lastThreadId, `saved-${provider}`);
        assert.equal(payload.threadProvider ?? payload.lastThreadProvider, provider);
      }
    }
    attachTerminalWebSocketServer(createHttpUpgradeRouter(server), manager, registry, {
      verifyTemporaryToken: (token: string) => token === "fixture-ticket" ? { username: "fixture" } : null,
    } as never);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as import("node:net").AddressInfo).port;
    for (const id of terminalIds) {
      const messages: Record<string, unknown>[] = [];
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?terminalSessionId=${id}&token=fixture-ticket`);
      sockets.push(socket);
      socket.on("message", raw => messages.push(JSON.parse(String(raw))));
      await wait(() => messages.some(message => message.type === "status"), "archived terminal handshake");
      assert.equal(messages[0].type, "connected");
      assert.ok(String(messages.find(message => message.type === "snapshot")?.data).includes("SAVED_HISTORY_"));
      assert.equal(messages.find(message => message.type === "status")?.status, "exited");
      assert.ok(!messages.some(message => message.type === "error"));
      socket.send(JSON.stringify({ type: "input", data: "must-not-run\r" }));
      socket.send(JSON.stringify({ type: "request-status" }));
      await wait(() => messages.filter(message => message.type === "status").length === 2, "archived status response");
      socket.close();
    }
    const archived = await observer.request<PtyHostSession[]>("listSessions");
    assert.equal(archived.length, terminalIds.length, "reading archived history must not create new PTYs");
    assert.ok(archived.every(session => session.status === "exited" && terminalIds.includes(session.terminalSessionId)));
    const fresh = await manager.createSession({ command, args, cwd: directory });
    const { runtime } = await ensureHostedTerminal({ session: fresh, terminalSessionManager: manager, runtimeRegistry: registry });
    await runtime.hosted!.writeSteps([{ type: "text", data: "echo FRESH_TERMINAL_OK\r" }]);
    await wait(() => /\r?\nFRESH_TERMINAL_OK\r?\n/.test(manager.getSession(fresh.id)!.scrollback), "new terminal executes input");
    return "verified Host replacement resumes exact current/last Traex/TraeCLI IDs once with new bindings; explicitly exited terminals preserve WS history across Backend reopens; new PTY accepts input";
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    for (const socket of sockets) socket.terminate();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    for (const session of manager.listSessions()) await registry.disposeRuntime(session.id);
    await manager.dispose();
    await disconnectPtyHost();
    try { observer ??= await PtyHostClient.connect(scope); await observer.request("stop", { terminateSessions: true }); } catch { /* Fixture only. */ }
    observer?.close();
    await wait(() => { try { readHost(scope); return false; } catch { return true; } }, "fixture Host cleanup");
  }
}

