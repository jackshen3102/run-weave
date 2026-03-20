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

  return router;
}
