import path from "node:path";

type JsonRecord = Record<string, unknown>;

const BRIDGE_BASENAME = "runweave-hook-bridge";
const LEGACY_BRIDGE_BASENAME = "browser-viewer-hook-bridge";
const RUNWEAVE_HOOK_MARKER = "_runweaveManaged";

// Compatibility cleanup for legacy global Trae CLI hooks in
// `~/.trae/traecli.toml`. New Trae plugin hooks live in
// `plugins/toolkit/hooks.json`.
const RUNWEAVE_TRAE_TOML_FENCE_BEGIN =
  "# >>> runweave-hooks (managed by Runweave) >>>";
const RUNWEAVE_TRAE_TOML_FENCE_END =
  "# <<< runweave-hooks (managed by Runweave) <<<";
const LEGACY_RUNWEAVE_TRAE_TOML_FENCE_BEGIN =
  "# >>> runweave-hooks (managed by Browser Viewer) >>>";
const LEGACY_RUNWEAVE_TRAE_TOML_FENCE_END =
  "# <<< runweave-hooks (managed by Browser Viewer) <<<";

export function mergeJsonHookEntry(args: {
  existing: Array<unknown>;
  command: string;
  timeout: number;
}): Array<unknown> {
  const nextHook = createRunweaveHook(args.command, args.timeout);

  const merged: Array<unknown> = [];
  let inserted = false;

  for (const entry of args.existing) {
    if (isRecord(entry) && isRunweaveHookEntry(entry)) {
      if (!inserted) {
        merged.push(rewriteRunweaveHooks(entry, nextHook));
        inserted = true;
      } else {
        const prunedEntry = removeRunweaveHooks(entry);
        if (prunedEntry) {
          merged.push(prunedEntry);
        }
      }

      continue;
    }

    merged.push(entry);
  }

  if (!inserted) {
    merged.push({
      matcher: "*",
      hooks: [nextHook],
    });
  }

  return merged;
}

// Exact command paths that early Runweave versions wrote into ~/.codex/hooks.json.
// The launcher now handles desktop/sound/Feishu, so these legacy entries would
// otherwise double-notify. We only remove commands that exactly match these
// known legacy paths (optionally followed by arguments) to avoid deleting a
// user's or third-party tool's own notify.sh / feishu_stop_notify.sh.
const LEGACY_CODEX_NOTIFY_RELATIVE_PATHS = [
  ".codex/hooks/feishu_stop_notify.sh",
  ".codex/notify.sh",
];

export function pruneSupersededCodexHooks(
  entries: Array<unknown>,
  homeDir: string,
): Array<unknown> {
  const legacyCommands = new Set(
    LEGACY_CODEX_NOTIFY_RELATIVE_PATHS.map((relative) =>
      path.join(homeDir, relative),
    ),
  );
  const result: Array<unknown> = [];

  for (const entry of entries) {
    if (!isRecord(entry) || !Array.isArray(entry.hooks)) {
      result.push(entry);
      continue;
    }

    const keptHooks = entry.hooks.filter(
      (hook) => !isLegacyCodexNotifyHook(hook, legacyCommands),
    );
    if (keptHooks.length === entry.hooks.length) {
      result.push(entry);
      continue;
    }

    if (keptHooks.length > 0) {
      result.push({ ...entry, hooks: keptHooks });
    }
  }

  return result;
}

function isLegacyCodexNotifyHook(
  hook: unknown,
  legacyCommands: Set<string>,
): boolean {
  if (!isRecord(hook)) {
    return false;
  }

  const command = hook.command;
  if (typeof command !== "string") {
    return false;
  }

  // The command may carry trailing arguments; match on the executable path only.
  const executable = command.trim().split(/\s+/)[0] ?? "";
  return legacyCommands.has(executable);
}

export function stripLegacyCodexNotifyKey(content: string): string {
  const lines = content.split("\n");
  const result: string[] = [];
  let insideSection = false;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();

    if (/^\[\[?[^\]]+\]?\]/.test(trimmed)) {
      insideSection = true;
      result.push(line);
      index += 1;
      continue;
    }

    if (!insideSection && /^notify\s*=\s*\[/.test(line)) {
      const arrayEnd = findTomlArrayEnd(lines, index);
      if (arrayEnd !== -1) {
        const captured = lines.slice(index, arrayEnd + 1).join("\n");
        if (captured.includes("notify.sh")) {
          index = arrayEnd + 1;
          continue;
        }
      }
    }

    result.push(line);
    index += 1;
  }

  return result.join("\n");
}

function findTomlArrayEnd(lines: string[], startIndex: number): number {
  let depth = 0;
  let inString: '"' | "'" | null = null;
  for (let lineIndex = startIndex; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    for (let charIndex = 0; charIndex < line.length; charIndex += 1) {
      const ch = line[charIndex];
      if (inString) {
        if (ch === "\\" && inString === '"') {
          charIndex += 1;
          continue;
        }
        if (ch === inString) {
          inString = null;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = ch;
        continue;
      }
      if (ch === "[") {
        depth += 1;
      } else if (ch === "]") {
        depth -= 1;
        if (depth === 0) {
          return lineIndex;
        }
      }
    }
  }
  return -1;
}

export function cleanupTraeTomlHookBlock(content: string): string {
  const fenceRegex = createRunweaveTraeFenceRegex();
  const withoutManagedFences = stripManagedTraeFenceMarkers(
    content.replace(fenceRegex, ""),
  );
  return collapseBlankLines(
    stripLegacyTraeBridgeEntries(withoutManagedFences).trimEnd(),
  );
}

function createRunweaveTraeFenceRegex(): RegExp {
  const fences: Array<[string, string]> = [
    [RUNWEAVE_TRAE_TOML_FENCE_BEGIN, RUNWEAVE_TRAE_TOML_FENCE_END],
    [
      LEGACY_RUNWEAVE_TRAE_TOML_FENCE_BEGIN,
      LEGACY_RUNWEAVE_TRAE_TOML_FENCE_END,
    ],
  ];
  return new RegExp(
    fences
      .map(
        ([begin, end]) => `${escapeRegex(begin)}[\\s\\S]*?${escapeRegex(end)}`,
      )
      .join("|"),
    "g",
  );
}

function stripManagedTraeFenceMarkers(content: string): string {
  const markers = [
    RUNWEAVE_TRAE_TOML_FENCE_BEGIN,
    RUNWEAVE_TRAE_TOML_FENCE_END,
    LEGACY_RUNWEAVE_TRAE_TOML_FENCE_BEGIN,
    LEGACY_RUNWEAVE_TRAE_TOML_FENCE_END,
  ];
  return content
    .split("\n")
    .filter((line) => !markers.includes(line.trim()))
    .join("\n");
}

// Strip any pre-existing un-fenced [[hooks.<Event>]] paragraphs that point at
// the Runweave bridge so we can replace them with the fenced canonical block.
// Earlier installer revisions wrote individual entries without fence markers,
// and some users edited traecli.toml by hand — both leave un-fenced entries.
function stripLegacyTraeBridgeEntries(content: string): string {
  // Match a top-level [[hooks.<Event>]] paragraph followed by its
  // [[hooks.<Event>.hooks]] sub-table whose command references the bridge.
  // The body runs up to the next TOML section header (line starting with `[`).
  const legacyRegex =
    /\[\[hooks\.[A-Za-z][A-Za-z0-9_]*\]\][^[]*\[\[hooks\.[A-Za-z][A-Za-z0-9_]*\.hooks\]\][^[]*?(?:browser-viewer-hook-bridge|runweave-hook-bridge)[^[]*/g;
  return content.replace(legacyRegex, "");
}

function collapseBlankLines(content: string): string {
  return content.replace(/\n{3,}/g, "\n\n");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRunweaveHookEntry(entry: Record<string, unknown>): boolean {
  const hooks = entry.hooks;
  if (!Array.isArray(hooks)) {
    return false;
  }

  return hooks.some((hook) => {
    if (!isRecord(hook)) {
      return false;
    }

    return isRunweaveHookObject(hook);
  });
}

function createRunweaveHook(command: string, timeout: number): JsonRecord {
  return {
    type: "command",
    command,
    timeout,
    // Stable marker identifying entries Runweave owns, so future migrations can
    // safely clean up only our own hooks instead of matching on command strings.
    [RUNWEAVE_HOOK_MARKER]: true,
  };
}

function rewriteRunweaveHooks(
  entry: Record<string, unknown>,
  nextHook: Record<string, unknown>,
): Record<string, unknown> {
  const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
  const rewrittenHooks = hooks.map((hook) =>
    isRecord(hook) && isRunweaveHookObject(hook) ? { ...nextHook } : hook,
  );

  return {
    ...entry,
    hooks: rewrittenHooks,
  };
}

function removeRunweaveHooks(
  entry: Record<string, unknown>,
): Record<string, unknown> | null {
  const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
  const remainingHooks = hooks.filter(
    (hook) => !(isRecord(hook) && isRunweaveHookObject(hook)),
  );
  if (remainingHooks.length === 0) {
    return null;
  }

  return {
    ...entry,
    hooks: remainingHooks,
  };
}

function isRunweaveHookObject(hook: Record<string, unknown>): boolean {
  if (hook[RUNWEAVE_HOOK_MARKER] === true) {
    return true;
  }

  const command = hook.command;
  return (
    typeof command === "string" &&
    (command.includes(BRIDGE_BASENAME) ||
      command.includes(LEGACY_BRIDGE_BASENAME))
  );
}
