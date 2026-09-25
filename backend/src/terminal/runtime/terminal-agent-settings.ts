import { createHash } from "node:crypto";
import type {
  TerminalAgentModelOption,
  TerminalAgentSettings,
  TerminalAgentSettingsProvider,
  TerminalAgentSettingsResponse,
  UpdateTerminalAgentSettingsRequest,
} from "@runweave/shared/terminal/agent-settings";
import type { TerminalSessionManager, TerminalSessionRecord } from "../manager/manager";
import type { TmuxPaneTarget, TmuxService } from "../tmux/service";
import { resolvePanelTarget } from "../application/panel-targets";
import { beginTerminalReturn, TerminalInputBusyError } from "./input-admission";
import { codexAppServerClient, traexAppServerClient } from "../../voice/codex-app-server-client";
import { probeCodexCatalog } from "../../agent-team/model-catalog/codex";
import { probeTraexCatalog } from "../../agent-team/model-catalog/traex";

const catalogCache = new Map<TerminalAgentSettingsProvider, {
  expires: number;
  models: TerminalAgentModelOption[];
}>();
const CATALOG_TTL_MS = 30_000;
const MENU_TIMEOUT_MS = 4_000;

export class TerminalAgentSettingsError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

type Target = {
  session: TerminalSessionRecord;
  pane: TmuxPaneTarget;
  panelId: string;
  threadId: string;
  provider: TerminalAgentSettingsProvider;
};

type ThreadEntry = { id: string; model: string | null; reasoningEffort: string | null };

function fail(status: number, code: string, message: string): never {
  throw new TerminalAgentSettingsError(status, code, message);
}

function normalizeProvider(value: string | null | undefined): TerminalAgentSettingsProvider | null {
  if (value === "codex") return "codex";
  if (value === "trae" || value === "traex" || value === "traecli") return "traex";
  return null;
}

async function resolveTarget(
  manager: TerminalSessionManager,
  tmux: TmuxService,
  session: TerminalSessionRecord,
  panelId?: string,
): Promise<Target> {
  if (session.status !== "running" || session.runtimeKind !== "tmux") {
    fail(409, "agent_settings_unavailable", "当前终端不可设置模型");
  }
  const { panel, paneTarget } = await resolvePanelTarget(
    manager, session, { tmuxService: tmux }, panelId ? { panelId } : {}, "explicit-or-active",
  );
  const activeId = manager.getPanelWorkspace(session.id)?.activePanelId;
  if (panelId && activeId !== panelId) {
    fail(409, "settings_changed", "当前终端面板已切换，请刷新设置");
  }
  // Completed turns move the current thread into lastThread*. The TUI can
  // remain open and idle on that same thread, so keep it selectable there.
  const singlePanel = manager.listPanels(session.id).length === 1;
  const thread = panel.threadId
    ? { id: panel.threadId, provider: panel.threadProvider }
    : panel.lastThreadId && panel.lastThreadStatus === "idle"
      ? { id: panel.lastThreadId, provider: panel.lastThreadProvider }
      : singlePanel && session.threadId
        ? { id: session.threadId, provider: session.threadProvider }
        : singlePanel && session.lastThreadId && session.lastThreadStatus === "idle"
          ? { id: session.lastThreadId, provider: session.lastThreadProvider }
          : null;
  const provider = normalizeProvider(thread?.provider);
  const threadId = thread?.id.trim();
  if (!provider || !threadId || panel.status !== "running" ||
    normalizeProvider(panel.terminalState?.agent) !== provider) {
    fail(409, "agent_settings_unavailable", "当前面板没有可设置的 Codex 或 TraeX 会话");
  }
  return { session, pane: paneTarget, panelId: panel.id, provider, threadId };
}

async function modelsFor(provider: TerminalAgentSettingsProvider): Promise<TerminalAgentModelOption[]> {
  const cached = catalogCache.get(provider);
  if (cached && cached.expires > Date.now()) return cached.models;
  try {
    const catalog = provider === "codex"
      ? await probeCodexCatalog(process.env)
      : await probeTraexCatalog(process.env);
    const models = catalog.models.map((model) => ({
      id: model.id,
      label: model.label,
      description: model.description,
      defaultReasoningEffort: model.defaultReasoningEffort,
      reasoningEfforts: model.reasoningEfforts,
    }));
    if (!models.length) throw new Error("empty catalog");
    catalogCache.set(provider, { expires: Date.now() + CATALOG_TTL_MS, models });
    return models;
  } catch {
    // A stale catalog is unsafe for a write. Read-only UI may retry on reopen.
    fail(503, "agent_settings_unavailable", "当前账号的模型目录暂不可用");
  }
}

function normalizedModel(raw: string, models: TerminalAgentModelOption[]): string {
  const name = raw.toLowerCase().replace(/__max$/, "");
  return models.find((model) => model.id.toLowerCase() === name)?.id ?? raw;
}

async function readThread(provider: TerminalAgentSettingsProvider, threadId: string): Promise<ThreadEntry> {
  const client = provider === "codex" ? codexAppServerClient : traexAppServerClient;
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const value = await client.sendRequest("thread/list", {
      limit: 100,
      ...(cursor ? { cursor } : {}),
    }) as { data?: unknown; nextCursor?: unknown } | null;
    if (!Array.isArray(value?.data)) break;
    const found = value.data.find((entry): entry is ThreadEntry =>
      typeof entry === "object" && entry !== null && "id" in entry && entry.id === threadId,
    );
    if (found && typeof found.model === "string") return found;
    cursor = typeof value.nextCursor === "string" ? value.nextCursor : null;
    if (!cursor) break;
  }
  fail(503, "agent_settings_unavailable", "当前 Agent 会话设置尚未写入，稍后重试");
}

function settingsFor(target: Target, thread: ThreadEntry, models: TerminalAgentModelOption[]): TerminalAgentSettings {
  const model = normalizedModel(thread.model!, models);
  const reasoningEffort = thread.reasoningEffort;
  const revision = createHash("sha256")
    .update(JSON.stringify([target.provider, target.threadId, thread.model, reasoningEffort]))
    .digest("hex");
  return {
    terminalSessionId: target.session.id,
    panelId: target.panelId,
    threadId: target.threadId,
    provider: target.provider,
    model,
    reasoningEffort,
    revision,
  };
}

export async function getTerminalAgentSettings(
  manager: TerminalSessionManager,
  tmux: TmuxService,
  session: TerminalSessionRecord,
  panelId?: string,
): Promise<TerminalAgentSettingsResponse> {
  const target = await resolveTarget(manager, tmux, session, panelId);
  const [models, thread] = await Promise.all([
    modelsFor(target.provider),
    readThread(target.provider, target.threadId),
  ]);
  const latest = await resolveTarget(manager, tmux, session, target.panelId);
  if (latest.threadId !== target.threadId || latest.provider !== target.provider) {
    fail(409, "settings_changed", "当前 Agent 会话已切换，请刷新设置");
  }
  return { settings: settingsFor(target, thread, models), models };
}

async function capture(tmux: TmuxService, pane: TmuxPaneTarget): Promise<string> {
  // Menus redraw in place. Restrict matching to the visible screen so a prior
  // heading in scrollback cannot satisfy the next menu transition.
  return (await tmux.capturePane(pane, 0)).data;
}

async function waitForMenu(tmux: TmuxService, pane: TmuxPaneTarget, heading: string): Promise<string> {
  const deadline = Date.now() + MENU_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const text = await capture(tmux, pane);
    if (text.includes(heading)) return text.slice(text.lastIndexOf(heading));
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  fail(409, "settings_unconfirmed", "Agent 模型菜单未按预期打开");
}

async function waitForEitherMenu(tmux: TmuxService, pane: TmuxPaneTarget, headings: string[]): Promise<string> {
  const deadline = Date.now() + MENU_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const text = await capture(tmux, pane);
    const heading = headings.find((candidate) => text.includes(candidate));
    if (heading) return text.slice(text.lastIndexOf(heading));
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  fail(409, "settings_unconfirmed", "Agent 菜单未按预期切换");
}

async function press(tmux: TmuxService, pane: TmuxPaneTarget, key: string): Promise<void> {
  await tmux.sendKeySequence(pane, [{ type: "key", key }]);
}

async function typeText(tmux: TmuxService, pane: TmuxPaneTarget, value: string): Promise<void> {
  await tmux.sendKeySequence(pane, [{ type: "literal", value, delayAfterMs: 250 }]);
}

function menuRows(text: string): { number: number; label: string; selected: boolean }[] {
  return text.split("\n").flatMap((line) => {
    const match = line.match(/^\s*([›❯])?\s*(\d+)\.\s+(.+)$/);
    return match ? [{ number: Number(match[2]), label: match[3]!.trim(), selected: Boolean(match[1]) }] : [];
  });
}

async function selectRow(
  tmux: TmuxService,
  pane: TmuxPaneTarget,
  menu: string,
  predicate: (label: string) => boolean,
  searchable: boolean,
): Promise<void> {
  const rows = menuRows(menu);
  const desired = rows.find((row) => predicate(row.label));
  if (!desired) fail(409, "model_unavailable", "模型菜单与当前目录不一致，请稍后重试");
  if (!searchable && desired.number <= 9) {
    await press(tmux, pane, String(desired.number));
    return;
  }
  const current = rows.findIndex((row) => row.selected);
  const target = rows.indexOf(desired);
  if (current < 0 || target < 0 || Math.abs(target - current) > 15) {
    fail(409, "settings_unconfirmed", "无法安全定位 Agent 菜单选项");
  }
  for (let index = current; index !== target; index += target > current ? 1 : -1) {
    await press(tmux, pane, target > current ? "Down" : "Up");
  }
  await press(tmux, pane, "Enter");
}

function effortLabel(effort: string): string {
  return effort === "xhigh" ? "extra high" : effort;
}

async function chooseEffort(
  tmux: TmuxService,
  pane: TmuxPaneTarget,
  effort: string,
): Promise<void> {
  let menu = await waitForMenu(tmux, pane, "Select Reasoning Level");
  const desired = effortLabel(effort);
  if (!menuRows(menu).some((row) => row.label.toLowerCase().startsWith(desired))) {
    await selectRow(tmux, pane, menu, (label) => label.toLowerCase().startsWith("more reasoning"), false);
    menu = await waitForMenu(tmux, pane, "Advanced Reasoning");
  }
  await selectRow(tmux, pane, menu, (label) => label.toLowerCase().startsWith(desired), false);
}

async function chooseModelAndEffort(
  tmux: TmuxService,
  target: Target,
  model: TerminalAgentModelOption,
  effort: string,
): Promise<void> {
  const initial = await capture(tmux, target.pane);
  // The TraeX placeholder is rendered dim; user-entered text is not.
  // eslint-disable-next-line no-control-regex
  const traeIdlePlaceholder = /^(?:\x1b\[[0-9;]*m)*❯(?:\x1b\[[0-9;]*m)* \x1b\[2m[^\n]+/m;
  const idlePrompt = target.provider === "codex"
    ? /› Ask Codex to do anything/.test(initial.split("\n").slice(-12).join("\n"))
    : traeIdlePlaceholder.test(await tmux.capturePaneWithAnsi(target.pane))
      && !/Working…|esc to interrupt/.test(initial);
  if (!idlePrompt) fail(409, "terminal_busy", "Agent 正在执行或电脑端有未提交输入");
  const wasMax = /\(MAX\)/.test(initial);
  let submitted = false;
  try {
    await typeText(tmux, target.pane, "/model");
    await press(tmux, target.pane, "Enter");
    if (target.provider === "traex") {
      // TraeX first confirms the slash-command completion, then opens its menu.
      const prompt = await waitForEitherMenu(tmux, target.pane,
        ["Select Model and Effort", "/model  choose what model"]);
      if (!prompt.startsWith("Select Model and Effort")) await press(tmux, target.pane, "Enter");
    }
    let menu = await waitForMenu(tmux, target.pane, "Select Model and Effort");
    if (target.provider === "traex") {
    await typeText(tmux, target.pane, model.label);
    const deadline = Date.now() + MENU_TIMEOUT_MS;
    while (Date.now() < deadline) {
      menu = await waitForMenu(tmux, target.pane, "Select Model and Effort");
      if (menu.split("\n").some((line) => line.trim() === model.label)) break;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    if (!menu.split("\n").some((line) => line.trim() === model.label)) {
      fail(409, "settings_unconfirmed", "TraeX 模型搜索未完成");
    }
    // TraeX has a searchable model list. A name match must be visible before Enter.
    await selectRow(tmux, target.pane, menu,
      (label) => label.toLowerCase().startsWith(model.label.toLowerCase()), true);
    const next = await waitForEitherMenu(tmux, target.pane,
      ["Select Model and Mode", "Select Reasoning Level"]);
    if (next.startsWith("Select Model and Mode")) {
      const mode = next;
      if (wasMax && !menuRows(mode).some((row) => row.label.includes("/ Max"))) {
        fail(409, "model_unavailable", "目标模型不支持当前 Max 模式");
      }
      await selectRow(tmux, target.pane, mode,
        (label) => label.includes(wasMax ? "/ Max" : "/ Standard"), false);
    }
    } else {
      await selectRow(tmux, target.pane, menu,
        (label) => label.startsWith(model.id + " ") || label === model.id, false);
    }
    await chooseEffort(tmux, target.pane, effort);
    submitted = true;
  } finally {
    if (!submitted) await press(tmux, target.pane, "Escape").catch(() => undefined);
  }
}

export async function updateTerminalAgentSettings(
  manager: TerminalSessionManager,
  tmux: TmuxService,
  session: TerminalSessionRecord,
  request: UpdateTerminalAgentSettingsRequest,
): Promise<TerminalAgentSettingsResponse> {
  let release: () => void;
  try { release = beginTerminalReturn(session); }
  catch (error) {
    if (error instanceof TerminalInputBusyError) fail(409, "terminal_busy", "终端正在处理输入");
    throw error;
  }
  try {
    const target = await resolveTarget(manager, tmux, session, request.panelId ?? undefined);
    if (target.threadId !== request.threadId) fail(409, "settings_changed", "Agent 会话已切换，请刷新设置");
    const [models, thread] = await Promise.all([modelsFor(target.provider), readThread(target.provider, target.threadId)]);
    const current = settingsFor(target, thread, models);
    if (current.revision !== request.expectedRevision) fail(409, "settings_changed", "模型设置已变化，请刷新后重试");
    const model = models.find((option) => option.id === request.model);
    if (!model) fail(409, "model_unavailable", "所选模型已不可用");
    if (!model.reasoningEfforts.includes(request.reasoningEffort)) {
      fail(400, "reasoning_unsupported", "该模型不支持所选推理强度");
    }
    if (current.model === model.id && current.reasoningEffort === request.reasoningEffort) {
      return { settings: current, models };
    }
    const latest = await resolveTarget(manager, tmux, session, target.panelId);
    if (latest.threadId !== target.threadId || latest.provider !== target.provider) {
      fail(409, "settings_changed", "当前 Agent 会话已切换，请刷新设置");
    }
    const latestThread = await readThread(target.provider, target.threadId);
    if (settingsFor(target, latestThread, models).revision !== current.revision) {
      fail(409, "settings_changed", "模型设置已变化，请刷新后重试");
    }
    const state = manager.getPanel(target.panelId)?.terminalState?.state;
    if (state === "agent_running" || state === "agent_starting") {
      fail(409, "terminal_busy", "Agent 正在执行，完成后再切换模型");
    }
    await chooseModelAndEffort(tmux, target, model, request.reasoningEffort);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const next = await readThread(target.provider, target.threadId);
      const settings = settingsFor(target, next, models);
      if (settings.model === model.id && settings.reasoningEffort === request.reasoningEffort) {
        return { settings, models };
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new TerminalAgentSettingsError(504, "settings_unconfirmed", "Agent 尚未确认模型设置，请刷新后核对");
  } finally {
    release();
  }
}
