import http from "node:http";
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/redirect") {
    res.writeHead(302, { location: "/redirect2" });
    res.end();
    return;
  }
  if (url.pathname === "/redirect2") {
    res.writeHead(302, { location: "/a" });
    res.end();
    return;
  }
  if (url.pathname === "/failed") {
    req.socket.destroy();
    return;
  }
  const title =
    url.pathname === "/b"
      ? "浏览样例乙"
      : url.pathname === "/iframe"
        ? "子框架不计入"
        : "浏览样例甲";
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><meta charset="utf-8"><title>${url.pathname === "/slow" ? "" : title}</title><h1>${title}</h1>
    <a href="/b">进入乙页</a><button onclick="history.pushState({},'', '/spa/next');document.title='单页主题下一项'">切换单页路径</button>
    <button onclick="document.title='仅更新标题'">更新标题</button><button onclick="location.hash='route-two'">更改片段</button>
    ${url.pathname === "/a" ? '<iframe src="/iframe"></iframe>' : ""}
    ${url.pathname === "/slow" ? "<script>setTimeout(()=>document.title='延迟标题甲',1800)</script>" : ""}`);
});
server.listen(0, "127.0.0.1", () =>
  console.log(
    JSON.stringify({
      url: `http://127.0.0.1:${server.address().port}`,
      pid: process.pid,
    }),
  ),
);
process.on("SIGTERM", () => server.close());
