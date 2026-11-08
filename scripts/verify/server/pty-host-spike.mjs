// Real native PTY lifetime probe. The client processes model replaceable Backends;
// the counter is a process-tree fixture, not evidence of Traex compatibility.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createConnection, createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (condition, message) => { if (!condition) throw new Error(message); };

function request(endpoint, token, action = "status") {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    let result = "";
    socket.setTimeout(5000, () => socket.destroy(new Error("Probe request timeout")));
    socket.on("error", reject);
    socket.on("connect", () => socket.write(JSON.stringify({ token, action }) + "\n"));
    socket.on("data", data => { result += data; });
    socket.on("end", () => {
      try { resolve(JSON.parse(result)); } catch (error) { reject(error); }
    });
  });
}

const [mode, endpoint, token, fixture] = process.argv.slice(2);
if (mode === "host") {
  const require = createRequire(new URL("../../../backend/package.json", import.meta.url));
  const pty = require("node-pty");
  const env = { ...process.env, TERM: "xterm-256color" };
  for (const key of Object.keys(env))
    if (key.startsWith("RUNWEAVE_") || key === "ELECTRON_RUN_AS_NODE" || key.toLowerCase() === "psmodulepath") delete env[key];
  const counter = path.join(fixture, "counter.cjs");
  const command = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const args = process.platform === "win32"
    ? ["-NoProfile", "-NonInteractive", "-Command", `& ${quote(process.execPath)} ${quote(counter)}`]
    : ["-c", `exec "${process.execPath}" "${counter}"`];
  const terminal = pty.spawn(command, args, { cwd: fixture, cols: 100, rows: 30, env });
  const state = { hostPid: process.pid, shellPid: terminal.pid, counterPid: 0, tick: 0 };
  terminal.onData(data => {
    for (const match of data.matchAll(/COUNTER_PID=(\d+)/g)) state.counterPid = Number(match[1]);
    for (const match of data.matchAll(/TICK=(\d+)/g)) state.tick = Number(match[1]);
  });
  const server = createServer(socket => {
    let source = "";
    socket.on("error", () => {});
    socket.on("data", bytes => {
      source += bytes;
      if (source.length > 512) return socket.destroy();
      if (!source.includes("\n")) return;
      socket.pause();
      try {
        const message = JSON.parse(source.trim());
        if (message.token !== token) return socket.destroy();
        socket.end(JSON.stringify({ ...state, shellPid: terminal.pid }));
        if (message.action === "close") {
          terminal.kill();
          server.close();
          setTimeout(() => process.exit(0), 200);
        }
      } catch { socket.destroy(); }
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
} else if (mode === "client") {
  const status = await request(endpoint, token);
  process.stdout.write(JSON.stringify(status) + "\n");
  process.on("message", message => { if (message === "stop") process.exit(0); });
} else {
  const directory = mkdtempSync(path.join(os.tmpdir(), "rw host 中文-"));
  const secret = randomUUID();
  const pipe = process.platform === "win32" ? `\\\\.\\pipe\\rw-pty-spike-${randomUUID()}` : path.join(directory, "host.sock");
  writeFileSync(path.join(directory, "counter.cjs"), "console.log('COUNTER_PID='+process.pid);let tick=0;setInterval(()=>console.log('TICK='+ ++tick),100);\n");
  let host;
  const clients = [];
  try {
    host = spawn(process.execPath, [script, "host", pipe, secret, directory], { detached: true, stdio: "ignore" });
    host.on("error", () => {});
    host.unref();
    let before;
    for (let attempt = 0; attempt < 100; attempt++) {
      before = await request(pipe, secret).catch(() => null);
      if (before?.tick >= 2 && before.counterPid > 1 && before.shellPid > 1) break;
      await sleep(100);
    }
    assert(before?.tick >= 2 && before.counterPid > 1 && before.shellPid > 1, "Detached native PTY did not become ready");
    for (const shutdown of ["normal", "forced"]) {
      const client = spawn(process.execPath, [script, "client", pipe, secret], { stdio: ["ignore", "pipe", "inherit", "ipc"] });
      clients.push(client);
      await new Promise((resolve, reject) => { client.stdout.once("data", resolve); client.once("error", reject); });
      const exited = new Promise(resolve => client.once("exit", resolve));
      if (shutdown === "normal") client.send("stop"); else client.kill();
      await exited;
      await sleep(500);
      const after = await request(pipe, secret);
      assert(after.hostPid === before.hostPid && after.shellPid === before.shellPid && after.counterPid === before.counterPid, "Native process identity changed");
      assert(after.tick > before.tick, "Counter stopped with Backend client");
      console.log(JSON.stringify({ platform: process.platform, shutdown, ...after, continued: true }));
      before = after;
    }
  } finally {
    for (const client of clients) if (client.exitCode === null) client.kill();
    await request(pipe, secret, "close").catch(() => host?.kill());
    await sleep(300);
    rmSync(directory, { recursive: true, force: true });
  }
}
