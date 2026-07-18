import {
  type BrowserWindow,
  Menu,
  type MenuItemConstructorOptions,
} from "electron";
import type {
  TerminalBrowserToolMenuAction,
  TerminalBrowserToolMenuRequest,
} from "@runweave/shared/terminal-browser-tool-menu";

function isTerminalBrowserToolMenuRequest(
  value: unknown,
): value is TerminalBrowserToolMenuRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const request = value as Record<string, unknown>;
  return (
    typeof request.x === "number" &&
    Number.isFinite(request.x) &&
    typeof request.y === "number" &&
    Number.isFinite(request.y) &&
    typeof request.showAnnotation === "boolean" &&
    typeof request.annotationActive === "boolean" &&
    typeof request.annotationSubmitEnabled === "boolean" &&
    typeof request.showHeaders === "boolean" &&
    typeof request.deviceEnabled === "boolean" &&
    typeof request.devtoolsEnabled === "boolean"
  );
}

export async function popupTerminalBrowserToolMenu(
  win: BrowserWindow,
  value: unknown,
): Promise<TerminalBrowserToolMenuAction | null> {
  if (!isTerminalBrowserToolMenuRequest(value)) {
    throw new Error("Invalid terminal browser tool menu request");
  }

  return await new Promise((resolve) => {
    let selected = false;
    const select = (action: TerminalBrowserToolMenuAction): void => {
      selected = true;
      resolve(action);
    };
    const template: MenuItemConstructorOptions[] = [];

    if (value.showAnnotation) {
      template.push({
        label: value.annotationActive
          ? "Stop Browser Comments"
          : "Add Browser Comments",
        click: () => select("toggle-annotation"),
      });
    }
    template.push({
      label: "Submit Browser Comments",
      enabled: value.annotationSubmitEnabled,
      click: () => select("submit-annotations"),
    });
    if (value.showHeaders) {
      template.push({
        label: "Request Headers",
        click: () => select("open-headers"),
      });
    }
    template.push(
      {
        label: "Device Mode",
        enabled: value.deviceEnabled,
        click: () => select("open-device"),
      },
      {
        label: "Browser DevTools",
        enabled: value.devtoolsEnabled,
        click: () => select("open-devtools"),
      },
      {
        label: "Open in System Browser",
        click: () => select("open-external"),
      },
    );

    const contentSize = win.getContentSize();
    const contentWidth = contentSize[0] ?? 1;
    const contentHeight = contentSize[1] ?? 1;
    const menu = Menu.buildFromTemplate(template);
    menu.popup({
      window: win,
      x: Math.max(0, Math.min(Math.round(value.x), contentWidth - 1)),
      y: Math.max(0, Math.min(Math.round(value.y), contentHeight - 1)),
      callback: () => {
        if (!selected) {
          resolve(null);
        }
      },
    });
  });
}
