/** Disposable HTTP integration of the real ticket, authentication, file and range routes. */
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  copyFile,
  writeFile,
  readFile,
  rm,
  open,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { AuthService } from "../../backend/src/auth/service";
import { createRequireAuth } from "../../backend/src/auth/middleware";
import {
  createVideoPreviewRouter,
  registerTerminalVideoPreviewRoutes,
} from "../../backend/src/routes/terminal/preview/video";
import type { TerminalSessionManager } from "../../backend/src/terminal/manager/manager";
const require = createRequire(
  new URL("../../backend/package.json", import.meta.url),
);
const express = require("express") as typeof import("express");
const source = process.argv[2];
if (!source)
  throw new Error(
    "Usage: tsx scripts/verify/preview-video.mts <valid-mp4-path>",
  );
const sourceBytes = await readFile(source);
const root = await mkdtemp(path.join(tmpdir(), "runweave-video-"));
const file = path.join(root, "验收 video.MP4");
await copyFile(source, file);
const password = randomUUID();
const auth = new AuthService({
  username: "fixture",
  password,
  jwtSecret: randomUUID(),
  accessTokenTtlMs: 600000,
  refreshTokenTtlMs: 600000,
  refreshCookieName: "fixture",
  secureCookies: false,
});
const login = (await auth.login("fixture", password))!;
let projectPath: string | null = root;
const manager = {
  getProject: (id: string) =>
    id === "fixture" ? { id, path: projectPath } : undefined,
  getProjectContext: () => undefined,
} as unknown as TerminalSessionManager;
const app = express();
app.use(express.json());
const router = express.Router();
registerTerminalVideoPreviewRoutes(router, manager, auth);
app.use("/api/terminal", createRequireAuth(auth), router);
app.use("/video-preview", createVideoPreviewRouter(manager, auth));
const server = http.createServer(app);
server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const endpoint = base + "/api/terminal/project/fixture/preview/video-ticket";
const request = (p: string, token = login.accessToken) =>
  fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ path: p }),
  });
const report: string[] = [];
try {
  assert.equal((await request(file, "invalid")).status, 401);
  const response = await request(file);
  assert.equal(response.status, 200);
  const ticket = (await response.json()) as {
    path: string;
    mimeType: string;
    sizeBytes: number;
  };
  assert.equal(ticket.mimeType, "video/mp4");
  assert.equal(ticket.sizeBytes, sourceBytes.length);
  const url = base + ticket.path;
  const full = await fetch(url);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("cache-control"), "no-store");
  assert.equal(full.headers.get("accept-ranges"), "bytes");
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), sourceBytes);
  const head = await fetch(url, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(sourceBytes.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  for (const [range, start, end] of [
    ["bytes=0-1", 0, 1],
    ["bytes=12-", 12, sourceBytes.length - 1],
    ["bytes=-9", sourceBytes.length - 9, sourceBytes.length - 1],
  ] as const) {
    const out = await fetch(url, { headers: { Range: range } });
    assert.equal(out.status, 206);
    assert.equal(
      out.headers.get("content-range"),
      `bytes ${start}-${end}/${sourceBytes.length}`,
    );
    assert.deepEqual(
      Buffer.from(await out.arrayBuffer()),
      sourceBytes.subarray(start, end + 1),
    );
  }
  for (const range of [
    "bytes=-",
    "bytes=-0",
    `bytes=${sourceBytes.length}-`,
    "bytes=5-2",
    "bytes=0-1,3-4",
  ]) {
    const out = await fetch(url, { headers: { Range: range } });
    assert.equal(out.status, 416);
    assert.equal(
      out.headers.get("content-range"),
      `bytes */${sourceBytes.length}`,
    );
  }
  assert.equal((await fetch(url, { method: "POST" })).status, 405);
  report.push(
    "VID-HTTP: full, HEAD, bounded/open/suffix ranges, 416 and method checks",
  );
  const expired = auth.issueTemporaryToken({
    sessionId: login.sessionId,
    tokenType: "video-preview",
    resource: {
      projectId: "fixture",
      mediaPath: file,
      mediaVersion: decodeURIComponent(ticket.path.split("/")[5]!),
    },
    ttlMs: -1000,
  });
  const expiredParts = ticket.path.split("/");
  expiredParts[2] = expired.token;
  assert.equal((await fetch(base + expiredParts.join("/"))).status, 401);
  const parts = ticket.path.split("/");
  parts[2] = login.accessToken;
  assert.equal((await fetch(base + parts.join("/"))).status, 401);
  parts.splice(0, parts.length, ...ticket.path.split("/"));
  parts[4] = Buffer.from(path.join(root, "other.mp4")).toString("base64url");
  assert.equal((await fetch(base + parts.join("/"))).status, 401);
  report.push("VID-AUTH: access token and cross-file ticket rejected");
  await writeFile(path.join(root, "fake.mp4"), "not a video");
  assert.equal((await request("fake.mp4")).status, 415);
  assert.equal((await request("missing.mp4")).status, 404);
  assert.equal((await request("../escape.mp4")).status, 403);
  const big = path.join(root, "large.mp4"),
    handle = await open(big, "w");
  await handle.write(sourceBytes.subarray(0, 4096));
  await handle.truncate(512 * 1024 * 1024);
  await handle.close();
  const large = (await (await request(big)).json()) as {
    path: string;
    sizeBytes: number;
  };
  assert.equal(large.sizeBytes, 512 * 1024 * 1024);
  const tail = await fetch(base + large.path, {
    headers: { Range: "bytes=-16" },
  });
  assert.equal(tail.status, 206);
  assert.equal((await tail.arrayBuffer()).byteLength, 16);
  report.push(
    "VID-STREAM: 512MiB sparse container is served by range without the image/text limits",
  );
  await writeFile(file, Buffer.concat([sourceBytes, Buffer.from([0])]));
  assert.equal((await fetch(url)).status, 409);
  report.push(
    "VID-VERSION: changed file cannot reuse previous byte-range ticket",
  );
  projectPath = null;
  assert.equal((await request(file)).status, 200);
  assert.equal((await request("relative.mp4")).status, 409);
  report.push(
    "VID-PATH: absolute file works without a project path; relative escape rejected",
  );
  await auth.logoutSession(login.accessToken);
  assert.equal((await fetch(base + large.path)).status, 401);
  report.push("VID-SESSION: logout revokes issued video tickets");
  console.log(JSON.stringify({ ok: true, report }, null, 2));
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
