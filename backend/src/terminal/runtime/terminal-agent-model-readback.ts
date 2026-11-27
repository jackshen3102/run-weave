import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveAgyConfiguration } from "@runweave/config-node/agy";
import type { TerminalAgentModelOption, TerminalAgentSettingsProvider } from "@runweave/shared/terminal/agent-settings";
import { codexAppServerClient, traexAppServerClient } from "../../voice/codex-app-server-client";
import type { TerminalAgentTarget } from "./terminal-agent-target";

export type ModelSelection = { model: string; reasoningEffort: string | null };
type Options = TerminalAgentModelOption[];

function selection(models: Options, raw: unknown, effort?: unknown): ModelSelection | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const name = raw.trim().toLowerCase().replace(/__max$/, "");
  const model = models.find(option => [option.id, option.label].some(value => value.toLowerCase() === name));
  if (!model) return null;
  return { model: model.id, reasoningEffort: typeof effort === "string" && model.reasoningEfforts.includes(effort)
    ? effort : model.reasoningEfforts.length === 1 ? model.reasoningEfforts[0]! : null };
}

function withDefaultEffort(value: ModelSelection, models: Options): ModelSelection {
  return { ...value, reasoningEffort: value.reasoningEffort ?? models.find(model => model.id === value.model)?.defaultReasoningEffort ?? null };
}

export function agyModelReplies(screen: string): string[] {
  const startup = Array.from(screen.matchAll(/^.*\bAntigravity CLI \d/gm)).at(-1)?.index ?? 0;
  return screen.slice(startup).split(/^> \/model[ \t]*$/m).slice(1).map(reply =>
    /^\n +⎿ +Model (?:already )?set to\b([^\n]*(?:\n {5}\S[^\n]*)*)/u.exec(reply)?.[1]
      ?.trim().replace(/\s+/g, " ") ?? "",
  );
}

function readAgyScreenModel(screen: string, models: Options): ModelSelection | null {
  const footer = /^\? for shortcuts[ \t]+(?:(?:accept-edits|plan) · )?(.+) · (low|medium|high|xhigh|max) *$/m.exec(screen);
  if (footer) {
    const visible = selection(models, `${footer[1]} (${footer[2]})`);
    if (visible) return visible;
  }
  const reply = agyModelReplies(screen).filter(Boolean).at(-1);
  if (reply) return selection(models, reply);
  const banner = Array.from(screen.matchAll(/^.*\bAntigravity CLI \d[^\n]*\n([^\n]*\n){0,2}([^\n]+)$/gm)).at(-1);
  if (!banner) return null;
  const shown = models.find(model => banner[0].split("\n").slice(1).some(line => line.trimEnd().endsWith(model.label)));
  return shown ? selection(models, shown.id) : null;
}

export function readScreenModel(provider: TerminalAgentSettingsProvider, screen: string, models: Options): ModelSelection | null {
  if (provider === "agy") return readAgyScreenModel(screen, models);
  const effort = "(low|medium|high|xhigh|max|ultra)";
  const footer = new RegExp("^[ \\t]+(.+?) " + effort + "[ \\t]+·", "m");
  const reply = new RegExp("^[ \\t]*[•◆] Model changed to (.+?) " + effort + "(?: for this session only)?[ \\t]*$", "gm");
  const rows = screen.trimEnd().split("\n");
  const current = footer.exec(rows.slice(-4).join("\n"));
  if (current) {
    const visible = selection(models, current[1], current[2]);
    if (visible) return visible;
  }
  const confirmed = Array.from(screen.matchAll(reply)).at(-1);
  return confirmed ? selection(models, confirmed[1], confirmed[2]) : null;
}

async function readAgyConversation(threadId: string, models: Options): Promise<ModelSelection | null> {
  const { brainDirectory } = resolveAgyConfiguration();
  const directory = path.join(brainDirectory, threadId);
  try {
    const transcript = await readFile(path.join(directory, ".system_generated", "logs", "transcript.jsonl"), "utf8");
    for (const line of transcript.trim().split(/\r?\n/).reverse()) {
      try {
        const row = JSON.parse(line) as { source?: string; type?: string; model?: string };
        if (row.source === "MODEL" && row.type === "PLANNER_RESPONSE" && row.model) {
          return selection(models, row.model);
        }
      } catch { /* Ignore incomplete transcript rows. */ }
    }
  } catch { /* A recent conversation may only have metadata. */ }
  try {
    const meta = JSON.parse(await readFile(path.join(directory, ".runweave-agy-meta.json"), "utf8")) as { modelName?: string };
    return selection(models, meta.modelName);
  } catch { return null; }
}

function appServer(provider: "codex" | "traex") {
  return provider === "codex" ? codexAppServerClient : traexAppServerClient;
}

export async function readCurrentModel(target: TerminalAgentTarget, models: Options): Promise<ModelSelection | null> {
  const { provider, threadId } = target;
  const screen = await target.terminal.capture().catch(() => "");
  const live = readScreenModel(provider, screen, models);
  if (live || !threadId) return live;
  try {
    if (provider === "agy") return await readAgyConversation(threadId, models);
    const client = appServer(provider);
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const value = await client.sendRequest("thread/list", { limit: 100, ...(cursor ? { cursor } : {}) }) as {
        data?: { id: string; model?: string; reasoningEffort?: string }[]; nextCursor?: string | null;
      };
      const found = value?.data?.find(thread => thread?.id === threadId);
      if (found) return selection(models, found.model, found.reasoningEffort);
      cursor = value?.nextCursor ?? null;
      if (!cursor) break;
    }
  } catch { /* The catalog is available even when conversation metadata is not. */ }
  return null;
}

export async function readDefaultModel(target: TerminalAgentTarget, models: Options): Promise<ModelSelection | null> {
  try {
    if (target.provider === "agy") {
      const { configDirectory } = resolveAgyConfiguration();
      const config = JSON.parse(await readFile(path.join(configDirectory, "settings.json"), "utf8")) as { model?: string; effort?: string };
      const configured = selection(models, config.model, config.effort);
      return configured ? withDefaultEffort(configured, models) : null;
    }
    const client = appServer(target.provider);
    const configured = await client.sendRequest("config/read", { cwd: target.cwd, includeLayers: false }).catch(() => null) as {
      config?: { model?: string; model_reasoning_effort?: string };
    } | null;
    const picked = selection(models, configured?.config?.model, configured?.config?.model_reasoning_effort);
    if (picked) return withDefaultEffort(picked, models);
    const catalog = await client.sendRequest("model/list", { limit: 100 }) as {
      data?: { id: string; model?: string; isDefault?: boolean }[];
    };
    const nativeDefault = catalog?.data?.find(option => option.isDefault);
    const fallback = selection(models, nativeDefault?.id) ?? selection(models, nativeDefault?.model);
    return fallback ? withDefaultEffort(fallback, models) : null;
  } catch { return null; }
}
