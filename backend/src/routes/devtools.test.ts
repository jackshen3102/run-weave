import { describe, expect, it, vi } from "vitest";
import { createRequireAuth } from "../auth/middleware";
import { createDevtoolsHandler } from "./devtools";

interface MockResponse {
  body: string;
  headers: Record<string, string>;
  status: (code: number) => MockResponse;
  statusCode: number;
  send: (body: string) => MockResponse;
  json: (body: unknown) => MockResponse;
  setHeader: (name: string, value: string) => void;
}

function createResponse(): MockResponse {
  return {
    body: "",
    headers: {},
    statusCode: 200,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(body: string) {
      this.body = body;
      return this;
    },
    json(body: unknown) {
      this.body = JSON.stringify(body);
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
  };
}

function hasOwnValue<T extends object, K extends PropertyKey>(
  value: T | undefined,
  key: K,
): value is T & Record<K, unknown> {
  return value != null && Object.prototype.hasOwnProperty.call(value, key);
}

async function runRequest(options?: {
  authorization?: string;
  sessionId?: string;
  tabId?: string;
  remoteDebuggingPort?: number | null;
  verifyToken?: (token: string) => boolean;
  resolveChromiumRevision?: (port: number) => Promise<string | null>;
  resolveTargetIdForSessionTab?: (params: {
    sessionId: string;
    tabId: string;
  }) => Promise<string | null>;
}): Promise<MockResponse> {
  const authService = {
    verifyToken: vi.fn(
      options?.verifyToken ?? ((token: string) => token === "ok"),
    ),
  };
  const sessionManager = {
    getRemoteDebuggingPort: vi.fn(
      () =>
        hasOwnValue(options, "remoteDebuggingPort")
          ? (options.remoteDebuggingPort as number | null)
          : 9222,
    ),
    getSession: vi.fn(),
  };
  const requireAuth = createRequireAuth(authService as never);
  const handler = createDevtoolsHandler({
    sessionManager: sessionManager as never,
    resolveChromiumRevision:
      options?.resolveChromiumRevision ?? (async () => "1234567"),
    resolveTargetIdForSessionTab:
      options?.resolveTargetIdForSessionTab ??
      (async ({ tabId }) => tabId),
  });
  const req = {
    headers: options?.authorization
      ? { authorization: options.authorization }
      : {},
    query: {
      sessionId: options?.sessionId,
      tabId: options?.tabId,
    },
  };
  const res = createResponse();

  await new Promise<void>((resolve) => {
    requireAuth(req as never, res as never, () => {
      const result = handler(req as never, res as never, (() => resolve()) as never);
      void Promise.resolve(result)
        .then(() => resolve())
        .catch(() => resolve());
    });

    if (res.body) {
      resolve();
    }
  });

  return res;
}

describe("devtools routes", () => {
  it("rejects unauthorized request", async () => {
    const response = await runRequest({
      sessionId: "s-1",
      tabId: "tab-1",
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toContain("Unauthorized");
  });

  it("returns 400 when required query params are missing", async () => {
    const response = await runRequest({
      authorization: "Bearer ok",
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("Missing required sessionId or tabId");
  });

  it("returns 503 when remote debugging is unavailable", async () => {
    const response = await runRequest({
      authorization: "Bearer ok",
      sessionId: "s-1",
      tabId: "tab-1",
      remoteDebuggingPort: null,
    });

    expect(response.statusCode).toBe(503);
  });

  it("returns 404 when target cannot be resolved", async () => {
    const response = await runRequest({
      authorization: "Bearer ok",
      sessionId: "s-1",
      tabId: "missing",
      resolveTargetIdForSessionTab: async () => null,
    });

    expect(response.statusCode).toBe(404);
  });

  it("returns a devtools shell html page", async () => {
    const response = await runRequest({
      authorization: "Bearer ok",
      sessionId: "s-1",
      tabId: "tab-1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("DevTools");
    expect(response.body).toContain(
      "chrome-devtools-frontend.appspot.com/serve_rev/@1234567/inspector.html",
    );
    expect(response.body).toContain(
      "ws=127.0.0.1%3A9222%2Fdevtools%2Fpage%2Ftab-1",
    );
  });
});
