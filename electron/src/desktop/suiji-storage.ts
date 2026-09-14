import {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  type IpcMainInvokeEvent,
} from "electron";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  SuijiDesktopState,
  SuijiEnvironment,
  SuijiProfile,
} from "@runweave/shared/suiji/desktop";
import { CUSTOM_PROTOCOL, DEV_SERVER_URL, isDev } from "./config.js";

function authorize(event: IpcMainInvokeEvent) {
  const url = new URL(event.senderFrame?.url ?? "about:blank");
  const trusted = isDev
    ? url.origin === new URL(DEV_SERVER_URL).origin
    : url.protocol === `${CUSTOM_PROTOCOL}:` && url.host === "app";
  if (
    !BrowserWindow.fromWebContents(event.sender) ||
    event.senderFrame !== event.sender.mainFrame ||
    !trusted
  )
    throw new Error("随记凭据只允许本机应用访问");
}
function environment(value: unknown): asserts value is SuijiEnvironment {
  if (value !== "production" && value !== "development")
    throw new Error("无效的随记环境");
}
function profile(value: SuijiProfile) {
  if (
    !value ||
    typeof value.endpoint !== "string" ||
    typeof value.username !== "string" ||
    (value.password !== undefined && typeof value.password !== "string") ||
    JSON.stringify(value).length > 32768
  )
    throw new Error("无效的随记账户配置");
  const url = new URL(value.endpoint);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("无效的随记服务地址");
  if (
    url.protocol === "http:" &&
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  )
    throw new Error("远程随记服务需要 HTTPS");
}
export function registerSuijiStorage() {
  const file = path.join(app.getPath("userData"), "suiji", "accounts.v1.enc");
  // Serialize read-modify-write operations, including token rotation and logout.
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work);
    queue = result.catch(() => undefined);
    return result;
  };
  const read = async (): Promise<SuijiDesktopState> => {
    let data: Buffer;
    try {
      data = await readFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return {
        active: "production",
        profiles: {
          production: { endpoint: "", username: "" },
          development: { endpoint: "http://127.0.0.1:4783", username: "" },
        },
      };
    }
    const decrypted = await safeStorage.decryptStringAsync(data);
    return JSON.parse(decrypted.result) as SuijiDesktopState;
  };
  const write = async (state: SuijiDesktopState) => {
    if (!(await safeStorage.isAsyncEncryptionAvailable()))
      throw new Error("系统安全存储不可用，账户尚未保存");
    const encrypted = await safeStorage.encryptStringAsync(
      JSON.stringify(state),
    );
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, encrypted, { mode: 0o600 });
    await rename(temporary, file);
  };
  ipcMain.handle("suiji:load", (event) => {
    authorize(event);
    return serialized(read);
  });
  ipcMain.handle(
    "suiji:save-profile",
    (event, env: SuijiEnvironment, value: SuijiProfile) => {
      authorize(event);
      environment(env);
      profile(value);
      return serialized(async () => {
        const state = await read();
        state.profiles[env] = value;
        await write(state);
      });
    },
  );
  ipcMain.handle("suiji:select-environment", (event, env: SuijiEnvironment) => {
    authorize(event);
    environment(env);
    return serialized(async () => {
      const state = await read();
      state.active = env;
      await write(state);
    });
  });
}
