import { randomUUID } from "node:crypto";
import type { CreateTerminalQuickInputRequest, TerminalQuickInputItem, TerminalQuickInputListKind, TerminalQuickInputMode, TerminalQuickInputSource, UpdateTerminalQuickInputRequest } from "@runweave/shared/terminal/input";
import { logger } from "../logging";
import type {
  PersistedTerminalQuickInputRecord,
  TerminalQuickInputStore,
} from "./quick-input-store";

const QUICK_INPUT_MODES = new Set<string>([
  "line",
  "codex_slash_command",
  "prompt_paste",
]);
const MAX_QUICK_INPUT_BYTES = 64 * 1024;
const MAX_RECENT_ITEMS = 200;
const SENSITIVE_INPUT_PATTERNS = [
  /password\s*=/i,
  /token\s*=/i,
  /api_key\s*=/i,
  /secret\s*=/i,
  /authorization\s*:/i,
];

const quickInputLogger = logger.child({
  component: "terminal-quick-input",
});

export class TerminalQuickInputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalQuickInputValidationError";
  }
}

export interface ListTerminalQuickInputsParams {
  projectId?: string | null;
  q?: string | null;
  kind?: TerminalQuickInputListKind;
  limit?: number;
}

export interface RecordTerminalQuickInputParams {
  data: string;
  mode?: string;
  projectId?: string | null;
  terminalSessionId?: string | null;
  cwd?: string | null;
  source?: TerminalQuickInputSource;
  acceptedAt?: string;
}

interface NormalizedQuickInput {
  title: string;
  data: string;
  mode: TerminalQuickInputMode;
  projectId: string | null;
  terminalSessionId: string | null;
  cwd: string | null;
}

export class TerminalQuickInputService {
  private pendingMutation: Promise<void> = Promise.resolve();

  constructor(private readonly store: TerminalQuickInputStore) {}

  async list(
    params: ListTerminalQuickInputsParams,
  ): Promise<TerminalQuickInputItem[]> {
    await this.pendingMutation;
    const kind = params.kind ?? "all";
    const limit = clampLimit(params.limit);
    const projectId = normalizeNullableText(params.projectId);
    const query = params.q?.trim().toLowerCase() ?? "";
    const items = (await this.store.list())
      .filter((item) => item.hiddenAt == null)
      .filter((item) => {
        if (projectId === null) {
          return true;
        }
        return (
          (item.projectId ?? null) === null || item.projectId === projectId
        );
      })
      .filter((item) => {
        if (kind === "pinned") {
          return item.pinned;
        }
        if (kind === "recent") {
          return !item.pinned;
        }
        return true;
      })
      .filter((item) => {
        if (!query) {
          return true;
        }
        return (
          item.title.toLowerCase().includes(query) ||
          item.data.toLowerCase().includes(query)
        );
      });

    return sortItems(items, kind).slice(0, limit);
  }

  async createPinned(
    input: CreateTerminalQuickInputRequest,
  ): Promise<TerminalQuickInputItem> {
    const normalized = normalizePersistableInput(input);
    return this.enqueueMutation(async () => {
      const now = new Date().toISOString();
      const items = await this.store.list();
      const existing = findDuplicate(items, normalized);
      let result: TerminalQuickInputItem;
      if (existing) {
        result = {
          ...existing,
          title: normalized.title,
          terminalSessionId: normalized.terminalSessionId,
          cwd: normalized.cwd,
          pinned: true,
          hiddenAt: null,
          updatedAt: now,
        };
        replaceItem(items, result);
      } else {
        result = {
          id: randomUUID(),
          title: normalized.title,
          data: normalized.data,
          mode: normalized.mode,
          projectId: normalized.projectId,
          terminalSessionId: normalized.terminalSessionId,
          cwd: normalized.cwd,
          source: "web_terminal_quick_input",
          pinned: true,
          createdAt: now,
          updatedAt: now,
          hiddenAt: null,
          useCount: 0,
        };
        items.push(result);
      }
      await this.store.replaceAll(applyRetention(items));
      return result;
    });
  }

  async update(
    id: string,
    patch: UpdateTerminalQuickInputRequest,
  ): Promise<TerminalQuickInputItem | null> {
    return this.enqueueMutation(async () => {
      const items = await this.store.list();
      const item = items.find((candidate) => candidate.id === id);
      if (!item) {
        return null;
      }
      const next: TerminalQuickInputItem = {
        ...item,
        title: patch.title !== undefined ? patch.title.trim() : item.title,
        pinned: patch.pinned !== undefined ? patch.pinned : item.pinned,
        updatedAt: new Date().toISOString(),
      };
      if (!next.title) {
        next.title = buildTitle(next.data);
      }
      replaceItem(items, next);
      await this.store.replaceAll(applyRetention(items));
      return next;
    });
  }

  async delete(id: string): Promise<boolean> {
    return this.enqueueMutation(async () => {
      const items = await this.store.list();
      const item = items.find((candidate) => candidate.id === id);
      if (!item) {
        return false;
      }
      replaceItem(items, {
        ...item,
        pinned: false,
        hiddenAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await this.store.replaceAll(items);
      return true;
    });
  }

  async recordRecentInput(
    input: RecordTerminalQuickInputParams,
  ): Promise<TerminalQuickInputItem | null> {
    let normalized: NormalizedQuickInput;
    try {
      normalized = normalizePersistableInput({
        title: buildTitle(input.data),
        data: input.data,
        mode: input.mode as TerminalQuickInputMode,
        projectId: input.projectId,
        terminalSessionId: input.terminalSessionId,
        cwd: input.cwd,
      });
    } catch (error) {
      quickInputLogger.debug("terminal.quick-input.record.skipped", {
        message: "Terminal quick input record skipped",
        reason: error instanceof Error ? error.message : String(error),
        mode: input.mode,
        projectId: input.projectId ?? null,
        terminalSessionId: input.terminalSessionId ?? null,
        inputLength: input.data.length,
      });
      return null;
    }

    return this.enqueueMutation(async () => {
      const now = input.acceptedAt ?? new Date().toISOString();
      const items = await this.store.list();
      const existing = findDuplicate(items, normalized);
      let result: TerminalQuickInputItem;
      if (existing) {
        result = {
          ...existing,
          terminalSessionId: normalized.terminalSessionId,
          cwd: normalized.cwd,
          source: input.source ?? existing.source,
          hiddenAt: null,
          lastUsedAt: now,
          updatedAt: now,
          useCount: existing.useCount + 1,
        };
        replaceItem(items, result);
      } else {
        result = {
          id: randomUUID(),
          title: normalized.title,
          data: normalized.data,
          mode: normalized.mode,
          projectId: normalized.projectId,
          terminalSessionId: normalized.terminalSessionId,
          cwd: normalized.cwd,
          source: input.source ?? "api_terminal_input",
          pinned: false,
          createdAt: now,
          updatedAt: now,
          lastUsedAt: now,
          hiddenAt: null,
          useCount: 1,
        };
        items.push(result);
      }
      await this.store.replaceAll(applyRetention(items));
      return result;
    });
  }

  async markUsed(id: string): Promise<TerminalQuickInputItem | null> {
    return this.enqueueMutation(async () => {
      const items = await this.store.list();
      const item = items.find((candidate) => candidate.id === id);
      if (!item || item.hiddenAt != null) {
        return null;
      }
      const now = new Date().toISOString();
      const next: TerminalQuickInputItem = {
        ...item,
        lastUsedAt: now,
        updatedAt: now,
        useCount: item.useCount + 1,
      };
      replaceItem(items, next);
      await this.store.replaceAll(applyRetention(items));
      return next;
    });
  }

  private async enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pendingMutation.then(operation, operation);
    this.pendingMutation = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

function normalizePersistableInput(
  input: CreateTerminalQuickInputRequest,
): NormalizedQuickInput {
  if (!QUICK_INPUT_MODES.has(input.mode)) {
    throw new TerminalQuickInputValidationError("Unsupported input mode");
  }
  const trimmedData = input.data.trim();
  if (!trimmedData) {
    throw new TerminalQuickInputValidationError("Input data is required");
  }
  if (Buffer.byteLength(input.data, "utf8") > MAX_QUICK_INPUT_BYTES) {
    throw new TerminalQuickInputValidationError("Input data is too large");
  }
  if (SENSITIVE_INPUT_PATTERNS.some((pattern) => pattern.test(input.data))) {
    throw new TerminalQuickInputValidationError("Input data is sensitive");
  }
  return {
    title: input.title.trim() || buildTitle(input.data),
    data: input.data,
    mode: input.mode,
    projectId: normalizeNullableText(input.projectId),
    terminalSessionId: normalizeNullableText(input.terminalSessionId),
    cwd: normalizeNullableText(input.cwd),
  };
}

function normalizeNullableText(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

function buildTitle(data: string): string {
  const firstLine = data
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const title = firstLine ?? data.trim();
  return title.length > 80 ? `${title.slice(0, 77)}...` : title;
}

function findDuplicate(
  items: PersistedTerminalQuickInputRecord[],
  input: NormalizedQuickInput,
): PersistedTerminalQuickInputRecord | null {
  return (
    items.find(
      (item) =>
        item.data === input.data &&
        item.mode === input.mode &&
        (item.projectId ?? null) === input.projectId,
    ) ?? null
  );
}

function replaceItem(
  items: PersistedTerminalQuickInputRecord[],
  next: PersistedTerminalQuickInputRecord,
): void {
  const index = items.findIndex((item) => item.id === next.id);
  if (index >= 0) {
    items[index] = next;
  }
}

function sortItems(
  items: TerminalQuickInputItem[],
  kind: TerminalQuickInputListKind,
): TerminalQuickInputItem[] {
  const timestamp = (item: TerminalQuickInputItem): number =>
    Date.parse(item.lastUsedAt ?? item.updatedAt ?? item.createdAt) || 0;
  return [...items].sort((left, right) => {
    if (kind === "all" && left.pinned !== right.pinned) {
      return left.pinned ? -1 : 1;
    }
    return timestamp(right) - timestamp(left);
  });
}

function applyRetention(
  items: PersistedTerminalQuickInputRecord[],
): PersistedTerminalQuickInputRecord[] {
  const visibleRecent = items
    .filter((item) => item.hiddenAt == null && !item.pinned)
    .sort(
      (left, right) =>
        (Date.parse(left.lastUsedAt ?? left.createdAt) || 0) -
        (Date.parse(right.lastUsedAt ?? right.createdAt) || 0),
    );
  const removeIds = new Set(
    visibleRecent.slice(0, Math.max(0, visibleRecent.length - MAX_RECENT_ITEMS))
      .map((item) => item.id),
  );
  return items.filter((item) => !removeIds.has(item.id));
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return 50;
  }
  return Math.min(100, Math.max(1, Math.floor(limit)));
}
