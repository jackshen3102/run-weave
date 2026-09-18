// P0 fixture: only its own loopback services and a public TLS probe destination.
// Never forwards arbitrary LAN targets. All credentials are ephemeral fixture data.
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
const { WebSocketServer } = createRequire(
  new URL("../../../backend/package.json", import.meta.url),
)("ws");
const host = process.argv[2];
const output = process.argv[3];
if (!host || !output)
  throw new Error("usage: proxy-probe.mjs <LAN bind IP> <output directory>");
await fs.mkdir(output, { recursive: true });
const runId = crypto.randomUUID();
const password = crypto.randomBytes(24).toString("hex");
const sockets = new Set();
const record = (event) => {
  const entry = { at: new Date().toISOString(), ...event };
  fs.appendFile(`${output}/events.jsonl`, JSON.stringify(entry) + "\n");
};
const listen = (server, address) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.listen(0, address, () => resolve(server.address().port));
  });
const page = (request, response) => {
  record({
    type: "target-http",
    host: request.headers.host,
    path: request.url,
  });
  response.setHeader("Content-Type", "text/html");
  response.end(`<!doctype html><meta name="viewport" content="width=device-width"><h1>电脑代理 ${runId}</h1><p id="result">等待 WS</p><script>
  window.probeResult = {runId:${JSON.stringify(runId)}, href:location.href, ws:'pending'};
  const socket=new WebSocket('ws://'+location.host+'/echo');
  socket.onopen=()=>socket.send('probe-echo');
  socket.onmessage=e=>{window.probeResult.ws=e.data;document.getElementById('result').textContent=e.data};
  socket.onerror=()=>{window.probeResult.ws='error';document.getElementById('result').textContent='WS error'};
  </script>`);
};
const target = http.createServer(page);
const v6Target = http.createServer(page);
const port = await listen(target, "127.0.0.1");
const v6Port = await listen(v6Target, "::1");
for (const server of [target, v6Target]) {
  const ws = new WebSocketServer({ server });
  ws.on("connection", (socket) => {
    record({ type: "target-ws" });
    socket.on("message", (data) => socket.send(data.toString()));
  });
}
let proxyPort;
let socksPort;
const allowed = (hostname, targetPort) =>
  ([
    "localhost",
    "127.0.0.1",
    "probe.localhost",
    "runweave-probe.invalid",
  ].includes(hostname) &&
    targetPort === port) ||
  (hostname === "::1" && targetPort === v6Port) ||
  (hostname === "www.apple.com" && targetPort === 443);
const destination = (hostname) =>
  hostname === "localhost" ||
  hostname.endsWith(".localhost") ||
  hostname === "runweave-probe.invalid"
    ? "127.0.0.1"
    : hostname;
const proxy = http.createServer((request, response) => {
  if (request.url?.startsWith("/config")) {
    const socks = request.url.includes("socks=1");
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        host,
        proxyPort: socks ? socksPort : proxyPort,
        kind: socks ? "socks" : "http-connect",
        password,
        runId,
        targets: [
          `http://localhost:${port}/`,
          `http://127.0.0.1:${port}/`,
          `http://[::1]:${v6Port}/`,
          `http://probe.localhost:${port}/`,
          `http://runweave-probe.invalid:${port}/`,
          "https://www.apple.com/",
        ],
      }),
    );
  } else if (request.url?.startsWith("/result") && request.method === "POST") {
    let body = "";
    request.on("data", (data) => {
      body += data;
      if (body.length > 16384) request.destroy();
    });
    request.on("end", () => {
      try {
        record({ type: "device-result", result: JSON.parse(body) });
      } catch {
        response.statusCode = 400;
      }
      response.end("ok");
    });
  } else {
    response.writeHead(404).end();
  }
});
proxy.on("connect", (request, socket, head) => {
  const authorized =
    request.headers["proxy-authorization"] ===
    `Basic ${Buffer.from(`probe:${password}`).toString("base64")}`;
  let url;
  try {
    url = new URL(`http://${request.url}`);
  } catch {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const targetPort = Number(url.port || 80);
  record({ type: "connect", host: hostname, port: targetPort, authorized });
  if (!authorized) {
    socket.end(
      'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="probe"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
    );
    return;
  }
  if (!allowed(hostname, targetPort)) {
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  const upstream = net.connect(
    {
      host: destination(hostname),
      port: targetPort,
    },
    () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    },
  );
  sockets.add(upstream);
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
  socket.on("close", () => upstream.destroy());
  upstream.on("close", () => {
    sockets.delete(upstream);
    socket.destroy();
  });
});
const socks = net.createServer((socket) => {
  let buffer = Buffer.alloc(0);
  let phase = "greeting";
  const receive = (data) => {
    buffer = Buffer.concat([buffer, data]);
    if (buffer.length > 8192) {
      socket.destroy();
      return;
    }
    if (phase === "greeting") {
      if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
      if (buffer[0] !== 5 || !buffer.subarray(2, 2 + buffer[1]).includes(2)) {
        socket.end(Buffer.from([5, 255]));
        return;
      }
      buffer = buffer.subarray(2 + buffer[1]);
      phase = "auth";
      socket.write(Buffer.from([5, 2]));
    }
    if (phase === "auth") {
      if (buffer.length < 2 || buffer.length < 3 + buffer[1]) return;
      const end = 3 + buffer[1] + buffer[2 + buffer[1]];
      if (buffer.length < end) return;
      const authorized =
        buffer.subarray(2, 2 + buffer[1]).toString() === "probe" &&
        buffer.subarray(3 + buffer[1], end).toString() === password;
      record({ type: "socks-auth", authorized });
      if (!authorized) {
        socket.end(Buffer.from([1, 1]));
        return;
      }
      buffer = buffer.subarray(end);
      phase = "request";
      socket.write(Buffer.from([1, 0]));
    }
    if (phase === "request") {
      if (buffer.length < 5) return;
      const kind = buffer[3];
      const end =
        kind === 1 ? 10 : kind === 4 ? 22 : kind === 3 ? 7 + buffer[4] : 0;
      if (!end || buffer[0] !== 5 || buffer[1] !== 1) {
        socket.destroy();
        return;
      }
      if (buffer.length < end) return;
      const hostname =
        kind === 1
          ? [...buffer.subarray(4, 8)].join(".")
          : kind === 4
            ? new URL(
                `http://[${Array.from({ length: 8 }, (_, i) => buffer.readUInt16BE(4 + i * 2).toString(16)).join(":")}]`,
              ).hostname.slice(1, -1)
            : buffer.subarray(5, end - 2).toString();
      const targetPort = buffer.readUInt16BE(end - 2);
      record({ type: "socks-connect", host: hostname, port: targetPort });
      if (!allowed(hostname, targetPort)) {
        socket.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0]));
        return;
      }
      socket.removeListener("data", receive);
      const head = buffer.subarray(end);
      const upstream = net.connect(
        { host: destination(hostname), port: targetPort },
        () => {
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          if (head.length) upstream.write(head);
          socket.pipe(upstream).pipe(socket);
        },
      );
      sockets.add(upstream);
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      socket.on("close", () => upstream.destroy());
      upstream.on("close", () => {
        sockets.delete(upstream);
        socket.destroy();
      });
    }
  };
  socket.on("data", receive);
  socket.on("error", () => socket.destroy());
});
socksPort = await listen(socks, host);
proxyPort = await listen(proxy, host);
const manifest = {
  runId,
  pid: process.pid,
  configURL: `http://${host}:${proxyPort}/config`,
  port,
  v6Port,
};
await fs.writeFile(
  `${output}/manifest.json`,
  JSON.stringify(manifest, null, 2),
);
console.log(JSON.stringify(manifest));
const cleanup = () => {
  for (const socket of sockets) socket.destroy();
  for (const server of [proxy, socks, target, v6Target]) server.close();
};
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);
