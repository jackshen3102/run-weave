import type { MenuItemConstructorOptions } from "electron";

export function buildApplicationMenuTemplate(params: {
  platform: NodeJS.Platform;
  onNewWindow: () => void;
  onExportDesktopDiagnostics?: () => void;
  onOpenSystemMonitor?: () => void;
  onReloadLocalRuntime?: () => void;
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
      ...(params.onReloadLocalRuntime
        ? [
            { type: "separator" as const },
            {
              label: "Reload Local Runtime",
              click: () => {
                void params.onReloadLocalRuntime?.();
              },
            },
          ]
        : []),
      ...(params.onExportDesktopDiagnostics
        ? [
            { type: "separator" as const },
            {
              label: "Export Desktop Diagnostics",
              click: () => {
                params.onExportDesktopDiagnostics?.();
              },
            },
          ]
        : []),
      { type: "separator" },
      { role: params.platform === "darwin" ? "close" : "quit" },
    ],
  });
  template.push({ role: "editMenu" });
  template.push({
    label: "View",
    submenu: [
      { role: "reload" },
      { role: "forceReload" },
      { role: "toggleDevTools" },
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
      ...(params.onOpenSystemMonitor
        ? [
            { type: "separator" as const },
            {
              label: "System Monitor",
              accelerator: "CmdOrCtrl+Shift+M",
              click: () => {
                params.onOpenSystemMonitor?.();
              },
            },
          ]
        : []),
    ],
  });
  template.push({ role: "windowMenu" });

  return template;
}
