import { describe, expect, it, vi } from "vitest";
import {
  createTerminalProject,
  createTerminalSession,
  createTerminalSessionClipboardImage,
  createTerminalWsTicket,
  deleteTerminalProject,
  deleteTerminalSession,
  getTerminalProjectPreviewAsset,
  getTerminalProjectPreviewFile,
  getTerminalProjectPreviewFileDiff,
  getTerminalProjectPreviewGitChanges,
  getTerminalHistory,
  getTerminalSession,
  listTerminalProjects,
  listTerminalSessions,
  searchTerminalProjectPreviewFiles,
  updateTerminalProject,
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

  it("forwards inheritFromTerminalSessionId when creating a terminal session", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ terminalSessionId: "terminal-2" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await createTerminalSession("http://localhost:5001", "token-1", {
      inheritFromTerminalSessionId: "terminal-1",
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
          inheritFromTerminalSessionId: "terminal-1",
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

  it("lists terminal projects", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => [],
    }));
    vi.stubGlobal("fetch", fetchMock);

    await listTerminalProjects("http://localhost:5001", "token-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:5001/api/terminal/project",
      {
        headers: {
          Authorization: "Bearer token-1",
        },
      },
    );
  });

  it("creates a terminal project", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ projectId: "project-1" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await createTerminalProject("http://localhost:5001", "token-1", {
      name: "browser-viewer",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:5001/api/terminal/project",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer token-1",
        },
        body: JSON.stringify({
          name: "browser-viewer",
        }),
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

  it("reads terminal history by encoded id", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ terminalSessionId: "terminal/1", scrollback: "" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await getTerminalHistory("http://localhost:5001", "token-1", "terminal/1");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:5001/api/terminal/session/terminal%2F1/history",
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

  it("deletes a terminal project by encoded id", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
    }));
    vi.stubGlobal("fetch", fetchMock);

    await deleteTerminalProject("http://localhost:5001", "token-1", "project/1");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:5001/api/terminal/project/project%2F1",
      {
        method: "DELETE",
        headers: {
          Authorization: "Bearer token-1",
        },
      },
    );
  });

  it("updates a terminal project by encoded id", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ projectId: "project-1" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await updateTerminalProject("http://localhost:5001", "token-1", "project/1", {
      name: "coze-hub",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:5001/api/terminal/project/project%2F1",
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer token-1",
        },
        body: JSON.stringify({
          name: "coze-hub",
        }),
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

  it("uses project-scoped preview endpoints for files, assets, changes, and diffs", async () => {
    const assetBlob = new Blob(["image"]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ kind: "file-search", items: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ kind: "file", path: "docs/plan.md" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        blob: async () => assetBlob,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ kind: "git-changes", staged: [], working: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ kind: "file-diff", path: "README.md" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    await searchTerminalProjectPreviewFiles(
      "http://localhost:5001",
      "token-1",
      "project/1",
      {
        query: "term work",
        limit: 25,
      },
    );
    await getTerminalProjectPreviewFile(
      "http://localhost:5001",
      "token-1",
      "project/1",
      "docs/plan.md",
    );
    await expect(
      getTerminalProjectPreviewAsset(
        "http://localhost:5001",
        "token-1",
        "project/1",
        "screenshots/result.png",
      ),
    ).resolves.toBe(assetBlob);
    await getTerminalProjectPreviewGitChanges(
      "http://localhost:5001",
      "token-1",
      "project/1",
    );
    await getTerminalProjectPreviewFileDiff(
      "http://localhost:5001",
      "token-1",
      "project/1",
      { path: "README.md", kind: "working" },
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://localhost:5001/api/terminal/project/project%2F1/preview/files/search?q=term+work&limit=25",
      {
        headers: {
          Authorization: "Bearer token-1",
        },
      },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://localhost:5001/api/terminal/project/project%2F1/preview/file?path=docs%2Fplan.md",
      {
        headers: {
          Authorization: "Bearer token-1",
        },
      },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "http://localhost:5001/api/terminal/project/project%2F1/preview/asset?path=screenshots%2Fresult.png",
      {
        headers: {
          Authorization: "Bearer token-1",
        },
      },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "http://localhost:5001/api/terminal/project/project%2F1/preview/git-changes",
      {
        headers: {
          Authorization: "Bearer token-1",
        },
      },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      "http://localhost:5001/api/terminal/project/project%2F1/preview/file-diff?path=README.md&kind=working",
      {
        headers: {
          Authorization: "Bearer token-1",
        },
      },
    );
  });
});
