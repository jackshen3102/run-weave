import { createHash } from "node:crypto";
import type {
  TerminalAgentModelOption,
  TerminalAgentSettings,
  TerminalAgentSettingsProvider,
  TerminalAgentSettingsResponse,
  UpdateTerminalAgentSettingsRequest,
} from "@runweave/shared/terminal/agent-settings";
import type { TerminalSessionManager, TerminalSessionRecord } from "../manager/manager";
import type { TmuxService } from "../tmux/service";
import type { TerminalRuntimeRegistry } from "./registry";
import { beginTerminalReturn, TerminalInputBusyError } from "./input-admission";
import { probeAgyCatalog } from "../../agent-model-catalog/agy";
import { probeCodexCatalog } from "../../agent-model-catalog/codex";
import type { AgentModelCatalogService } from "../../agent-model-catalog/service";
import { probeTraexCatalog } from "../../agent-model-catalog/traex";
import { fail, resolveTerminalAgentTarget, type TerminalAgentTarget as Target } from "./terminal-agent-target";
import { agyModelReplies, readCurrentModel, readDefaultModel, readScreenModel, type ModelSelection } from "./terminal-agent-model-readback";

export { TerminalAgentSettingsError } from "./terminal-agent-target";

const catalogCache = new Map<TerminalAgentSettingsProvider, {
  expires: number;
  models: TerminalAgentModelOption[];
}>();
const CATALOG_TTL_MS = 30_000;
const MENU_TIMEOUT_MS = 4_000;

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

function settingsFor(
  target: Target, selected: ModelSelection | null, modelSource?: "default",
): TerminalAgentSettings {
  const model = selected?.model ?? null;
  const reasoningEffort = selected?.reasoningEffort ?? null;
  const revision = createHash("sha256")
    .update(JSON.stringify([target.session.id, target.panelId, target.provider, target.instance,
      target.threadId, model, reasoningEffort]))
    .digest("hex");
  return {
    terminalSessionId: target.session.id,
    panelId: target.panelId,
    threadId: target.threadId,
    provider: target.provider,
    model,
    reasoningEffort,
    ...(modelSource ? { modelSource } : {}),
    revision,
  };
}

async function readSettings(target: Target, models: TerminalAgentModelOption[]): Promise<TerminalAgentSettings> {
  const current = await readCurrentModel(target, models);
  if (current) return settingsFor(target, current);
  const fallback = await readDefaultModel(target, models);
  return settingsFor(target, fallback, fallback ? "default" : undefined);
}

export async function getTerminalAgentSettings(
  manager: TerminalSessionManager,
  tmux: TmuxService,
  session: TerminalSessionRecord,
  panelId?: string,
  catalogService?: AgentModelCatalogService,
  runtimeRegistry?: TerminalRuntimeRegistry,
): Promise<TerminalAgentSettingsResponse> {
  const target = await resolveTerminalAgentTarget(manager, tmux, session, panelId, runtimeRegistry);
  const models = await modelsFor(target.provider, catalogService);
  const settings = await readSettings(target, models);
  await target.validate();
  return { settings, models };
}

async function capture(target: Target): Promise<string> {
  // Menus redraw in place. Restrict matching to the visible screen so a prior
  // heading in scrollback cannot satisfy the next menu transition.
  return target.terminal.capture();
}

async function waitForMenu(target: Target, heading: string): Promise<string> {
  const deadline = Date.now() + MENU_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const text = await capture(target);
    if (text.includes(heading)) return text.slice(text.lastIndexOf(heading));
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  fail(409, "settings_unconfirmed", "Agent 模型菜单未按预期打开");
}

async function press(target: Target, key: string): Promise<void> {
  await target.terminal.send([{ type: "key", key }]);
}

async function typeText(target: Target, value: string): Promise<void> {
  await target.terminal.send([{ type: "literal", value, delayAfterMs: 250 }]);
}

function agyComposer(screen: string): string | undefined {
  const frame = screen.split(/^─+[ \t]*$/m).at(-2)?.trim();
  return frame?.startsWith(">") ? frame.slice(1).trim() : undefined;
}

function isAgyComposerEmpty(screen: string): boolean {
  const draft = agyComposer(screen)?.replace(/\s+/g, " ");
  if (draft === "") return true;
  if (!draft) return false;
  // AGY shortens these empty-input hints when the phone narrows the pane.
  const truncated = /^(\S.* mode: .+?)(?:\.{3}|…)$/u.exec(draft)?.[1];
  return [
    "Accept-edits mode: file edits auto-approved (shift+tab to cycle)",
    "Plan mode: research & plan only (shift+tab to cycle)",
  ].some(hint => draft === hint || (truncated !== undefined && hint.startsWith(truncated)));
}

async function selectAgyModel(target: Target, model: TerminalAgentModelOption): Promise<void> {
  const initial = await capture(target);
  if (!/^\? for shortcuts(?:\s|$)/m.test(initial) || !isAgyComposerEmpty(initial)) {
    fail(409, "terminal_busy", "请先清空 AGY 输入框并等待终端空闲");
  }
  if (!/^[a-z0-9][a-z0-9._-]+$/i.test(model.id)) {
    fail(409, "model_unavailable", "所选 AGY 模型不可用");
  }
  // An iOS scroll can leave this pane in tmux history mode.
  await target.terminal.cancelCopyMode?.();
  await typeText(target, `/model ${model.id}`);
  const composer = agyComposer(await capture(target));
  const typedModel = composer?.match(/^\/model\s+([\s\S]+)$/)?.[1];
  // AGY wraps the visible command in narrow panes, even with capture-pane -J.
  if (typedModel?.replace(/[ \t]*\n[ \t]*/g, "") !== model.id) {
    fail(409, "settings_unconfirmed", "AGY 未识别模型切换命令");
  }
  await press(target, "Enter");
  const deadline = Date.now() + MENU_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const screen = await capture(target);
    if (isAgyComposerEmpty(screen) && agyModelReplies(screen).at(-1) === model.label) return;
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
  target: Target,
  menu: string,
  predicate: (label: string) => boolean,
  commitKey = "Enter",
): Promise<void> {
  const rows = menuRows(menu);
  const desired = rows.find((row) => predicate(row.label));
  if (!desired) fail(409, "model_unavailable", "Agent 菜单中未找到所选选项，请刷新设置后重试");
  if (commitKey === "Enter" && desired.number <= 9) {
    await press(target, String(desired.number));
    return;
  }
  const current = rows.findIndex((row) => row.selected);
  const targetIndex = rows.indexOf(desired);
  if (current < 0 || targetIndex < 0 || Math.abs(targetIndex - current) > 15) {
    fail(409, "settings_unconfirmed", "无法安全定位 Agent 菜单选项");
  }
  for (let index = current; index !== targetIndex; index += targetIndex > current ? 1 : -1) {
    await press(target, targetIndex > current ? "Down" : "Up");
  }
  await press(target, commitKey);
}

function effortLabel(effort: string): string {
  return effort === "xhigh" ? "extra high" : effort;
}

async function chooseEffort(
  target: Target,
  effort: string,
): Promise<void> {
  let menu = await waitForMenu(target, "Select Reasoning Level");
  const desired = effortLabel(effort);
  if (!menuRows(menu).some((row) => row.label.toLowerCase().startsWith(desired))) {
    await selectRow(target, menu, (label) => label.toLowerCase().startsWith("more reasoning"));
    menu = await waitForMenu(target, "Advanced Reasoning");
  }
  const commitKey = target.provider === "codex" && /\bs session\b/.test(menu) ? "s" : "Enter";
  await selectRow(target, menu, (label) => label.toLowerCase().startsWith(desired), commitKey);
}

async function selectCodexModel(target: Target, model: TerminalAgentModelOption, effort: string): Promise<void> {
  await target.terminal.cancelCopyMode?.();
  let submitted = false;
  try {
    await typeText(target, "/model");
    if (!/^[›❯] \/model[ \t]*$/m.test(await capture(target))) {
      fail(409, "terminal_busy", "请先清空 Codex 输入框并等待终端空闲");
    }
    await press(target, "Enter");
    const menu = await waitForMenu(target, "Select Model and Effort");
    // Codex renders display names, which can differ from catalog IDs.
    const names = [model.id, model.label].map(name => name.toLowerCase());
    await selectRow(target, menu, (label) => names.some(name => {
      const text = label.toLowerCase();
      return text === name || text.startsWith(name + " ");
    }));
    await chooseEffort(target, effort);
    submitted = true;
  } finally {
    if (!submitted) await press(target, "Escape").catch(() => undefined);
  }
}

async function selectTraexModel(target: Target, model: TerminalAgentModelOption, effort: string): Promise<void> {
  if (!/^[a-z0-9][a-z0-9._-]+$/i.test(model.id) || !/^[a-z]+$/i.test(effort)) {
    fail(409, "model_unavailable", "所选 TraeX 模型或推理强度不可用");
  }
  const initial = await capture(target);
  if (!/\? for shortcuts|← for agents/.test(initial)) {
    fail(409, "terminal_busy", "请等待 TraeX 启动完成后切换模型");
  }
  const contextWindow = /\(MAX\)/.test(initial) ? "max" : "standard";
  const command = `/model ${model.id} --reasoning=${effort} --context-window=${contextWindow}`;
  await target.terminal.cancelCopyMode?.();
  await typeText(target, command);
  const frame = (await capture(target)).split(/^─+[ \t]*$/m).at(-2)?.trim();
  if (!frame?.startsWith("❯") || frame.slice(1).replace(/\s/g, "") !== command.replace(/\s/g, "")) {
    fail(409, "terminal_busy", "请先清空 TraeX 输入框并等待终端空闲");
  }
  await press(target, "Enter");
}

export async function updateTerminalAgentSettings(
  manager: TerminalSessionManager,
  tmux: TmuxService,
  session: TerminalSessionRecord,
  request: UpdateTerminalAgentSettingsRequest,
  catalogService?: AgentModelCatalogService,
  runtimeRegistry?: TerminalRuntimeRegistry,
): Promise<TerminalAgentSettingsResponse> {
  let release: () => void;
  try { release = beginTerminalReturn(session); }
  catch (error) {
    if (error instanceof TerminalInputBusyError) fail(409, "terminal_busy", "终端正在处理输入");
    throw error;
  }
  try {
    const target = await resolveTerminalAgentTarget(manager, tmux, session, request.panelId ?? undefined, runtimeRegistry);
    if (target.threadId !== request.threadId) fail(409, "settings_changed", "Agent 会话已切换，请刷新设置");
    let models = await modelsFor(target.provider, catalogService, { requireFresh: true });
    let model = models.find((option) => option.id === request.model);
    if (!model && catalogService) {
      models = await modelsFor(target.provider, catalogService, { requireFresh: true, forceProbe: true });
      model = models.find((option) => option.id === request.model);
    }
    const current = await readSettings(target, models);
    if (current.revision !== request.expectedRevision) fail(409, "settings_changed", "模型设置已变化，请刷新后重试");
    if (!model) fail(409, "model_unavailable", "所选模型已不可用");
    if (!model.reasoningEfforts.includes(request.reasoningEffort)) {
      fail(400, "reasoning_unsupported", "该模型不支持所选推理强度");
    }
    await target.validate();
    if (target.provider !== "agy" && !current.modelSource &&
      current.model === model.id && current.reasoningEffort === request.reasoningEffort) {
      return { settings: current, models };
    }
    if (target.isRunning()) fail(409, "terminal_busy", "请等待终端空闲后切换模型");
    if (target.provider === "agy") {
      await selectAgyModel(target, model);
      await target.validate();
      return { settings: settingsFor(target, { model: model.id, reasoningEffort: model.defaultReasoningEffort }), models };
    }
    if (target.provider === "traex") await selectTraexModel(target, model, request.reasoningEffort);
    else await selectCodexModel(target, model, request.reasoningEffort);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const next = readScreenModel(target.provider, await capture(target), models);
      if (next?.model === model.id && next.reasoningEffort === request.reasoningEffort) {
        await target.validate();
        return { settings: settingsFor(target, next), models };
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    fail(504, "settings_unconfirmed", "Agent 尚未确认模型设置，请刷新后核对");
  } finally {
    release();
  }
}
