import { existsSync } from "node:fs";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import {
  ConfigurationError, ConfigurationStore, assertNewStableInstallation,
  prepareInitialConfiguration,
} from "@runweave/config-node";
import { resolveDesktopConfigurationContext } from "./desktop/configuration-context.js";

async function bootstrap(): Promise<void> {
  const context = resolveDesktopConfigurationContext();
  const store = new ConfigurationStore(context);
  if (existsSync(store.file)) {
    store.read();
    await import("./main.js");
    return;
  }
  await app.whenReady();
  if (context.kind !== "stable") throw new ConfigurationError("CONFIG_MIGRATION_REQUIRED");
  const selected = () => {
    const desktopData = app.getPath("userData");
    return existsSync(desktopData) ? { desktopData } : {};
  };
  try { assertNewStableInstallation(context, selected()); }
  catch (error) {
    if (error instanceof ConfigurationError && error.code === "CONFIG_MIGRATION_REQUIRED") {
      showSetupWindow("migration");
      return;
    }
    throw error;
  }
  const window = showSetupWindow("new-install");
  ipcMain.handle("runweave:configuration:init", async (event, input: unknown) => {
    if (event.sender.id !== window.webContents.id || !input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "CONFIG_INITIAL_AUTH_INVALID" };
    const value = input as Record<string, unknown>;
    if (Object.keys(value).some((key) => !["username", "password", "confirmed"].includes(key)) || value.confirmed !== true || typeof value.username !== "string" || typeof value.password !== "string") return { ok: false, error: "CONFIG_NEW_INSTALL_CONFIRMATION_REQUIRED" };
    try {
      assertNewStableInstallation(context, selected());
      const draft = prepareInitialConfiguration(context, { username: value.username, password: value.password });
      store.initialize(draft);
      setTimeout(() => { app.relaunch(); app.exit(0); }, 250);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof ConfigurationError ? error.code : "CONFIG_INITIALIZATION_FAILED" };
    }
  });
}

function showSetupWindow(mode: "migration" | "new-install"): BrowserWindow {
  const window = new BrowserWindow({
    width: 620, height: mode === "migration" ? 350 : 530, resizable: false,
    title: mode === "migration" ? "Runweave 配置迁移" : "初始化 Runweave",
    webPreferences: {
      preload: path.join(__dirname, "configuration-setup-preload.cjs"),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const setupUrl = `data:text/html;charset=utf-8,${encodeURIComponent(setupHtml(mode))}`;
  window.webContents.on("will-navigate", (event, destination) => {
    if (destination !== setupUrl) event.preventDefault();
  });
  window.on("closed", () => app.quit());
  void window.loadURL(setupUrl);
  return window;
}

function setupHtml(mode: "migration" | "new-install"): string {
  const body = mode === "migration"
    ? `<h1>发现已有 Runweave 数据</h1><p>为了保留现有身份和数据，首次启动前需要先检查迁移草稿。Runweave 不会自动创建新身份或覆盖旧配置。</p><p>在终端运行：</p><code>rw config migrate --instance stable --dry-run --json</code><p>核对来源后按迁移指南完成迁移，再重新打开 App。</p>`
    : `<h1>初始化 Runweave</h1><p>当前用户没有发现旧配置。请创建本机管理员身份；配置将保存到这个用户的私有 settings.yaml。</p><form id="setup"><label>用户名<input name="username" required autocomplete="username"></label><label>密码（至少 16 个字符）<input name="password" type="password" minlength="16" required autocomplete="new-password"></label><label>确认密码<input name="repeat" type="password" minlength="16" required autocomplete="new-password"></label><label class="confirm"><input name="confirmed" type="checkbox" required>我确认这是全新安装，不需要保留旧身份</label><button type="submit">创建并启动</button></form><p id="message" role="status"></p><script>document.getElementById('setup').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget;const message=document.getElementById('message');const password=form.elements.password.value;if(password!==form.elements.repeat.value){message.textContent='两次密码不一致';return;}const button=form.querySelector('button');button.disabled=true;try{const result=await window.runweaveSetup.initialize({username:form.elements.username.value,password,confirmed:form.elements.confirmed.checked});form.elements.password.value='';form.elements.repeat.value='';message.textContent=result.ok?'已创建配置，正在启动…':('无法初始化：'+result.error);}catch{message.textContent='无法初始化，请重试。';}finally{button.disabled=false;}});</script>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><title>Runweave 配置</title><style>body{font:14px -apple-system,BlinkMacSystemFont,sans-serif;color:#202124;background:#fff;padding:28px;line-height:1.6}h1{font-size:23px;margin:0 0 16px}p{color:#555}code{display:block;padding:12px;background:#f3f4f6;border-radius:6px;user-select:all}label{display:block;margin:12px 0}label>input:not([type=checkbox]){display:block;box-sizing:border-box;width:100%;padding:9px;border:1px solid #aaa;border-radius:5px}.confirm{display:flex;gap:8px;align-items:center}button{background:#1263d6;color:white;border:0;border-radius:5px;padding:10px 16px;cursor:pointer}button:disabled{opacity:.55}#message{min-height:22px}</style></head><body>${body}</body></html>`;
}

void bootstrap().catch((error: unknown) => {
  const code = error instanceof ConfigurationError ? error.code : "CONFIG_STARTUP_FAILED";
  void app.whenReady().then(() => { dialog.showErrorBox("Runweave 配置无法读取", `${code}\n请先在本机执行 rw config doctor --instance stable。原配置没有被修改。`); app.quit(); });
});
