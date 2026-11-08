import { randomUUID } from "node:crypto";
import { configuration } from "@runweave/config-node";
import { PtyHostClient } from "@runweave/pty-host/client";
import type { PtyHostBinding, PtyHostSession, PtyHostInputResult, PtyHostInputStep, PtyHostCreateSession, PtyHostUpstreams, PtyHostSnapshot } from "@runweave/shared/terminal/pty-host";
import type { TerminalOutputCursor } from "@runweave/shared/terminal/websocket";
import type { TerminalOutputFrame, TerminalOutputReplay } from "./output-recovery";
import type { PtyRuntime } from "./pty-service";

const ownerId = randomUUID();
let connection: Promise<PtyHostClient> | undefined;
let generation: number | undefined;
let hostInstanceId: string | undefined;
let stopped = false;
export function usesPtyHost(): boolean {
  return process.platform === "win32" && Boolean(process.env.RUNWEAVE_RUNTIME_RELEASE_ID);
}
export async function getPtyHost(): Promise<PtyHostClient> {
  if (stopped) throw new Error("HOST_CLIENT_STOPPED");
  connection ??= PtyHostClient.connect(configuration().context, ownerId, generation, hostInstanceId).then(client => {
    generation = client.generation;
    hostInstanceId = client.descriptor.hostInstanceId;
    client.disconnected.add(() => { connection = undefined; });
    return client;
  }).catch(error => { connection = undefined; throw error; });
  return connection;
}
export async function syncPtyHostUpstreams(upstreams: PtyHostUpstreams): Promise<void> {
  if (usesPtyHost()) await (await getPtyHost()).request("setUpstreams", upstreams);
}
export async function createHostedPty(options: {
  terminalSessionId: string;
  binding: PtyHostBinding;
  create?: PtyHostCreateSession;
}): Promise<PtyRuntime> {
  const client = await getPtyHost();
  if (client.descriptor.hostInstanceId !== options.binding.hostInstanceId) throw new Error("HOST_IDENTITY_MISMATCH");
  if (options.create) await client.request("createSession", { ...options.create, generation: client.generation });
  const target = { ...options.binding, terminalSessionId: options.terminalSessionId, generation: client.generation };
  const dataListeners = new Set<(data: string) => void>();
  const frameListeners = new Set<(frame: TerminalOutputFrame) => void>();
  const exitListeners = new Set<(event: { exitCode: number }) => void>();
  const disconnectListeners = new Set<() => void>();
  const pending: TerminalOutputFrame[] = [];
  let exited: number | undefined;
  let cursor: TerminalOutputCursor = { streamId: "", offset: 0 };
  const emitFrame = (frame: TerminalOutputFrame) => {
    cursor = { streamId: frame.range.streamId, offset: frame.range.toOffset };
    if (!frameListeners.size) pending.push(frame);
    for (const listener of dataListeners) listener(frame.data);
    for (const listener of frameListeners) listener(frame);
  };
  let initializing = true;
  const early: import("@runweave/shared/terminal/pty-host").PtyHostEvent[] = [];
  const receive: Parameters<typeof client.events.add>[0] = event => {
    if (event.terminalSessionId !== options.terminalSessionId) return;
    if (initializing) { early.push(event); return; }
    if (event.type === "output") emitFrame(event);
    if (event.type === "exit") { exited = event.exitCode; for (const listener of exitListeners) listener({ exitCode: exited }); }
  };
  const disconnected = () => { for (const listener of disconnectListeners) listener(); };
  client.events.add(receive); client.disconnected.add(disconnected);
  let attached: { session: PtyHostSession; snapshot: PtyHostSnapshot; frames: TerminalOutputFrame[] };
  try { attached = await client.request("attachSession", target); }
  catch (error) { client.events.delete(receive); client.disconnected.delete(disconnected); throw error; }
  cursor = attached.snapshot.cursor;
  for (const frame of attached.frames) emitFrame(frame);
  initializing = false;
  for (const event of early) receive(event);
  let tail: Promise<unknown> = Promise.resolve();
  let pendingInputs = 0, pendingBytes = 0;
  const writeSteps = (steps: PtyHostInputStep[], operationId = randomUUID()): Promise<void> => {
    const bytes = steps.reduce((total, step) => total + (step.type === "text" ? Buffer.byteLength(step.data) : 0), 0);
    if (pendingInputs >= 128 || pendingBytes + bytes > 4 * 1024 * 1024) return Promise.reject(new Error("HOST_BUSY"));
    pendingInputs++; pendingBytes += bytes;
    const job = tail.then(async () => {
      const previous = await client.request<PtyHostInputResult | null>("getInputOperation", { ...target, operationId });
      const current = previous ? undefined : (await client.request<PtyHostSession[]>("listSessions")).find(item => item.terminalSessionId === options.terminalSessionId);
      const input = { operationId, sequence: previous?.sequence ?? current?.nextSequence ?? 0, steps };
      // Reserve once; an uncertain request is queried by ID, never blindly resent with a new ID.
      const result = await client.request<PtyHostInputResult>("writeInput", { ...target, input });
      if (result.state !== "written") throw new Error(result.error ?? "HOST_INPUT_UNCERTAIN");
    }).finally(() => { pendingInputs--; pendingBytes -= bytes; });
    tail = job.catch(() => {});
    return job;
  };
  const notifyFailure = () => disconnected();
  return {
    pid: attached.session.pid,
    onData(listener) { dataListeners.add(listener); },
    onExit(listener) { exitListeners.add(listener); if (exited !== undefined) listener({ exitCode: exited }); },
    write(data) { void writeSteps([{ type: "text", data }]).catch(notifyFailure); },
    resize(cols, rows) { void client.request("resize", { ...target, cols, rows }).catch(notifyFailure); },
    signal(signal) { void client.request("signal", { ...target, signal }).catch(notifyFailure); },
    dispose() { client.events.delete(receive); client.disconnected.delete(disconnected); },
    hosted: {
      output: { get cursor() { return cursor; }, read: position => client.request<TerminalOutputReplay>("readOutput", { ...target, cursor: position }) },
      snapshot: () => client.request("getSnapshot", target),
      onFrame(listener) { frameListeners.add(listener); for (const frame of pending.splice(0)) listener(frame); },
      onDisconnect(listener) { disconnectListeners.add(listener); },
      writeSteps,
      async close() { await client.request("closeSession", target); },
    },
  };
}

export async function closeHostedSession(terminalSessionId: string): Promise<void> {
  const client = await getPtyHost();
  const session = (await client.request<PtyHostSession[]>("listSessions")).find(item => item.terminalSessionId === terminalSessionId);
  if (session) await client.request("closeSession", { hostInstanceId: session.hostInstanceId,
    sessionInstanceId: session.sessionInstanceId, terminalSessionId, generation: client.generation });
}

export async function disconnectPtyHost(): Promise<void> {
  stopped = true;
  if (connection) (await connection.catch(() => undefined))?.close();
  connection = undefined;
}
