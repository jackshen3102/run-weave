import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("runweaveSetup", {
  initialize: (input: { username: string; password: string; confirmed: boolean }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("runweave:configuration:init", input),
});
