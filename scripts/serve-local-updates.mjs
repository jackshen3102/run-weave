import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";

const workspaceRoot = process.cwd();
const rootDir = path.join(workspaceRoot, ".local-updates");
const host = process.env.BROWSER_VIEWER_LOCAL_UPDATES_HOST ?? "127.0.0.1";
const port = Number(process.env.BROWSER_VIEWER_LOCAL_UPDATES_PORT ?? "5500");

const contentTypes = new Map([
  [".yml", "text/yaml; charset=utf-8"],
  [".zip", "application/zip"],
  [".dmg", "application/x-apple-diskimage"],
  [".blockmap", "application/octet-stream"],
]);

function resolveContentType(filePath) {
  return contentTypes.get(path.extname(filePath)) ?? "application/octet-stream";
}

function resolveFilePath(urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const normalized = path.normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, "");
  const candidate = path.join(rootDir, normalized);

  if (!candidate.startsWith(rootDir)) {
    return null;
  }

  return candidate;
}

const server = http.createServer(async (req, res) => {
  const requestPath = req.url === "/" ? "/index.html" : req.url ?? "/";
  const filePath = resolveFilePath(requestPath);

  if (!filePath) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const stat = await fs.stat(filePath);

    if (stat.isDirectory()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const file = await fs.readFile(filePath);
    res.writeHead(200, {
      "Content-Type": resolveContentType(filePath),
      "Content-Length": stat.size,
      "Cache-Control": "no-store",
    });
    res.end(file);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(port, host, () => {
  console.log(`[local-updates] serving ${rootDir} at http://${host}:${port}/`);
});
