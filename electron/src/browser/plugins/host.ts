import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import type {
  BrowserPluginCommand,
  BrowserPluginMenuItem,
  BrowserPluginSnapshot,
} from "@runweave/shared/browser-plugins";
import type {
  BrowserPlugin,
  BrowserPluginContext,
  BrowserPluginPage,
  BrowserPluginPageInput,
} from "./contract.js";
import { browserPlugins } from "./registry.js";
import { TERMINAL_BROWSER_PROFILE_IDS } from "@runweave/shared/terminal-browser-profile";

type Page = {
  context: BrowserPluginPageInput;
  active: Map<string, () => void>;
  dispose: () => void;
};
const pages = new Map<WebContents, Page>();
const errors = new Map<string, string>();
let stopping = false;
const key = (plugin: BrowserPlugin, profile: string) =>
  `${profile}:${plugin.id}`;
function error(plugin: BrowserPlugin, profile: string, value: unknown) {
  errors.set(
    key(plugin, profile),
    value instanceof Error ? value.message : String(value),
  );
}
function attach(page: Page, plugin: BrowserPlugin) {
  if (!plugin.attach || page.active.has(plugin.id)) return;
  try {
    if (!plugin.status(page.context.profileId).enabled) return;
  } catch (e) {
    error(plugin, page.context.profileId, e);
    return;
  }
  const cleanups: Array<() => void> = [];
  const dispose = () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        cleanup();
      } catch (e) {
        error(plugin, page.context.profileId, e);
      }
    }
  };
  const context: BrowserPluginPage = {
    ...page.context,
    get restoring() {
      return page.context.restoring;
    },
    listen(event, callback) {
      const invoke = (...args: unknown[]) => {
        try {
          callback(...(args as Parameters<typeof callback>));
        } catch (e) {
          error(plugin, context.profileId, e);
          dispose();
          page.active.delete(plugin.id);
        }
      };
      (context.contents as EventEmitter).on(event, invoke);
      cleanups.push(() => {
        (context.contents as EventEmitter).removeListener(event, invoke);
      });
    },
  };
  try {
    const cleanup = plugin.attach(context);
    if (cleanup) cleanups.push(cleanup);
    page.active.set(plugin.id, dispose);
  } catch (e) {
    dispose();
    error(plugin, context.profileId, e);
  }
}
export function attachBrowserPlugins(input: BrowserPluginPageInput): void {
  if (stopping || pages.has(input.contents)) return;
  const context = { ...input };
  let restoreStarted = false;
  const navigation = (
    _event: Electron.Event,
    _url: string,
    inPlace: boolean,
    main: boolean,
  ) => {
    if (!main || inPlace || !context.restoring) return;
    if (restoreStarted) context.restoring = false;
    restoreStarted = true;
  };
  const settled = () => {
    context.restoring = false;
  };
  const page: Page = {
    context,
    active: new Map(),
    dispose: () => {
      for (const dispose of page.active.values()) dispose();
      page.active.clear();
      input.contents.removeListener("did-start-navigation", navigation);
      input.contents.removeListener("did-stop-loading", settled);
      input.contents.removeListener("destroyed", page.dispose);
      pages.delete(input.contents);
    },
  };
  input.contents.on("did-start-navigation", navigation);
  input.contents.on("did-stop-loading", settled);
  input.contents.once("destroyed", page.dispose);
  pages.set(input.contents, page);
  for (const plugin of browserPlugins) attach(page, plugin);
}
export async function startBrowserPlugins(): Promise<void> {
  for (const plugin of browserPlugins) {
    try {
      await plugin.start?.();
    } catch (e) {
      for (const profile of TERMINAL_BROWSER_PROFILE_IDS)
        error(plugin, profile, e);
    }
  }
}
export function getBrowserPlugins(
  profile: BrowserPluginCommand["profileId"],
): BrowserPluginSnapshot[] {
  return browserPlugins.map((plugin) => {
    try {
      const status = plugin.status(profile),
        fault = errors.get(key(plugin, profile));
      return {
        id: plugin.id,
        name: plugin.name,
        kind: plugin.kind,
        ...status,
        ...(fault
          ? {
              state: "error" as const,
              summary: "插件错误",
              detail: `${fault}\n${status.detail}`,
            }
          : {}),
        commands: plugin.commands(profile),
      };
    } catch (e) {
      return {
        id: plugin.id,
        name: plugin.name,
        kind: plugin.kind,
        enabled: false,
        state: "error" as const,
        summary: "不可用",
        detail: String(e),
        commands: [],
      };
    }
  });
}
function findCommand(
  items: BrowserPluginMenuItem[],
  id: string,
): BrowserPluginMenuItem | undefined {
  for (const item of items) {
    if (item.id === id) return item;
    const child = item.children && findCommand(item.children, id);
    if (child) return child;
  }
}
export async function runBrowserPluginCommand(
  context: BrowserPluginContext,
  request: BrowserPluginCommand,
): Promise<void> {
  const plugin = browserPlugins.find((p) => p.id === request.pluginId);
  const command =
    plugin &&
    findCommand(plugin.commands(context.profileId), request.commandId);
  if (!plugin || !command || command.enabled === false || command.children)
    throw Error("INVALID_BROWSER_PLUGIN_COMMAND");
  try {
    await plugin.run(context, request.commandId);
    errors.delete(key(plugin, context.profileId));
  } catch (e) {
    error(plugin, context.profileId, e);
    throw e;
  } finally {
    for (const page of pages.values()) {
      if (page.context.profileId !== context.profileId) continue;
      if (!plugin.status(context.profileId).enabled) {
        page.active.get(plugin.id)?.();
        page.active.delete(plugin.id);
      } else attach(page, plugin);
    }
  }
}
export async function stopBrowserPlugins(): Promise<void> {
  stopping = true;
  for (const page of [...pages.values()]) page.dispose();
  await Promise.allSettled(browserPlugins.map((plugin) => plugin.stop?.()));
}
