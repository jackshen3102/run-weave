import type {
  SupportLogDefaultContext,
  SupportLogLevel,
  SupportLogStore,
} from "./support-log-types";

let activeStore: SupportLogStore | null = null;
let getDefaultContext: (() => SupportLogDefaultContext) | null = null;
const pendingWrites = new Set<Promise<void>>();

function trackWrite(write: Promise<void>): void {
  pendingWrites.add(write);
  void write.finally(() => {
    pendingWrites.delete(write);
  });
}

export function installSupportLogRecorder({
  store,
  resolveDefaultContext,
}: {
  store: SupportLogStore;
  resolveDefaultContext: () => SupportLogDefaultContext;
}): () => void {
  activeStore = store;
  getDefaultContext = resolveDefaultContext;

  return () => {
    if (activeStore === store) {
      activeStore = null;
      getDefaultContext = null;
    }
  };
}

export function recordSupportLog(
  event: string,
  fields?: Record<string, unknown>,
  level: SupportLogLevel = "info",
): void {
  const store = activeStore;
  if (!store) {
    return;
  }

  recordSupportLogToStore(store, event, fields, level);
}

export function recordSupportLogToStore(
  store: SupportLogStore,
  event: string,
  fields?: Record<string, unknown>,
  level: SupportLogLevel = "info",
  context: Partial<SupportLogDefaultContext> = getDefaultContext?.() ?? {},
): void {
  trackWrite(
    store.append({
      at: new Date().toISOString(),
      level,
      source: "app",
      event,
      fields: {
        ...context,
        ...(fields ?? {}),
      },
    }),
  );
}

export async function flushSupportLogs(): Promise<void> {
  const writes = [...pendingWrites];
  if (writes.length === 0) {
    return;
  }
  await Promise.allSettled(writes);
}
