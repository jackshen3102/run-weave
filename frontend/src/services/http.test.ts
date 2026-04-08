import { describe, expect, it, vi } from "vitest";
import { HttpError, requestJson, requestText, requestVoid } from "./http";

describe("http service helpers", () => {
  it("returns text responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        text: async () => "hello",
      })),
    );

    await expect(requestText("http://localhost:5001", "/health")).resolves.toBe(
      "hello",
    );
  });

  it("throws an HttpError for failed text requests", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 503,
      })),
    );

    await expect(
      requestText("http://localhost:5001", "/health", { method: "POST" }),
    ).rejects.toEqual(new HttpError(503, "POST /health failed: 503"));
  });

  it("throws an HttpError for failed void requests", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 401,
      })),
    );

    await expect(
      requestVoid("http://localhost:5001", "/secure", { method: "DELETE" }),
    ).rejects.toEqual(new HttpError(401, "DELETE /secure failed: 401"));
  });

  it("prefers backend json error messages when present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "content-type"
              ? "application/json; charset=utf-8"
              : null,
        },
        json: async () => ({
          message: "Preferred AI session must be persisted",
        }),
      })),
    );

    await expect(
      requestJson("http://localhost:5001", "/api/session", { method: "POST" }),
    ).rejects.toEqual(
      new HttpError(400, "Preferred AI session must be persisted"),
    );
  });
});
