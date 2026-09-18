// Owned acceptance gateway: forwards authentication unchanged; injects only explicit local-preview faults.
import http from "node:http";
import net from "node:net";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
const [base, expectedSession, output] = process.argv.slice(2);
const upstream = new URL(base);
if (
  (await (await fetch(base + "/health")).json()).devSessionId !==
  expectedSession
)
  throw Error("Wrong Backend identity");
const directory = path.resolve(output);
mkdirSync(directory, { recursive: true });
let mode = "normal",
  capabilityRequests = 0,
  localUpgrades = 0;
const pending = new Set(),
  streams = new Set(),
  sockets = new Set();
const log = (value) =>
  appendFileSync(
    path.join(directory, "events.jsonl"),
    JSON.stringify({ at: Date.now(), ...value }) + "\n",
  );
const server = http.createServer((req, res) => {
  if (req.url === "/api/browser/local/capabilities") {
    capabilityRequests++;
    log({ event: "capabilities", mode });
    if (mode === "delay") {
      pending.add(res);
      res.on("close", () => pending.delete(res));
      return;
    }
    if (mode !== "normal") {
      res.writeHead(mode === "version" ? 200 : Number(mode), {
        "Content-Type": "application/json",
      });
      res.end(
        JSON.stringify({
          protocolVersion: 99,
          maxFrameBytes: 65536,
          maxConnections: 32,
        }),
      );
      return;
    }
  }
  const proxy = http.request(
    {
      hostname: upstream.hostname,
      port: upstream.port,
      path: req.url,
      method: req.method,
      headers: req.headers,
    },
    (response) => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    },
  );
  proxy.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(proxy);
  res.on("close", () => proxy.destroy());
});
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});
server.on("upgrade", (req, incoming, head) => {
  const local =
    new URL(req.url, "http://fixture").pathname === "/ws/browser-local";
  if (local) {
    localUpgrades++;
    log({ event: "local-upgrade" });
  }
  const outgoing = net.connect(Number(upstream.port), upstream.hostname, () => {
    outgoing.write(
      `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n` +
        Object.entries(req.headers)
          .map(([key, value]) => `${key}: ${value}\r\n`)
          .join("") +
        "\r\n",
    );
    if (head.length) outgoing.write(head);
    incoming.pipe(outgoing);
    outgoing.pipe(incoming);
  });
  const pair = { incoming, outgoing };
  if (local) streams.add(pair);
  const close = () => {
    streams.delete(pair);
    incoming.destroy();
    outgoing.destroy();
  };
  incoming.on("close", close);
  outgoing.on("close", close);
  incoming.on("error", close);
  outgoing.on("error", close);
});
const control = http.createServer((req, res) => {
  const next = req.url.replace("/mode/", "");
  if (
    req.url.startsWith("/mode/") &&
    ["normal", "404", "503", "version", "delay"].includes(next)
  ) {
    mode = next;
    log({ event: "mode", mode });
  }
  if (req.url === "/cut")
    for (const { incoming, outgoing } of streams) {
      incoming.destroy();
      outgoing.destroy();
    }
  if (req.url === "/release")
    for (const response of pending) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          protocolVersion: 1,
          maxFrameBytes: 65536,
          maxConnections: 32,
        }),
      );
    }
  res.end(
    JSON.stringify({
      mode,
      capabilityRequests,
      localUpgrades,
      activeLocalStreams: streams.size,
      pending: pending.size,
    }),
  );
});
server.listen(Number(process.argv[5]) || 0, "127.0.0.1", () =>
  control.listen(Number(process.argv[6]) || 0, "127.0.0.1", () => {
    const manifest = {
      pid: process.pid,
      devSessionId: expectedSession,
      port: server.address().port,
      controlPort: control.address().port,
    };
    writeFileSync(
      path.join(directory, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
    console.log(JSON.stringify(manifest));
  }),
);
process.on("SIGTERM", () => {
  for (const socket of sockets) socket.destroy();
  server.close();
  control.close();
  control.closeAllConnections();
});
