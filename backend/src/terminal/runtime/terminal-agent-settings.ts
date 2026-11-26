import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveAgyConfiguration } from "@runweave/config-node/agy";
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
import { probeAgyCatalog } from "../../agent-model-catalog/agy";
import { probeCodexCatalog } from "../../agent-model-catalog/codex";
import type { AgentModelCatalogService } from "../../agent-model-catalog/service";
import { probeTraexCatalog } from "../../agent-model-catalog/traex";

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
  if (value === "agy") return "agy";
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
    fail(409, "agent_settings_unavailable", "当前面板没有可设置的 Codex、TraeX 或 AGY 会话");
  }
  return { session, pane: paneTarget, panelId: panel.id, provider, threadId };
}

async function modelsFor(
  provider: TerminalAgentSettingsProvider,
  catalogService?: AgentModelCatalogService,
  options?: { requireFresh?: boolean; forceProbe?: boolean },
): Promise<TerminalAgentModelOption[]> {
  if (catalogService) {
    const catalog = await catalogService.getProviderCatalogCachedFirst(provider, options);
    if (
      catalog.availability !== "available" ||
      !catalog.models.length ||
      (options?.requireFresh && catalog.errorCode !== null)
    ) {
      fail(503, "agent_settings_unavailable", "当前账号的模型目录暂不可用");
    }
    return catalog.models.map((model) => terminalModelOption(provider, model));
  }
  const cached = !options?.forceProbe ? catalogCache.get(provider) : undefined;
  if (cached && cached.expires > Date.now()) return cached.models;
  try {
    const catalog = provider === "codex"
      ? await probeCodexCatalog(process.env)
      : provider === "agy"
        ? await probeAgyCatalog(process.env)
        : await probeTraexCatalog(process.env);
    const models = catalog.models.map((model) => terminalModelOption(provider, model));
    if (!models.length) throw new Error("empty catalog");
    catalogCache.set(provider, { expires: Date.now() + CATALOG_TTL_MS, models });
    return models;
  } catch {
    // A stale catalog is unsafe for a write. Read-only UI may retry on reopen.
    fail(503, "agent_settings_unavailable", "当前账号的模型目录暂不可用");
  }
}

function terminalModelOption(
  provider: TerminalAgentSettingsProvider,
  { id, label, description, defaultReasoningEffort, reasoningEfforts }: TerminalAgentModelOption,
): TerminalAgentModelOption {
  if (provider === "agy") {
    // The interactive /model command accepts a variant ID, including its effort.
    const effort = /-(low|medium|high|xhigh|max)$/i.exec(id)?.[1]?.toLowerCase() ?? "default";
    return { id, label, description, defaultReasoningEffort: effort, reasoningEfforts: [effort] };
  }
  return { id, label, description, defaultReasoningEffort, reasoningEfforts };
}

function normalizedModel(raw: string, models: TerminalAgentModelOption[]): string {
  const name = raw.toLowerCase().replace(/__max$/, "");
  return models.find((model) => model.id.toLowerCase() === name)?.id ?? raw;
}

async function readAgyThread(threadId: string): Promise<ThreadEntry> {
  const { brainDirectory, configDirectory } = resolveAgyConfiguration(process.env);
  let model: string | null = null;
  let reasoningEffort: string | null = null;
  try {
    const transcript = await readFile(
      path.join(brainDirectory, threadId, ".system_generated", "logs", "transcript.jsonl"),
      "utf8",
    );
    const lines = transcript.trim().split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const row = JSON.parse(lines[i]!) as { source?: string; type?: string; model?: string };
        if (row.source === "MODEL" && row.type === "PLANNER_RESPONSE" && typeof row.model === "string" && row.model.trim()) {
          model = row.model.trim();
          break;
        }
      } catch {
        // Ignore incomplete trailing lines.
      }
    }
  } catch {
    // Fallback to metadata or settings.json.
  }
  if (!model) {
    try {
      const meta = JSON.parse(await readFile(path.join(brainDirectory, threadId, ".runweave-agy-meta.json"), "utf8")) as { modelName?: string };
      if (typeof meta.modelName === "string" && meta.modelName.trim()) model = meta.modelName.trim();
    } catch {
      // Ignore missing meta.
    }
  }
  try {
    const settings = JSON.parse(await readFile(path.join(configDirectory, "settings.json"), "utf8")) as { model?: string; effort?: string };
    if (!model && typeof settings.model === "string" && settings.model.trim()) model = settings.model.trim();
    if (typeof settings.effort === "string" && settings.effort.trim()) reasoningEffort = settings.effort.trim();
  } catch {
    // Ignore missing settings.json.
  }
  return { id: threadId, model, reasoningEffort };
}

async function readThread(
  target: Target,
  tmux: TmuxService,
  models: TerminalAgentModelOption[] | Promise<TerminalAgentModelOption[]>,
): Promise<ThreadEntry> {
  const { provider, threadId } = target;
  if (provider === "agy") {
    const [screen, options] = await Promise.all([capture(tmux, target.pane).catch(() => ""), models]);
    const selected = readAgyScreenModel(screen, options);
    return selected
      ? { id: threadId, model: selected.id, reasoningEffort: selected.defaultReasoningEffort }
      : readAgyThread(threadId);
  }
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
  if (!thread.model) fail(503, "agent_settings_unavailable", "当前 Agent 会话设置尚未写入，稍后重试");
  const agy = target.provider === "agy" ? findAgyModel(models, thread.model) : undefined;
  const model = agy?.id ?? normalizedModel(thread.model, models);
  const reasoningEffort = agy?.defaultReasoningEffort ?? thread.reasoningEffort;
  const revision = createHash("sha256")
    .update(JSON.stringify([target.provider, target.threadId, agy?.id ?? thread.model, reasoningEffort]))
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
  catalogService?: AgentModelCatalogService,
): Promise<TerminalAgentSettingsResponse> {
  const target = await resolveTarget(manager, tmux, session, panelId);
  const pendingModels = modelsFor(target.provider, catalogService);
  const [models, thread] = await Promise.all([
    pendingModels,
    readThread(target, tmux, pendingModels),
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

function findAgyModel(models: TerminalAgentModelOption[], value: string): TerminalAgentModelOption | undefined {
  const name = value.toLowerCase();
  return models.find((model) => model.id.toLowerCase() === name || model.label.toLowerCase() === name);
}

function agyModelReplies(screen: string): string[] {
  const startup = Array.from(screen.matchAll(/^ *Antigravity CLI \d/gm)).at(-1)?.index ?? 0;
  const recent = screen.slice(startup);
  return recent.split(/^> \/model[ \t]*$/m).slice(1).map((reply) =>
    /^\n +⎿ +Model (?:already )?set to\b([^\n]*(?:\n {5}\S[^\n]*)*)/u.exec(reply)?.[1]
      ?.trim().replace(/\s+/g, " ") ?? "",
  );
}

function readAgyScreenModel(screen: string, models: TerminalAgentModelOption[]): TerminalAgentModelOption | undefined {
  const footer = /^\? for shortcuts[ \t]+(?:(?:accept-edits|plan) · )?(.+) · (low|medium|high|xhigh|max) *$/m.exec(screen);
  const visible = footer && findAgyModel(models, `${footer[1]} (${footer[2]})`);
  return visible || findAgyModel(models, agyModelReplies(screen).filter(Boolean).at(-1) ?? "");
}

function agyComposer(screen: string): string | undefined {
  const frame = screen.split(/^─+[ \t]*$/m).at(-2)?.trim();
  return frame?.startsWith(">") ? frame.slice(1).trim() : undefined;
}

async function selectAgyModel(tmux: TmuxService, target: Target, model: TerminalAgentModelOption): Promise<void> {
  const initial = await capture(tmux, target.pane);
  const draft = agyComposer(initial)?.replace(/\s+/g, " ");
  if (!/^\? for shortcuts(?:\s|$)/m.test(initial) ||
    (draft !== "" &&
      draft !== "Accept-edits mode: file edits auto-approved (shift+tab to cycle)" &&
      draft !== "Plan mode: research & plan only (shift+tab to cycle)")) {
    fail(409, "terminal_busy", "请先清空 AGY 输入框并等待终端空闲");
  }
  if (!/^[a-z0-9][a-z0-9._-]+$/i.test(model.id)) {
    fail(409, "model_unavailable", "所选 AGY 模型不可用");
  }
  // An iOS scroll can leave this pane in tmux history mode.
  await tmux.cancelCopyMode(target.pane, { strict: true });
  await typeText(tmux, target.pane, `/model ${model.id}`);
  const composer = agyComposer(await capture(tmux, target.pane));
  const typedModel = composer?.match(/^\/model\s+([\s\S]+)$/)?.[1];
  // AGY wraps the visible command in narrow panes, even with capture-pane -J.
  if (typedModel?.replace(/[ \t]*\n[ \t]*/g, "") !== model.id) {
    fail(409, "settings_unconfirmed", "AGY 未识别模型切换命令");
  }
  await press(tmux, target.pane, "Enter");
  const deadline = Date.now() + MENU_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const screen = await capture(tmux, target.pane);
    if (agyComposer(screen) === "" && agyModelReplies(screen).at(-1) === model.label) return;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  fail(504, "settings_unconfirmed", "AGY 尚未确认模型设置，请刷新后核对");
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
  if (!desired) fail(409, "model_unavailable", "Agent 菜单中未找到所选选项，请刷新设置后重试");
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
  // Rendered placeholders and projected Agent state do not expose the actual
  // composer buffer. Attempt the native menu and confirm its result instead.
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
      // Codex renders display names, which can differ from catalog IDs.
      const names = [model.id, model.label].map((name) => name.toLowerCase());
      await selectRow(tmux, target.pane, menu,
        (label) => names.some((name) => {
          const text = label.toLowerCase();
          return text === name || text.startsWith(name + " ");
        }), false);
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
  catalogService?: AgentModelCatalogService,
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
    const pendingModels = modelsFor(target.provider, catalogService, { requireFresh: true });
    const [initialModels, thread] = await Promise.all([
      pendingModels,
      readThread(target, tmux, pendingModels),
    ]);
    let models = initialModels;
    let model = models.find((option) => option.id === request.model);
    if (!model && catalogService) {
      models = await modelsFor(target.provider, catalogService, { requireFresh: true, forceProbe: true });
      model = models.find((option) => option.id === request.model);
    }
    const current = settingsFor(target, thread, models);
    if (current.revision !== request.expectedRevision) fail(409, "settings_changed", "模型设置已变化，请刷新后重试");
    if (!model) fail(409, "model_unavailable", "所选模型已不可用");
    if (!model.reasoningEfforts.includes(request.reasoningEffort)) {
      fail(400, "reasoning_unsupported", "该模型不支持所选推理强度");
    }
    if (target.provider !== "agy" &&
      current.model === model.id && current.reasoningEffort === request.reasoningEffort) {
      return { settings: current, models };
    }
    const latest = await resolveTarget(manager, tmux, session, target.panelId);
    if (latest.threadId !== target.threadId || latest.provider !== target.provider) {
      fail(409, "settings_changed", "当前 Agent 会话已切换，请刷新设置");
    }
    const latestThread = await readThread(latest, tmux, models);
    if (settingsFor(target, latestThread, models).revision !== current.revision) {
      fail(409, "settings_changed", "模型设置已变化，请刷新后重试");
    }
    if (target.provider === "agy") {
      await selectAgyModel(tmux, target, model);
      const confirmed = await resolveTarget(manager, tmux, session, target.panelId);
      if (confirmed.threadId !== target.threadId || confirmed.provider !== target.provider) {
        fail(409, "settings_changed", "当前 Agent 会话已切换，请刷新设置");
      }
      const settings = settingsFor(confirmed, {
        id: confirmed.threadId, model: model.id, reasoningEffort: model.defaultReasoningEffort,
      }, models);
      return { settings, models };
    }
    await chooseModelAndEffort(tmux, target, model, request.reasoningEffort);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const next = await readThread(target, tmux, models);
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
