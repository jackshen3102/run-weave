import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { createSessionFaviconHandler } from "./session-favicon";

interface MockResponse {
  body: Buffer | string;
  headers: Record<string, string>;
  status: (code: number) => MockResponse;
  statusCode: number;
  send: (body: Buffer) => MockResponse;
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
    send(body: Buffer) {
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
  faviconUrl?: string | null;
  fetchFaviconForPage?: () => Promise<{ body: Buffer; contentType: string } | null>;
  sessionExists?: boolean;
  pageExists?: boolean;
  now?: () => number;
}): Promise<{
  handler: ReturnType<typeof createSessionFaviconHandler>;
  response: MockResponse;
  fetchFaviconForPage: ReturnType<typeof vi.fn>;
}> {
  const fetchFaviconForPage = vi.fn(
    options?.fetchFaviconForPage ??
      (async () => ({
        body: Buffer.from("icon"),
        contentType: "image/png",
      })),
  );
  const handler = createSessionFaviconHandler({
    sessionManager: {
      getSession: vi.fn((sessionId: string) =>
        options?.sessionExists === false || sessionId !== "s-1"
          ? undefined
          : { browserSession: { context: {} } },
      ),
    } as never,
    now: options?.now,
    resolvePageForSessionTab: vi.fn(async ({ tabId }) =>
      options?.pageExists === false || tabId !== "tab-1" ? null : ({} as never),
    ),
    resolveTabFaviconUrlForPage: vi.fn(async () =>
      hasOwnValue(options, "faviconUrl")
        ? (options.faviconUrl ?? null)
        : "https://example.com/favicon.ico",
    ),
    fetchFaviconForPage,
  });
  const req = {
    params: {
      id: "s-1",
      tabId: "tab-1",
    },
  };
  const res = createResponse();

  await Promise.resolve(handler(req as never, res as never, vi.fn() as never));

  return { handler, response: res, fetchFaviconForPage };
}

describe("session favicon route", () => {
  it("returns 404 when the session is missing", async () => {
    const { response, fetchFaviconForPage } = await runRequest({
      sessionExists: false,
    });

    expect(response.statusCode).toBe(404);
    expect(fetchFaviconForPage).not.toHaveBeenCalled();
  });

  it("returns 404 when the tab is missing", async () => {
    const { response, fetchFaviconForPage } = await runRequest({
      pageExists: false,
    });

    expect(response.statusCode).toBe(404);
    expect(fetchFaviconForPage).not.toHaveBeenCalled();
  });

  it("returns 404 when the page has no favicon", async () => {
    const { response, fetchFaviconForPage } = await runRequest({
      faviconUrl: null,
    });

    expect(response.statusCode).toBe(404);
    expect(fetchFaviconForPage).not.toHaveBeenCalled();
  });

  it("proxies the favicon payload through the backend", async () => {
    const body = Buffer.from("icon");
    const { response } = await runRequest({
      fetchFaviconForPage: async () => ({
        body,
        contentType: "image/svg+xml",
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/svg+xml");
    expect(response.headers["cache-control"]).toBe("private, max-age=300");
    expect(response.body).toEqual(body);
  });

  it("reuses cached favicon payloads for the same tab and source url", async () => {
    let currentNow = 0;
    const now = () => currentNow;
    const initial = await runRequest({ now });
    expect(initial.fetchFaviconForPage).toHaveBeenCalledTimes(1);

    currentNow = 1000;
    const req = {
      params: {
        id: "s-1",
        tabId: "tab-1",
      },
    };
    const response = createResponse();
    await Promise.resolve(
      initial.handler(req as never, response as never, vi.fn() as never),
    );

    expect(response.statusCode).toBe(200);
    expect(initial.fetchFaviconForPage).toHaveBeenCalledTimes(1);
  });
});
