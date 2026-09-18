// Observable HTTP fixture for native history/storage/cancellation acceptance.
import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
const directory = path.resolve(process.argv[2]);
mkdirSync(directory, { recursive: true });
const runId = randomUUID();
const sockets = new Set();
const pending = new Set();
let posts = 0;
const log = (value) =>
  appendFileSync(
    path.join(directory, "events.jsonl"),
    JSON.stringify({ at: Date.now(), ...value }) + "\n",
  );
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://fixture");
  log({
    method: req.method,
    path: req.url,
    host: req.headers.host,
    cookie: req.headers.cookie ?? "",
    credentialsLeaked: !!(
      req.headers.authorization || req.headers["proxy-authorization"]
    ),
  });
  if (url.pathname === "/redirect") {
    res.writeHead(302, { Location: "/page-b?q=two#anchor" });
    res.end();
    return;
  }
  if (url.pathname === "/hold" || url.pathname === "/delayed-post") {
    if (req.method === "POST") {
      const body = [];
      for await (const chunk of req) body.push(chunk);
      posts++;
      log({
        event: "post-received",
        posts,
        body: Buffer.concat(body).toString(),
      });
    }
    pending.add(res);
    res.on("close", () => pending.delete(res));
    return;
  }
  if (url.pathname === "/tick" || url.pathname === "/report") {
    res.end("ok");
    return;
  }
  if (url.pathname === "/frame") {
    res.end("<p>同源 iframe 成功</p>");
    return;
  }
  const history = url.pathname === "/page-b" || url.pathname === "/page-c";
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>本地验收 ${url.pathname}</title>
    <style>body{font:17px system-ui;padding:12px;background:#edf7ed}input,button,a{font:18px system-ui;display:block;margin:12px 0}p{overflow-wrap:anywhere}</style>
    <h1>${history ? url.pathname : "生命周期验收"}</h1><p>${runId}</p><p id="where"></p><p id="state"></p>
    <label>未提交草稿<input id="draft"></label><button id="mark">写入网站数据</button><button id="hold">开始延迟请求</button><button id="post">提交并等待响应</button><p id="result">尚未提交</p>
    <a href="/page-c?next=1#end" target="_blank">新窗口到 C</a><a href="#anchor2">页面锚点</a>
    <iframe src="/frame" title="同源框架" height="45"></iframe><label>粘贴检查<input id="paste"></label>
    <script>
    where.textContent=location.pathname+location.search+location.hash;
    let loads=Number(sessionStorage.getItem('loads')||0)+1; sessionStorage.setItem('loads',loads);
    let db; const request=indexedDB.open('fixture',1);request.onupgradeneeded=()=>request.result.createObjectStore('data');
    request.onsuccess=()=>{db=request.result;const r=db.transaction('data').objectStore('data').get('mark');r.onsuccess=()=>show(r.result||'empty')};
    function show(idb){document.querySelector('#state').textContent='加载 '+loads+' Cookie '+(document.cookie||'empty')+' Local '+(localStorage.mark||'empty')+' IDB '+idb;}
    mark.onclick=()=>{document.cookie='fixture=marked; SameSite=Lax';localStorage.mark='marked';db.transaction('data','readwrite').objectStore('data').put('marked','mark');show('marked');};
    hold.onclick=()=>{fetch('/hold').then(r=>r.text()).then(()=>{localStorage.late='written';fetch('/report?late=1')});result.textContent='延迟请求中';};
    post.onclick=()=>{result.textContent='提交等待中';fetch('/delayed-post',{method:'POST',body:${JSON.stringify(runId)}}).then(r=>r.text()).then(()=>result.textContent='提交成功').catch(()=>result.textContent='提交响应失败');};
    setInterval(()=>fetch('/tick'),1000);
    </script>`);
});
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});
const control = http.createServer((req, res) => {
  if (req.url === "/cut") {
    for (const socket of sockets) socket.destroy();
  }
  if (req.url === "/release") {
    for (const response of pending) response.end("released");
  }
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      runId,
      posts,
      sockets: sockets.size,
      pending: pending.size,
    }),
  );
});
server.listen(0, "127.0.0.1", () =>
  control.listen(0, "127.0.0.1", () => {
    const manifest = {
      runId,
      pid: process.pid,
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
