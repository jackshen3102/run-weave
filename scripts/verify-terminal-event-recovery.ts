import { strict as assert } from "node:assert";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { TerminalEventServerMessage } from "@runweave/shared/terminal/events";
import { WebSocket } from "ws";
import { TerminalEventService } from "../backend/src/terminal/terminal-event-service";
import { attachTerminalEventsWebSocketServer } from "../backend/src/ws/terminal-events-server";

const authService = {
  verifyTemporaryToken: () => ({
    sessionId: "verification",
    username: "verification",
    tokenType: "terminal-events-ws",
    resource: {},
  }),
};

function recordBell(service: TerminalEventService, count: number): void {
  service.record({
    kind: "terminal_bell",
    terminalSessionId: "terminal-verification",
    projectId: "project-verification",
    payload: { count },
  });
}

async function startTerminalEventsServer(
  service: TerminalEventService,
): Promise<{
  server: Server;
  port: number;
}> {
  const server = createServer();
  attachTerminalEventsWebSocketServer(server, authService as never, service);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    port: (server.address() as AddressInfo).port,
  };
}

async function stopServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function readHandshake(
  port: number,
  after: string | null,
): Promise<[TerminalEventServerMessage, TerminalEventServerMessage]> {
  const messages: TerminalEventServerMessage[] = [];
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/ws/terminal-events?token=verification&after=${after ?? ""}`,
  );

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error("Timed out waiting for terminal event handshake"));
    }, 3_000);
    socket.on("message", (raw) => {
      messages.push(JSON.parse(String(raw)) as TerminalEventServerMessage);
      if (messages.length < 2) {
        return;
      }
      clearTimeout(timeout);
      socket.close();
      resolve([messages[0], messages[1]]);
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function main(): Promise<void> {
  const beforeRestart = new TerminalEventService();
  recordBell(beforeRestart, 1);
  recordBell(beforeRestart, 2);
  const oldStreamId = beforeRestart.getStreamId();
  const oldCursor = beforeRestart.getLatestId();
  assert.equal(oldCursor, "2");

  const afterRestart = new TerminalEventService();
  recordBell(afterRestart, 1);
  assert.notEqual(afterRestart.getStreamId(), oldStreamId);

  let clientCursor = oldCursor;
  const seenEventIds = new Set(["1", "2"]);
  if (afterRestart.getStreamId() !== oldStreamId) {
    clientCursor = null;
    seenEventIds.clear();
  }
  assert.equal(clientCursor, null);
  assert.equal(seenEventIds.size, 0);

  const restartServer = await startTerminalEventsServer(afterRestart);
  const [restartConnected, restartCatchup] = await readHandshake(
    restartServer.port,
    clientCursor,
  );
  assert.equal(restartConnected.type, "connected");
  assert.equal(
    restartConnected.type === "connected" ? restartConnected.streamId : null,
    afterRestart.getStreamId(),
  );
  assert.deepEqual(
    restartCatchup.type === "terminal-events"
      ? restartCatchup.events.map((event) => event.id)
      : [],
    ["1"],
  );
  await stopServer(restartServer.server);

  const overflow = new TerminalEventService();
  for (let index = 1; index <= 502; index += 1) {
    recordBell(overflow, index);
  }
  const overflowServer = await startTerminalEventsServer(overflow);
  const [tooOldConnected, tooOldCatchup] = await readHandshake(
    overflowServer.port,
    "1",
  );
  assert.equal(tooOldConnected.type, "connected");
  assert.deepEqual(
    tooOldConnected.type === "connected" ? tooOldConnected.gap : null,
    {
      reason: "cursor-too-old",
      requestedAfter: "1",
      oldestAvailableEventId: "3",
      latestEventId: "502",
    },
  );
  assert.deepEqual(
    tooOldCatchup.type === "terminal-events"
      ? [
          tooOldCatchup.events[0]?.id,
          tooOldCatchup.events.at(-1)?.id,
          tooOldCatchup.events.length,
        ]
      : [],
    ["3", "502", 500],
  );

  const [boundaryConnected, boundaryCatchup] = await readHandshake(
    overflowServer.port,
    "2",
  );
  assert.equal(
    boundaryConnected.type === "connected" ? boundaryConnected.gap : "invalid",
    null,
  );
  assert.equal(
    boundaryCatchup.type === "terminal-events"
      ? boundaryCatchup.events.length
      : -1,
    500,
  );

  const [aheadConnected] = await readHandshake(overflowServer.port, "999");
  assert.deepEqual(
    aheadConnected.type === "connected" ? aheadConnected.gap : null,
    {
      reason: "cursor-ahead",
      requestedAfter: "999",
      oldestAvailableEventId: "3",
      latestEventId: "502",
    },
  );
  await stopServer(overflowServer.server);

  const normal = new TerminalEventService();
  for (let index = 1; index <= 4; index += 1) {
    recordBell(normal, index);
  }
  const normalServer = await startTerminalEventsServer(normal);
  const [normalConnected, normalCatchup] = await readHandshake(
    normalServer.port,
    "2",
  );
  assert.equal(
    normalConnected.type === "connected" ? normalConnected.gap : "invalid",
    null,
  );
  assert.deepEqual(
    normalCatchup.type === "terminal-events"
      ? normalCatchup.events.map((event) => event.id)
      : [],
    ["3", "4"],
  );
  await stopServer(normalServer.server);

  console.log(
    JSON.stringify(
      {
        backendRestart: "PASS",
        cursorTooOld: "PASS",
        retentionBoundary: "PASS",
        cursorAhead: "PASS",
        normalReconnect: "PASS",
      },
      null,
      2,
    ),
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
