import { Router } from "express";

export function createTestRouter(): Router {
  const router = Router();

  router.get("/popup", (_req, res) => {
    res.type("html").send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Popup Source</title>
    <style>
      body { margin: 0; font-family: sans-serif; background: #f2f4f8; }
      #open {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        margin: 20px;
        width: 280px;
        height: 100px;
        font-size: 18px;
        text-decoration: none;
        color: #111827;
        border: 1px solid #9ca3af;
        border-radius: 8px;
        background: #e5e7eb;
      }
    </style>
  </head>
  <body>
    <a id="open" href="/test/child" target="_blank" rel="noopener noreferrer">
      Open Child Tab
    </a>
  </body>
</html>`);
  });

  router.get("/popup-auto", (_req, res) => {
    res.type("html").send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Popup Auto Source</title>
  </head>
  <body>
    <h1>Popup Auto Source</h1>
    <script>
      window.open("/test/child", "_blank", "noopener,noreferrer");
    </script>
  </body>
</html>`);
  });

  router.get("/child", (_req, res) => {
    res.type("html").send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Popup Child</title>
  </head>
  <body>
    <h1>Popup Child</h1>
    <p>Opened from source page.</p>
  </body>
</html>`);
  });

  router.get("/navigation-chain", (_req, res) => {
    res.type("html").send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Navigation Chain</title>
  </head>
  <body>
    <h1>Navigation Chain</h1>
    <a href="/test/navigation-final">Next page</a>
  </body>
</html>`);
  });

  router.get("/navigation-final", (_req, res) => {
    res.type("html").send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Navigation Final</title>
  </head>
  <body>
    <h1>Navigation Final</h1>
    <p>Reached the stable destination page.</p>
  </body>
</html>`);
  });

  router.get("/disconnect-recover", (req, res) => {
    const label = req.query.label;
    const title =
      typeof label === "string" && label.trim()
        ? label.trim()
        : "Disconnect Recover";

    res.type("html").send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <style>
      body {
        margin: 0;
        font-family: sans-serif;
        background: #0f172a;
        color: #e2e8f0;
        display: grid;
        place-items: center;
        min-height: 100vh;
      }
      main {
        width: min(90vw, 540px);
        border: 1px solid rgba(148, 163, 184, 0.25);
        border-radius: 16px;
        padding: 24px;
        background: rgba(15, 23, 42, 0.88);
      }
      strong {
        color: #7dd3fc;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${title}</h1>
      <p>This page is used to validate viewer recovery after a forced websocket disconnect.</p>
      <p id="heartbeat">Heartbeat: <strong>alive</strong></p>
      <script>
        let count = 0;
        const heartbeat = document.getElementById("heartbeat");
        window.setInterval(() => {
          count += 1;
          if (heartbeat) {
            heartbeat.innerHTML = "Heartbeat: <strong>alive #" + count + "</strong>";
          }
          document.title = "${title} " + count;
        }, 1000);
      </script>
    </main>
  </body>
</html>`);
  });

  return router;
}
