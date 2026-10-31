import { app, ipcMain, type BrowserWindow } from 'electron';
import { parseScreenConversationLink, type ScreenConversationLink } from '@runweave/shared/screen-recording';

export function registerScreenConversationLinks(window: () => BrowserWindow | null): void {
  let pending: ScreenConversationLink | null = null;
  const accept = (raw: string) => {
    const value = parseScreenConversationLink(raw);
    if (!value) return;
    pending = value;
    const main = window();
    if (!main || main.isDestroyed()) return;
    main.show(); main.focus();
    main.webContents.send('screen-conversation:available');
  };
  app.on('open-url', (event, url) => { if (parseScreenConversationLink(url)) { event.preventDefault(); accept(url); } });
  app.on('second-instance', (_event, args) => { for (const arg of args) if (parseScreenConversationLink(arg)) accept(arg); });
  ipcMain.handle('screen-conversation:take', event => {
    if (event.sender !== window()?.webContents) throw new Error('FORBIDDEN');
    const value = pending; pending = null; return value;
  });
}
