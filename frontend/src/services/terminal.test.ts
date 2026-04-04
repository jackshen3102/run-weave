import { describe, expect, it, vi } from "vitest";
import {
  createTerminalSession,
  createTerminalSessionClipboardImage,
  createTerminalWsTicket,
  deleteTerminalSession,
  getTerminalSession,
  listTerminalSessions,
} from "./terminal";

describe("terminal service", () => {
  it("creates a terminal session", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ terminalSessionId: "terminal-1" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await createTerminalSession("http://localhost:5001", "token-1", {
      cwd: "/tmp/project",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:5001/api/terminal/session",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer token-1",
        },
        body: JSON.stringify({
          cwd: "/tmp/project",
        }),
      },
    );
  });

  it("lists terminal sessions", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => [],
    }));
    vi.stubGlobal("fetch", fetchMock);

    await listTerminalSessions("http://localhost:5001", "token-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:5001/api/terminal/session",
      {
        headers: {
          Authorization: "Bearer token-1",
        },
      },
    );
  });

  it("reads a terminal session by encoded id", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ terminalSessionId: "terminal/1" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await getTerminalSession("http://localhost:5001", "token-1", "terminal/1");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:5001/api/terminal/session/terminal%2F1",
      {
        headers: {
          Authorization: "Bearer token-1",
        },
      },
    );
  });

  it("deletes a terminal session by encoded id", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
    }));
    vi.stubGlobal("fetch", fetchMock);

    await deleteTerminalSession(
      "http://localhost:5001",
      "token-1",
      "terminal/1",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:5001/api/terminal/session/terminal%2F1",
      {
        method: "DELETE",
        headers: {
          Authorization: "Bearer token-1",
        },
      },
    );
  });

  it("creates a websocket ticket for a terminal session", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ticket: "ticket-1", expiresIn: 60 }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await createTerminalWsTicket(
      "http://localhost:5001",
      "token-1",
      "terminal/1",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:5001/api/terminal/session/terminal%2F1/ws-ticket",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer token-1",
        },
      },
    );
  });

  it("uploads a clipboard image for a terminal session", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        fileName: "browser-viewer-terminal-image-20260404-120000-abcdef.png",
        filePath:
          "/tmp/browser-viewer-terminal-images/browser-viewer-terminal-image-20260404-120000-abcdef.png",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await createTerminalSessionClipboardImage(
      "http://localhost:5001",
      "token-1",
      "terminal/1",
      {
        mimeType: "image/png",
        dataBase64: "AQIDBA==",
      },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:5001/api/terminal/session/terminal%2F1/clipboard-image",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer token-1",
        },
        body: JSON.stringify({
          mimeType: "image/png",
          dataBase64: "AQIDBA==",
        }),
      },
    );
  });
});
