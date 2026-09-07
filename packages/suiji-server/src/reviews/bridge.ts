import { randomBytes, timingSafeEqual } from "node:crypto";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { ReviewContext } from "./context";

// Every review owns a short-lived loopback listener and a capability that has no write tools.
export async function openReviewBridge(
  context: ReviewContext,
  requestId: string,
) {
  const token = randomBytes(32).toString("base64url");
  const expected = Buffer.from(`Bearer ${token}`);
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.post("/mcp", (req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? "");
    if (
      req.headers.origin !== undefined ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      res.sendStatus(401);
      return;
    }
    const server = context.server(requestId);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.once("close", () => {
      void server.close().catch(() => undefined);
    });
    void server
      .connect(transport)
      .then(() => transport.handleRequest(req, res, req.body))
      .catch(() => {
        if (!res.headersSent) res.sendStatus(503);
        else res.destroy();
        void server.close().catch(() => undefined);
      });
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    listener.once("listening", resolve);
    listener.once("error", reject);
  });
  const address = listener.address();
  if (!address || typeof address === "string")
    throw new Error("Review bridge unavailable");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    token,
    close: () => {
      listener.closeAllConnections();
      listener.close();
    },
  };
}
