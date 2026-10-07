import type { TerminalBrowserProfileId } from "@runweave/shared/terminal-browser-profile";
export type TerminalSidecarTool =
  | "preview"
  | "automation"
  | "browser"
  | "agent-team"
  | "race"
  | "handoff"
  | "task-supervision"
  | "conversation";

export type SidecarTabId = Exclude<TerminalSidecarTool, "browser"> | TerminalBrowserProfileId;

export interface SidecarTabLayout {
  version: 1;
  order: SidecarTabId[];
  hidden: SidecarTabId[];
}

export const SIDECAR_TABS: ReadonlyArray<{ id: SidecarTabId; label: string }> = [
  { id: "preview", label: "Preview" },
  { id: "automation", label: "Automation" },
  { id: "profile-1", label: "Browser 1" },
  { id: "profile-2", label: "Browser 2" },
  { id: "profile-3", label: "Browser 3" },
  { id: "agent-team", label: "Agent Team" },
  { id: "race", label: "Race" },
  { id: "handoff", label: "任务交接" },
  { id: "task-supervision", label: "任务监控" },
  { id: "conversation", label: "会话阅读" },
];

const DEFAULT_HIDDEN: SidecarTabId[] = ["profile-2", "profile-3"];
const TAB_IDS = SIDECAR_TABS.map((tab) => tab.id);

export function createDefaultSidecarLayout(): SidecarTabLayout {
  return { version: 1, order: [...TAB_IDS], hidden: [...DEFAULT_HIDDEN] };
}

function readTabIds(value: unknown): SidecarTabId[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((id): id is SidecarTabId => TAB_IDS.includes(id)))]
    : [];
}

export function normalizeSidecarLayout(value: unknown): SidecarTabLayout {
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 ||
      !("order" in value) || !Array.isArray(value.order) ||
      !("hidden" in value) || !Array.isArray(value.hidden)) {
    return createDefaultSidecarLayout();
  }
  const savedOrder = readTabIds(value.order);
  const missing = TAB_IDS.filter((id) => !savedOrder.includes(id));
  const order = [...savedOrder, ...missing];
  let hidden = readTabIds(value.hidden);
  hidden = [...new Set([...hidden, ...missing.filter((id) => DEFAULT_HIDDEN.includes(id))])];
  if (order.every((id) => hidden.includes(id))) hidden = hidden.filter((id) => id !== "preview");
  return { version: 1, order, hidden };
}

export function getVisibleSidecarTabs(layout: SidecarTabLayout, available: readonly SidecarTabId[]) {
  return layout.order.filter((id) => available.includes(id) && !layout.hidden.includes(id));
}

export function getSidecarFallback(layout: SidecarTabLayout, active: SidecarTabId, visible: readonly SidecarTabId[]): SidecarTabId {
  const index = layout.order.indexOf(active);
  return layout.order.slice(index + 1).find((id) => visible.includes(id)) ??
    layout.order.slice(0, index).reverse().find((id) => visible.includes(id)) ??
    visible[0] ?? "preview";
}

export function reorderVisibleSidecarTabs(layout: SidecarTabLayout, visible: readonly SidecarTabId[], from: number, to: number): SidecarTabLayout {
  if (from === to || from < 0 || to < 0 || from >= visible.length || to >= visible.length) return layout;
  const reordered = [...visible];
  const [item] = reordered.splice(from, 1);
  if (!item) return layout;
  reordered.splice(to, 0, item);
  let index = 0;
  return { ...layout, order: layout.order.map((id) => visible.includes(id) ? reordered[index++]! : id) };
}

export function getActiveSidecarTab(tool: TerminalSidecarTool, profile: TerminalBrowserProfileId): SidecarTabId {
  return tool === "browser" ? profile : tool;
}
