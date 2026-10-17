/** A disposable Electron process exercises real IPC handlers, frames and broadcast. */
import {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  protocol,
} from "electron";
import {
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { registerBookmarkHandlers } from "../../../electron/src/browser/bookmarks/handlers.ts";
async function main() {
  const root = mkdtempSync(path.join(tmpdir(), "runweave-bookmarks-ipc-"));
  app.setPath("userData", root);
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "runweave",
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
  ]);
  const preload = path.join(root, "fixture-preload.cjs");
  writeFileSync(
    preload,
    `const {contextBridge,ipcRenderer}=require('electron');
let hold=false, release;
const get=()=>ipcRenderer.invoke('terminal-browser:bookmarks-get').then(result=>{if(!hold)return result;hold=false;return new Promise(resolve=>release=()=>resolve(result));});
const api={isElectron:true,terminalBrowserGetBookmarks:get,terminalBrowserMutateBookmarks:request=>ipcRenderer.invoke('terminal-browser:bookmarks-mutate',request),onTerminalBrowserBookmarksChanged:callback=>{const listener=(_e,s)=>callback(s);ipcRenderer.on('terminal-browser:bookmarks-changed',listener);return ()=>ipcRenderer.off('terminal-browser:bookmarks-changed',listener);}};
contextBridge.exposeInMainWorld('electronAPI',api);
contextBridge.exposeInMainWorld('fixture',{get,mutate:api.terminalBrowserMutateBookmarks,hold:()=>hold=true,release:()=>release(),ready:()=>Boolean(release),onUpdate:api.onTerminalBrowserBookmarksChanged});`,
  );
  const windows = [];
  try {
    await app.whenReady();
    protocol.handle(
      "runweave",
      (request) =>
        new Response(
          request.url.endsWith("/frame")
            ? "<p>iframe</p>"
            : '<!doctype html><html><body>IPC fixture<iframe src="runweave://app/frame"></iframe></body></html>',
          { headers: { "content-type": "text/html" } },
        ),
    );
    registerBookmarkHandlers();
    const create = async () => {
      const win = new BrowserWindow({
        show: false,
        webPreferences: {
          preload,
          contextIsolation: true,
          nodeIntegrationInSubFrames: true,
        },
      });
      windows.push(win);
      await win.loadURL("runweave://app/");
      return win;
    };
    const a = await create();
    const b = await create();
    await b.webContents.executeJavaScript(
      readFileSync(process.env.RW_BOOKMARK_FIXTURE_RENDERER, "utf8"),
    );
    await b.webContents.executeJavaScript(
      "window.dispose=electronAPI.onTerminalBrowserBookmarksChanged(s=>bookmarkFixture.getState().accept(s)); fixture.hold(); bookmarkFixture.getState().refresh(); true",
    );
    const initial = await a.webContents.executeJavaScript("fixture.get()");
    assert.equal(initial.ok, true);
    await b.webContents.executeJavaScript(
      "window.received=[]; fixture.onUpdate(s=>window.received.push(s)); true",
    );
    const request = {
      expectedRevision: 0,
      operation: { kind: "add-folder", title: "private-marker" },
    };
    const added = await a.webContents.executeJavaScript(
      `fixture.mutate(${JSON.stringify(request)})`,
    );
    assert.equal(added.ok, true);
    const received = await b.webContents.executeJavaScript("window.received");
    assert.equal(received.at(-1).revision, added.snapshot.revision);
    await b.webContents.executeJavaScript("fixture.release(); true");
    const accepted = await b.webContents.executeJavaScript(
      "bookmarkFixture.getState().snapshot",
    );
    assert.equal(accepted.revision, added.snapshot.revision);
    await b.webContents.executeJavaScript("window.dispose(); true");
    const later = await a.webContents.executeJavaScript(
      'fixture.mutate({expectedRevision:1,operation:{kind:"set-bar-visible",visible:false}})',
    );
    assert.equal(later.ok, true);
    assert.equal(
      (
        await b.webContents.executeJavaScript(
          "bookmarkFixture.getState().snapshot",
        )
      ).revision,
      1,
    );

    // Same-origin subframes have no production bridge. Inject this fixture's narrow preload API only for testing IPC rejection.
    const iframe = a.webContents.mainFrame.frames[0];
    assert.ok(iframe);
    const iframeResult = await iframe.executeJavaScript(
      'typeof fixture === "object" ? fixture.get() : "no-bridge"',
    );
    assert.equal(
      iframeResult === "no-bridge" || iframeResult.error?.code === "FORBIDDEN",
      true,
    );
    const view = new WebContentsView({
      webPreferences: {
        preload,
        contextIsolation: true,
        nodeIntegrationInSubFrames: true,
      },
    });
    a.contentView.addChildView(view);
    await view.webContents.loadURL("data:text/html,<p>web page</p>");
    const denied = await view.webContents.executeJavaScript("fixture.get()");
    assert.equal(denied.error.code, "FORBIDDEN");
    for (const sender of [iframe, view.webContents]) {
      const writeDenied = await sender.executeJavaScript(
        'typeof fixture === "object" ? fixture.mutate({expectedRevision:2,operation:{kind:"add-folder",title:"forbidden"}}) : "no-bridge"',
      );
      assert.equal(
        writeDenied === "no-bridge" || writeDenied.error?.code === "FORBIDDEN",
        true,
      );
    }
    const unchanged = await a.webContents.executeJavaScript("fixture.get()");
    assert.equal(unchanged.snapshot.revision, 2);
    assert.equal(
      JSON.parse(
        readFileSync(path.join(root, "terminal-browser-bookmarks.v1.json")),
      ).entries[0].title,
      "private-marker",
    );
    // Make the actual atomic rename fail without replacing the committed bytes.
    const file = path.join(root, "terminal-browser-bookmarks.v1.json");
    const originalBytes = readFileSync(file);
    const receivedBefore =
      await b.webContents.executeJavaScript("received.length");
    renameSync(file, file + ".saved");
    mkdirSync(file);
    const writeFailed = await a.webContents.executeJavaScript(
      'fixture.mutate({expectedRevision:2,operation:{kind:"add-folder",title:"write-failure"}})',
    );
    assert.equal(writeFailed.error.code, "STORE_UNAVAILABLE");
    assert.equal(
      (await a.webContents.executeJavaScript("fixture.get()")).snapshot
        .revision,
      2,
    );
    assert.equal(
      await b.webContents.executeJavaScript("received.length"),
      receivedBefore,
    );
    assert.deepEqual(readFileSync(file + ".saved"), originalBytes);
    rmSync(file, { recursive: true });
    renameSync(file + ".saved", file);
    const recovered = await a.webContents.executeJavaScript(
      'fixture.mutate({expectedRevision:2,operation:{kind:"add-folder",title:"explicit-retry"}})',
    );
    assert.equal(recovered.ok, true);
    assert.equal(JSON.parse(readFileSync(file)).revision, 3);
    view.webContents.close();
    console.log(
      JSON.stringify(
        {
          ok: true,
          report: [
            "BKI-003: actual atomic rename failure sends no success broadcast; explicit retry recovers",
            "BKI-007: real two-window IPC broadcast",
            "BKI-008: iframe has no bridge and embedded WebContents forbidden",
          ],
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    for (const win of windows) if (!win.isDestroyed()) win.destroy();
    ipcMain.removeHandler("terminal-browser:bookmarks-get");
    ipcMain.removeHandler("terminal-browser:bookmarks-mutate");
    ipcMain.removeHandler("terminal-browser:bookmark-target");
    rmSync(root, { recursive: true, force: true });
    app.exit(process.exitCode || 0);
  }
}
void main();
