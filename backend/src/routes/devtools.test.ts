import { describe, expect, it, vi } from "vitest";
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
  sessionId?: string;
  tabId?: string;
  ticket?: string;
  headers?: Record<string, string>;
  remoteDebuggingPort?: number | null;
  verifyTemporaryToken?: (token: string) => unknown;
  resolveChromiumRevision?: (port: number) => Promise<string | null>;
  resolveTargetIdForSessionTab?: (params: {
    sessionId: string;
    tabId: string;
  }) => Promise<string | null>;
}): Promise<MockResponse> {
  const authService = {
    verifyTemporaryToken: vi.fn(
      options?.verifyTemporaryToken ??
        ((token: string) =>
          token === "ticket-ok"
            ? {
                sessionId: "auth-session-1",
                username: "admin",
                tokenType: "devtools",
                resource: {
                  sessionId: options?.sessionId,
                  tabId: options?.tabId,
                },
              }
            : null),
    ),
  };
  const sessionManager = {
    getRemoteDebuggingPort: vi.fn(() =>
      hasOwnValue(options, "remoteDebuggingPort")
        ? (options.remoteDebuggingPort as number | null)
        : 9222,
    ),
    getSession: vi.fn(),
  };
  const handler = createDevtoolsHandler({
    authService,
    sessionManager: sessionManager as never,
    resolveChromiumRevision:
      options?.resolveChromiumRevision ?? (async () => "1234567"),
    resolveTargetIdForSessionTab:
      options?.resolveTargetIdForSessionTab ?? (async ({ tabId }) => tabId),
  });
  const req = {
    headers: {
      ...(options?.headers ?? {}),
    },
    query: {
      sessionId: options?.sessionId,
      tabId: options?.tabId,
      ticket: options?.ticket,
    },
  };
  const res = createResponse();

  const result = handler(req as never, res as never, vi.fn() as never);
  await Promise.resolve(result);

  return res;
}

describe("devtools routes", () => {
  it("rejects unauthorized request", async () => {
    const response = await runRequest({
      sessionId: "s-1",
      tabId: "tab-1",
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("Missing required sessionId or tabId");
  });

  it("returns 400 when required query params are missing", async () => {
    const response = await runRequest({
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("Missing required sessionId or tabId");
  });

  it("returns 503 when remote debugging is unavailable", async () => {
    const response = await runRequest({
      sessionId: "s-1",
      tabId: "tab-1",
      ticket: "ticket-ok",
      remoteDebuggingPort: null,
    });

    expect(response.statusCode).toBe(503);
  });

  it("returns 404 when target cannot be resolved", async () => {
    const response = await runRequest({
      sessionId: "s-1",
      tabId: "missing",
      ticket: "ticket-ok",
      resolveTargetIdForSessionTab: async () => null,
    });

    expect(response.statusCode).toBe(404);
  });

  it("returns a devtools shell html page", async () => {
    const response = await runRequest({
      sessionId: "s-1",
      tabId: "tab-1",
      ticket: "ticket-ok",
      headers: {
        host: "203.0.113.10:5012",
        "x-forwarded-proto": "https",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("DevTools");
    expect(response.body).toContain(
      "chrome-devtools-frontend.appspot.com/serve_rev/@1234567/inspector.html",
    );
    expect(response.body).toContain(
      "wss=203.0.113.10%3A5012%2Fws%2Fdevtools-proxy%3FsessionId%3Ds-1%26tabId%3Dtab-1%26token%3Dticket-ok",
    );
  });

  it("accepts a query ticket for devtools auth", async () => {
    const response = await runRequest({
      sessionId: "s-1",
      tabId: "tab-1",
      ticket: "ticket-ok",
      headers: {
        host: "127.0.0.1:5012",
        "x-forwarded-proto": "https",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(
      "wss=127.0.0.1%3A5012%2Fws%2Fdevtools-proxy%3FsessionId%3Ds-1%26tabId%3Dtab-1%26token%3Dticket-ok",
    );
  });

  it("uses plain ws when the request is not forwarded as https", async () => {
    const response = await runRequest({
      sessionId: "s-1",
      tabId: "tab-1",
      ticket: "ticket-ok",
      headers: {
        host: "127.0.0.1:5012",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(
      "ws=127.0.0.1%3A5012%2Fws%2Fdevtools-proxy%3FsessionId%3Ds-1%26tabId%3Dtab-1%26token%3Dticket-ok",
    );
  });
});
