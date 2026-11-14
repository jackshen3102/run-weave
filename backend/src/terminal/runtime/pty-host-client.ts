import { randomUUID } from "node:crypto";
import { configuration } from "@runweave/config-node";
import { PtyHostClient, hostErrorCode } from "@runweave/pty-host/client";
import type { PtyHostBinding, PtyHostSession, PtyHostInputResult, PtyHostInputStep, PtyHostCreateSession, PtyHostUpstreams, PtyHostSnapshot, PtyHostAttachment, PtyHostAttachTarget } from "@runweave/shared/terminal/pty-host";
import type { TerminalOutputCursor } from "@runweave/shared/terminal/websocket";
import { isTerminalQueryResponse } from "@runweave/shared/terminal/input";
import { RESUME_MAX_BYTES, RESUME_MAX_FRAMES, TerminalOutputRecoveryBuffer, type TerminalOutputFrame, type TerminalOutputReplay } from "./output-recovery";
import type { PtyRuntime, TerminalRecoveryFailure } from "./pty-service";
import { logger } from "../../logging/index";

const hostLogger = logger.child({ component: "pty-host" });

const ownerId = randomUUID();
let connection: Promise<PtyHostClient> | undefined;
let generation: number | undefined;
let hostInstanceId: string | undefined;
let upstreams: PtyHostUpstreams | undefined;
let stopped = false;
let sessionReplacementSupported = false;
let currentControl: PtyHostClient | undefined;
export function supportsHostedAgentRecovery(): boolean { return sessionReplacementSupported; }
async function closeHostTarget(
  client: PtyHostClient,
  target: PtyHostBinding & { terminalSessionId: string; generation: number },
): Promise<void> {
  try { await client.request("closeSession", target); }
  catch (error) {
    // Exited sessions can leave the Host's bounded retention window before the
    // Backend releases its cached runtime. There is nothing left to terminate.
    if (!(error instanceof Error) || error.message !== "HOST_SESSION_GONE") throw error;
  }
}
export function usesPtyHost(): boolean {
  return process.platform === "win32" && Boolean(process.env.RUNWEAVE_RUNTIME_RELEASE_ID);
}
export async function getPtyHost(): Promise<PtyHostClient> {
  if (stopped) throw new Error("HOST_CLIENT_STOPPED");
  connection ??= PtyHostClient.connect(configuration().context, ownerId, generation, hostInstanceId,
    ({ event, ...fields }) => hostLogger.warn(event, fields)).then(async client => {
    generation = client.generation;
    currentControl = client;
    sessionReplacementSupported = client.supportsSessionReplacement;
    hostInstanceId = client.descriptor.hostInstanceId;
    client.disconnected.add(() => {
      if (currentControl !== client) return;
      connection = undefined; currentControl = undefined; sessionReplacementSupported = false;
    });
    try {
      // A replacement Host has a new gateway. Restore its verified upstreams
      // before launching resumed Agents that inherit that gateway's environment.
      if (upstreams) await client.request("setUpstreams", upstreams);
      return client;
    } catch (error) { client.close(); throw error; }
  }).catch(error => { connection = undefined; throw error; });
  return connection;
}
export async function syncPtyHostUpstreams(value: PtyHostUpstreams): Promise<void> {
  if (usesPtyHost()) {
    upstreams = { ...value };
    await (await getPtyHost()).request("setUpstreams", value);
  }
}
export async function createHostedPty(options: {
  terminalSessionId: string;
  binding: PtyHostBinding;
  create?: PtyHostCreateSession;
  onLaunch?: (launch: NonNullable<PtyHostSession["launch"]>) => Promise<void>;
}): Promise<PtyRuntime> {
  const control = await getPtyHost();
  if (control.descriptor.hostInstanceId !== options.binding.hostInstanceId) {
    // A verified replacement Host cannot own a session from the previous Host.
    // Creation and RPC identity checks still fail closed on an invalid binding.
    throw new Error(options.create ? "HOST_IDENTITY_MISMATCH" : "HOST_SESSION_GONE");
  }
  if (options.create) await control.request("createSession", { ...options.create, generation: control.generation });
  // Output owns a per-terminal pipe. A slow stream must not sever the writer
  // control connection or output subscriptions belonging to other terminals.
  const client = await PtyHostClient.connect(configuration().context, undefined, undefined, undefined,
    ({ event, ...fields }) => hostLogger.warn(event, { ...fields, terminalSessionId: options.terminalSessionId }));
  if (client.descriptor.hostInstanceId !== control.descriptor.hostInstanceId) {
    client.close();
    throw new Error("HOST_IDENTITY_MISMATCH");
  }
  const target = { ...options.binding, terminalSessionId: options.terminalSessionId, generation: control.generation };
  const dataListeners = new Set<(data: string) => void>();
  const frameListeners = new Set<(frame: TerminalOutputFrame) => void>();
  const exitListeners = new Set<(event: { exitCode: number }) => void>();
  const failureListeners = new Set<(failure: TerminalRecoveryFailure) => void>();
  const resizeListeners = new Set<(cols: number, rows: number) => void>();
  const pending: TerminalOutputFrame[] = [];
  let pendingFrameBytes = 0;
  let pendingData: TerminalOutputRecoveryBuffer | undefined = new TerminalOutputRecoveryBuffer();
  let exited: number | undefined;
  let cursor: TerminalOutputCursor = { streamId: "", offset: 0 };
  let grid = { cols: 80, rows: 24 };
  const emitFrame = (frame: TerminalOutputFrame) => {
    cursor = { streamId: frame.range.streamId, offset: frame.range.toOffset };
    if (!frameListeners.size) {
      pending.push(frame);
      pendingFrameBytes += frame.range.toOffset - frame.range.fromOffset;
      while (pendingFrameBytes > RESUME_MAX_BYTES || pending.length > RESUME_MAX_FRAMES) {
        const removed = pending.shift()!;
        pendingFrameBytes -= removed.range.toOffset - removed.range.fromOffset;
      }
    }
    if (pendingData) Array.from(pendingData.append(frame.data));
    for (const listener of dataListeners) listener(frame.data);
    for (const listener of frameListeners) listener(frame);
  };
  let initializing = true;
  let disposed = false;
  let failed = false;
  const early: Extract<import("@runweave/shared/terminal/pty-host").PtyHostEvent, { type: "output" }>[] = [];
  let earlyBytes = 0, earlyDroppedOutput = false;
  let earlyGrid: { cols: number; rows: number } | undefined;
  let earlyLaunch: PtyHostSession["launch"];
  const receive: Parameters<typeof client.events.add>[0] = event => {
    if (event.terminalSessionId !== options.terminalSessionId) return;
    if (initializing) {
      if (event.type === "exit") exited = event.exitCode;
      if (event.type === "resize") earlyGrid = { cols: event.cols, rows: event.rows };
      if (event.type === "launch") earlyLaunch = event.launch;
      if (event.type === "output") {
        early.push(event);
        earlyBytes += Buffer.byteLength(event.data);
        while (earlyBytes > RESUME_MAX_BYTES || early.length > RESUME_MAX_FRAMES) {
          earlyBytes -= Buffer.byteLength(early.shift()!.data);
          earlyDroppedOutput = true;
        }
      }
      return;
    }
    if (event.type === "launch" && options.onLaunch) void options.onLaunch(event.launch).catch(error => notifyFailure("launch", error));
    if (event.type === "output") emitFrame(event);
    if (event.type === "resize") { grid = { cols: event.cols, rows: event.rows }; for (const listener of resizeListeners) listener(event.cols, event.rows); }
    if (event.type === "exit" && exited === undefined) { exited = event.exitCode; for (const listener of exitListeners) listener({ exitCode: exited }); }
  };
  const fail = (failure: TerminalRecoveryFailure) => {
    if (disposed || failed) return;
    failed = true;
    for (const listener of failureListeners) listener(failure);
  };
  const disconnected = (error: Error) => fail({ kind: "host-disconnected", code: hostErrorCode(error) });
  client.events.add(receive); client.disconnected.add(disconnected);
  let attached: PtyHostAttachment;
  // Reattaching an existing binding must not record its old prefix again.
  const attachTarget: PtyHostAttachTarget = { ...target, includeHistory: Boolean(options.create) };
  try { attached = await client.request("attachSession", attachTarget); }
  catch (error) { client.events.delete(receive); client.disconnected.delete(disconnected); client.close(); throw error; }
  if (attached.session.launch && options.onLaunch) {
    try { await options.onLaunch(attached.session.launch); }
    catch (error) { client.events.delete(receive); client.disconnected.delete(disconnected); client.close(); throw error; }
  }
  cursor = attached.snapshot.cursor;
  grid = { cols: attached.snapshot.cols, rows: attached.snapshot.rows };
  if (attached.session.status === "exited") exited ??= attached.session.exitCode ?? 0;
  if (!earlyDroppedOutput) {
    if (options.create) for (const frame of attached.history ?? []) Array.from(pendingData.append(frame.data));
    for (const frame of attached.frames) emitFrame(frame);
  }
  initializing = false;
  for (const event of early) receive(event);
  early.length = 0;
  earlyBytes = 0;
  if (earlyGrid) grid = earlyGrid;
  earlyGrid = undefined;
  const pendingLaunch = earlyLaunch;
  earlyLaunch = undefined;
  if (pendingLaunch && options.onLaunch) {
    try { await options.onLaunch(pendingLaunch); }
    catch (error) { client.events.delete(receive); client.disconnected.delete(disconnected); client.close(); throw error; }
  }
  let tail: Promise<unknown> = Promise.resolve();
  let pendingInputs = 0, pendingBytes = 0;
  const enqueueSteps = (steps: PtyHostInputStep[], operationId: string = randomUUID(), raw = false): Promise<void> => {
    const bytes = steps.reduce((total, step) => total + (step.type === "text" ? Buffer.byteLength(step.data) : 0), 0);
    if (pendingInputs >= 128 || pendingBytes + bytes > 4 * 1024 * 1024) return Promise.reject(new Error("HOST_BUSY"));
    pendingInputs++; pendingBytes += bytes;
    const job = tail.then(async () => {
      const previous = raw ? null : await client.request<PtyHostInputResult | null>("getInputOperation", { ...target, operationId });
      const current = previous ? undefined : (await client.request<PtyHostSession[]>("listSessions")).find(item => item.terminalSessionId === options.terminalSessionId);
      const sequence = previous?.sequence ?? current?.nextSequence ?? 0;
      const input = { operationId: raw ? `raw:${target.sessionInstanceId}:${sequence}` : operationId, sequence, steps };
      // Reserve once; an uncertain request is queried by ID, never blindly resent with a new ID.
      const result = await client.request<PtyHostInputResult>("writeInput", { ...target, input });
      if (result.state !== "written") throw new Error(result.error ?? "HOST_INPUT_UNCERTAIN");
    }).finally(() => { pendingInputs--; pendingBytes -= bytes; });
    tail = job.catch(() => {});
    return job;
  };
  const notifyFailure = (action: string, error: unknown) => {
    if (disposed || failed) return;
    const code = hostErrorCode(error);
    hostLogger.warn("terminal.host.operation.failed", { terminalSessionId: options.terminalSessionId,
      hostInstanceId: client.descriptor.hostInstanceId, action, code, pendingInputs, pendingBytes });
    fail({ kind: client.isConnected ? "host-operation-failed" : "host-disconnected", action, code });
  };
  let rawInput = "", rawInputBytes = 0, rawFlushScheduled = false;
  const flushRawInput = () => {
    if (!rawInputBytes) return;
    const data = rawInput;
    rawInput = ""; rawInputBytes = 0;
    void enqueueSteps([{ type: "text", data }], undefined, true).catch(error => notifyFailure("writeInput", error));
  };
  const writeSteps = (steps: PtyHostInputStep[], operationId?: string): Promise<void> => {
    // Structured operations must remain after any preceding raw bytes.
    flushRawInput();
    return enqueueSteps(steps, operationId);
  };
  let snapshotFlight: Promise<PtyHostSnapshot> | undefined;
  const snapshot = () => {
    // The Host already shares in-flight screen capture. Share its pipe response too.
    snapshotFlight ??= client.request<PtyHostSnapshot>("getSnapshot", target)
      .finally(() => { snapshotFlight = undefined; });
    return snapshotFlight;
  };
  return {
    pid: attached.session.pid,
    onData(listener) {
      dataListeners.add(listener);
      const buffered = pendingData;
      pendingData = undefined;
      for (const frame of buffered?.retainedFrames() ?? []) listener(frame.data);
    },
    onExit(listener) { exitListeners.add(listener); if (exited !== undefined) listener({ exitCode: exited }); },
    write(data) {
      if (disposed || failed || !data) return;
      if (isTerminalQueryResponse(data)) {
        // Keep replies separate so a new Host can ignore its viewers' duplicates.
        // Old Hosts still receive the same reply unchanged.
        flushRawInput();
        void enqueueSteps([{ type: "text", data }], undefined, true).catch(error => notifyFailure("writeInput", error));
        return;
      }
      const bytes = Buffer.byteLength(data);
      if (rawInputBytes + bytes > 64 * 1024) flushRawInput();
      rawInput += data; rawInputBytes += bytes;
      // A stream's transport fragments must not each consume an operation slot.
      if (rawInputBytes >= 64 * 1024) flushRawInput();
      else if (!rawFlushScheduled) {
        rawFlushScheduled = true;
        queueMicrotask(() => { rawFlushScheduled = false; flushRawInput(); });
      }
    },
    resize(cols, rows) { void client.request("resize", { ...target, cols, rows }).catch(error => notifyFailure("resize", error)); },
    signal(signal) { void client.request("signal", { ...target, signal }).catch(error => notifyFailure("signal", error)); },
    dispose() { disposed = true; pendingData = undefined; rawInput = ""; rawInputBytes = 0; client.events.delete(receive); client.disconnected.delete(disconnected); client.close(); },
    hosted: {
      get grid() { return grid; },
      output: { get cursor() { return cursor; }, read: position => client.request<TerminalOutputReplay>("readOutput", { ...target, cursor: position }) },
      snapshot,
      onFrame(listener) { frameListeners.add(listener); for (const frame of pending.splice(0)) listener(frame); pendingFrameBytes = 0; },
      onFailure(listener) { failureListeners.add(listener); },
      onResize(listener) { resizeListeners.add(listener); },
      writeSteps,
      async close() { await closeHostTarget(client, target); },
    },
  };
}

export async function closeHostedSession(terminalSessionId: string): Promise<PtyHostSession | undefined> {
  const client = await getPtyHost();
  const session = (await client.request<PtyHostSession[]>("listSessions")).find(item => item.terminalSessionId === terminalSessionId);
  if (session) await closeHostTarget(client, { hostInstanceId: session.hostInstanceId,
    sessionInstanceId: session.sessionInstanceId, terminalSessionId, generation: client.generation });
  return session;
}

export async function disconnectPtyHost(): Promise<void> {
  stopped = true;
  if (connection) (await connection.catch(() => undefined))?.close();
  connection = undefined;
}
