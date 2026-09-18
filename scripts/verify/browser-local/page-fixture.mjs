import http from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
const require = createRequire(
  new URL("../../../backend/package.json", import.meta.url),
);
const { WebSocketServer } = require("ws");
const runId = randomUUID();
const directory = path.resolve(
  process.argv[2] ?? ".runweave/browser-local-page",
);
mkdirSync(directory, { recursive: true });
const payload = Buffer.alloc(8 * 1024 * 1024, 97);
const hash = createHash("sha256").update(payload).digest("hex");
let posts = 0;
const log = (value) =>
  appendFileSync(
    path.join(directory, "events.jsonl"),
    JSON.stringify({ at: new Date().toISOString(), ...value }) + "\n",
  );
const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>电脑本地预览</title><link rel="stylesheet" href="/style.css"><h1>电脑本地页面</h1><p id="run">${runId}</p><p id="status">正在验证</p><p id="ws">WS 等待</p><p id="large">大文件等待</p><label>草稿 <input id="draft"></label><button id="post">提交一次</button><p id="postresult"></p><a href="/next?q=two#anchor">下一页</a><script src="/app.js"></script>`;
const server = http.createServer(async (req, res) => {
  log({
    type: "http",
    method: req.method,
    url: req.url,
    host: req.headers.host,
    credentialsLeaked: !!(
      req.headers.authorization || req.headers["proxy-authorization"]
    ),
  });
  if (req.url === "/style.css") {
    res.setHeader("Content-Type", "text/css");
    res.end(
      "body{font:18px system-ui;padding:20px;background:#e9f7ec}button,input{font-size:20px;margin:12px 0}p{overflow-wrap:anywhere}",
    );
  } else if (req.url === "/app.js") {
    res.setHeader("Content-Type", "text/javascript");
    res.end(`const runId=${JSON.stringify(runId)};
      document.querySelector('#status').textContent='JS + CSS 已加载 · '+location.pathname+location.search+location.hash;
      const ws=new WebSocket('ws://'+location.host+'/ws'); ws.onopen=()=>ws.send(runId); ws.onmessage=e=>document.querySelector('#ws').textContent='WS echo: '+(e.data===runId?'通过':'失败');
      fetch('/large').then(r=>r.arrayBuffer()).then(b=>document.querySelector('#large').textContent='8 MiB: '+(b.byteLength===8388608 && new Uint8Array(b).every(x=>x===97)?'通过':'失败'));
      document.querySelector('#post').onclick=()=>fetch('/post',{method:'POST',body:'fixture-'+runId}).then(r=>r.json()).then(v=>document.querySelector('#postresult').textContent='POST 次数: '+v.count+' 正文: '+v.correct);
      fetch('http://localhost:'+location.port+'/phone-sentinel').then(()=>document.querySelector('#status').textContent+=' 意外访问手机').catch(()=>{});`);
  } else if (req.url === "/large") {
    res.setHeader("Content-Type", "application/octet-stream");
    res.end(payload);
  } else if (req.url === "/post") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    posts++;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        count: posts,
        correct: Buffer.concat(chunks).toString() === "fixture-" + runId,
      }),
    );
  } else {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
  }
});
const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws, request) => {
  log({ type: "websocket", host: request.headers.host });
  ws.on("message", (data) => {
    log({ type: "echo", correct: data.toString() === runId });
    ws.send(data.toString());
  });
});
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  const manifest = {
    runId,
    pid: process.pid,
    host: "127.0.0.1",
    port,
    url: `http://localhost:${port}/preview?q=one#fragment`,
    hash,
  };
  writeFileSync(
    path.join(directory, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  console.log(JSON.stringify(manifest));
});
process.on("SIGTERM", () => {
  for (const ws of wss.clients) ws.terminate();
  wss.close();
  server.close();
  server.closeAllConnections();
});
