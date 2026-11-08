import { createServer, type Socket } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, openSync, rmSync } from "node:fs";
import { tryLock } from "fs-native-extensions";
import { processStartIdentity, readPrivateFile } from "@runweave/config-node";
import type { EnvironmentContext } from "@runweave/shared/configuration";
import { PTY_HOST_PROTOCOL_VERSION, type PtyHostDescriptor, type PtyHostInput } from "@runweave/shared/terminal/pty-host";
import { z } from "zod";
import { hostPaths, prepareHostDirectory, writeHostJson } from "./discovery";
import { HostGateway, isGatewayCredential } from "./gateway";
import { HostSession } from "./sessions";
import { receiveJsonLines, sendJson } from "./transport";

const scopeSchema = z.object({ kind: z.enum(["stable", "dev"]), instanceId: z.string().min(1), configRoot: z.string().min(1) });
const targetSchema = z.object({ hostInstanceId: z.string().uuid(), sessionInstanceId: z.string().uuid(), terminalSessionId: z.string().min(1), generation: z.number().int().positive() });
const createSchema = z.object({
  generation: z.number().int().positive(), sessionInstanceId: z.string().uuid(), terminalSessionId: z.string().min(1).max(256),
  projectId: z.string().min(1).max(256), command: z.string().min(1).max(32768), args: z.array(z.string()).max(256),
  cwd: z.string().min(1), cols: z.number().int().min(2).max(500), rows: z.number().int().min(1).max(200),
  env: z.record(z.string().optional()),
});
const wireSchema = z.object({ requestId: z.string().uuid(), token: z.string(), hostInstanceId: z.string().uuid(), action: z.string(), body: z.unknown() });

export async function startHost(scope: EnvironmentContext, release: string): Promise<void> {
  const paths = prepareHostDirectory(scope);
  const lock = openSync(paths.root + "/owner.lock", "a+", 0o600);
  if (!tryLock(lock)) { closeSync(lock); throw new Error("HOST_ALREADY_RUNNING"); }
  const token = readPrivateFile(paths.token, 256).trim();
  const hostInstanceId = randomUUID();
  const sessions = new Map<string, HostSession>();
  const sockets = new Set<Socket>();
  const gateway = new HostGateway(scope, paths.root, () => [...sessions.values()].map(session => session.describe()));
  let generation = 0;
  let writerId: string | undefined;
  let frozen = false;
  let descriptor: PtyHostDescriptor;
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    for (const session of sessions.values()) session.close();
    for (const socket of sockets) socket.destroy();
    await gateway.close();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    if (process.platform !== "win32") rmSync(paths.endpoint, { force: true });
    rmSync(paths.descriptor, { force: true });
    closeSync(lock);
  };

  const requireWriter = (value: number) => {
    if (value !== generation || !generation) throw new Error("HOST_WRITER_STALE");
  };
  const targetSession = (body: unknown, writing = true) => {
    const target = targetSchema.parse(body);
    if (writing) requireWriter(target.generation);
    const session = sessions.get(target.terminalSessionId);
    if (!session) throw new Error("HOST_SESSION_GONE");
    session.assertBinding(target);
    return session;
  };

  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    const subscriptions = new Map<string, () => void>();
    socket.on("close", () => {
      sockets.delete(socket);
      for (const unsubscribe of subscriptions.values()) unsubscribe();
    });
    receiveJsonLines(socket, message => {
      const parsed = wireSchema.safeParse(message);
      if (!parsed.success) { socket.destroy(); return; }
      const request = parsed.data;
      const reply = (result: unknown) => sendJson(socket, { requestId: request.requestId, result });
      const fail = (error: unknown) => sendJson(socket, { requestId: request.requestId,
        error: error instanceof z.ZodError ? "HOST_MESSAGE_INVALID" : (error as Error).message });
      if (!isGatewayCredential(request.token, token)) { fail(new Error("HOST_AUTH_FAILED")); socket.end(); return; }
      if (request.hostInstanceId !== hostInstanceId) { fail(new Error("HOST_IDENTITY_MISMATCH")); socket.end(); return; }
      void (async () => {
        if (request.action === "hello") {
          const expected = scopeSchema.parse(request.body);
          if (expected.kind !== scope.kind || expected.instanceId !== scope.instanceId || expected.configRoot !== scope.configRoot) throw new Error("HOST_IDENTITY_MISMATCH");
          return reply({ descriptor, generation, frozen, sessions: sessions.size, outboxIncomplete: gateway.outbox.incomplete });
        }
        if (request.action === "claimWriter") {
          const body = z.object({ ownerId: z.string().uuid(), expectedGeneration: z.number().int().nonnegative() }).parse(request.body);
          if (writerId === body.ownerId) return reply({ generation });
          if (frozen || body.expectedGeneration !== generation) throw new Error("HOST_WRITER_STALE");
          writerId = body.ownerId;
          return reply({ generation: ++generation });
        }
        if (request.action === "listSessions") return reply([...sessions.values()].map(session => session.describe()));
        if (request.action === "createSession") {
          if (frozen) throw new Error("HOST_BUSY");
          const { generation: requested, ...body } = createSchema.parse(request.body);
          requireWriter(requested);
          const previous = sessions.get(body.terminalSessionId);
          if (previous) {
            if (previous.createDigest !== createHash("sha256").update(JSON.stringify(body)).digest("hex")) throw new Error("HOST_INPUT_CONFLICT");
            return reply(await previous.ready());
          }
          if ([...sessions.values()].filter(session => session.info.status === "running").length >= 64) throw new Error("HOST_BUSY");
          if (sessions.size >= 256) {
            for (const [id, entry] of sessions) {
              if (entry.info.status !== "exited") continue;
              entry.screen.dispose();
              sessions.delete(id);
              if (sessions.size < 256) break;
            }
          }
          const session = new HostSession(hostInstanceId, body, secret => gateway.launchEnvironment(secret));
          sessions.set(body.terminalSessionId, session);
          return reply(await session.ready());
        }
        if (request.action === "setUpstreams") {
          gateway.setUpstreams(z.object({ backendUrl: z.string(), backendToken: z.string(), appServerUrl: z.string(), appServerToken: z.string() }).parse(request.body));
          return reply({ ok: true });
        }
        if (request.action === "freeze") {
          frozen = z.object({ frozen: z.boolean() }).parse(request.body).frozen;
          return reply({ frozen, generation });
        }
        if (request.action === "stop") {
          const { terminateSessions } = z.object({ terminateSessions: z.boolean() }).parse(request.body);
          if (!terminateSessions && [...sessions.values()].some(session => session.info.status === "running")) throw new Error("HOST_SESSIONS_ACTIVE");
          reply({ ok: true });
          setTimeout(() => { void shutdown(); }, 100);
          return;
        }
        const body = request.body as Record<string, unknown>;
        const session = targetSession(body, !["attachSession", "getSnapshot", "readOutput", "getInputOperation"].includes(request.action));
        if (request.action === "writeInput") {
          const input = z.object({ operationId: z.string(), sequence: z.number(), steps: z.array(z.union([
            z.object({ type: z.literal("text"), data: z.string() }), z.object({ type: z.literal("delay"), ms: z.number() }),
          ])) }).parse(body.input) as PtyHostInput;
          const operation = session.inputs.submit(input);
          return reply(body.wait === false ? operation.result : await operation.done);
        }
        if (request.action === "getInputOperation") return reply(session.inputs.get(z.string().parse(body.operationId)));
        if (request.action === "getSnapshot") return reply(await session.snapshot());
        if (request.action === "readOutput") {
          const cursor = z.object({ streamId: z.string(), offset: z.number() }).parse(body.cursor);
          return reply(session.buffer.read(cursor));
        }
        if (request.action === "resize") { session.resize(Number(body.cols), Number(body.rows)); return reply({ ok: true }); }
        if (request.action === "signal") { session.signal(z.string().parse(body.signal)); return reply({ ok: true }); }
        if (request.action === "closeSession") {
          session.close();
          const deadline = Date.now() + 5000;
          while (session.info.status === "running" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
          if (session.info.status === "running") throw new Error("HOST_CLOSE_TIMEOUT");
          return reply({ ok: true });
        }
        if (request.action === "attachSession") {
          subscriptions.get(session.info.terminalSessionId)?.();
          let ready = false;
          const output = (frame: import("./output-recovery").TerminalOutputFrame) => {
            if (ready) sendJson(socket, { type: "output", terminalSessionId: session.info.terminalSessionId, data: frame.data, cursor: session.buffer.cursor, range: frame.range });
          };
          const exited = (exitCode: number) => { sendJson(socket, { type: "exit", terminalSessionId: session.info.terminalSessionId, exitCode }); };
          const resized = (cols: number, rows: number) => {
            if (ready) sendJson(socket, { type: "resize", terminalSessionId: session.info.terminalSessionId, cols, rows, cursor: session.buffer.cursor });
          };
          session.outputListeners.add(output);
          session.exitListeners.add(exited);
          session.resizeListeners.add(resized);
          subscriptions.set(session.info.terminalSessionId, () => { session.outputListeners.delete(output); session.exitListeners.delete(exited); session.resizeListeners.delete(resized); });
          const snapshot = await session.snapshot();
          const tail = session.buffer.read(snapshot.cursor);
          if (!tail.ok) throw new Error("HOST_OUTPUT_GAP");
          reply({ session: session.describe(), snapshot, frames: tail.frames });
          ready = true;
          if (session.info.status === "exited") exited(session.info.exitCode ?? 0);
          return;
        }
        throw new Error("HOST_ACTION_INVALID");
      })().catch(fail);
    });
  });
  try {
    await gateway.start();
    if (process.platform !== "win32") rmSync(paths.endpoint, { force: true });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(paths.endpoint, resolve); });
    if (process.platform !== "win32") chmodSync(paths.endpoint, 0o600);
    const startedAt = processStartIdentity(process.pid);
    if (!startedAt) throw new Error("HOST_IDENTITY_UNAVAILABLE");
    descriptor = { protocolVersion: PTY_HOST_PROTOCOL_VERSION, hostInstanceId, pid: process.pid, startedAt,
      scope, endpoint: hostPaths(scope).endpoint, gatewayUrl: gateway.url, release };
    writeHostJson(paths.descriptor, descriptor);
    process.once("SIGTERM", () => { void shutdown(); });
    process.once("SIGINT", () => { void shutdown(); });
  } catch (error) { await shutdown(); throw error; }
}
