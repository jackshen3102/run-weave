import type { MenuItemConstructorOptions } from "electron";

export function buildApplicationMenuTemplate(params: {
  platform: NodeJS.Platform;
  onNewWindow: () => void;
}): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];

  if (params.platform === "darwin") {
    template.push({ role: "appMenu" });
  }

  template.push({
    label: "File",
    submenu: [
      {
        label: "New Window",
        accelerator: "CmdOrCtrl+Shift+N",
        click: () => {
          params.onNewWindow();
        },
      },
      { type: "separator" },
      { role: params.platform === "darwin" ? "close" : "quit" },
    ],
  });
  template.push({ role: "editMenu" });
  template.push({ role: "viewMenu" });
  template.push({ role: "windowMenu" });

  return template;
}
