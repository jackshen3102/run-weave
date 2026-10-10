/** Offline copy-only conversion. Every output must be a new file; never edit a live state file. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  topicKey,
  type FeishuState,
  type ProcessedMessage,
  type FeishuTopicRecord,
} from "../../packages/runweave-cli/src/feishu/state-store";
interface Source {
  appId: string;
  backendId: string;
  file: string;
}
interface Manifest {
  mode: "import" | "rollback";
  appId: string;
  chatId: string;
  sources: Source[];
  output: string;
  hubFile?: string;
}
function validate(state: FeishuState, version: number, chatId: string): void {
  if (state.version !== version || !state.topics || !state.processed)
    throw new Error("Invalid state version or shape");
  for (const [chat, topics] of Object.entries(state.topics)) {
    if (chat !== chatId)
      throw new Error(
        "Unexpected chat; isolate the selected application/chat before migration",
      );
    for (const [key, topic] of Object.entries(topics)) {
      if (
        topic.status !== "active" ||
        topic.chatId !== chat ||
        !topic.terminalSessionId ||
        !topic.rootMessageId ||
        key !== topicKey(topic.terminalSessionId, topic.backendId)
      )
        throw new Error("Unsettled or invalid topic");
      if (version === 3 && !/^[a-f0-9]{64}$/.test(topic.backendId ?? ""))
        throw new Error("Missing backend binding");
    }
  }
  for (const [id, delivery] of Object.entries(state.processed)) {
    if (
      id !== delivery.messageId ||
      !delivery.terminalSessionId ||
      !Number.isFinite(Date.parse(delivery.updatedAt)) ||
      !["waiting", "processing", "succeeded", "failed", "unknown"].includes(
        delivery.status,
      )
    )
      throw new Error("Invalid delivery");
    if (version === 3 && !/^[a-f0-9]{64}$/.test(delivery.backendId ?? ""))
      throw new Error("Missing delivery binding");
  }
}
function settle(entry: ProcessedMessage): ProcessedMessage {
  const copy = { ...entry };
  if (copy.status === "processing" || copy.status === "waiting") {
    copy.status =
      copy.inputAttempted || copy.status === "processing"
        ? "unknown"
        : "failed";
    delete copy.event;
  }
  return copy;
}
export async function migrateFeishuState(
  manifest: Manifest,
): Promise<string[]> {
  if (
    !["import", "rollback"].includes(manifest.mode) ||
    !manifest.appId ||
    !manifest.chatId ||
    !Array.isArray(manifest.sources) ||
    !manifest.output
  )
    throw new Error("Invalid manifest");
  const ids = new Set<string>();
  const sources: Array<{ source: Source; state: FeishuState }> = [];
  for (const source of manifest.sources) {
    if (source.appId !== manifest.appId) continue;
    if (!/^[a-f0-9]{64}$/.test(source.backendId) || ids.has(source.backendId))
      throw new Error("Invalid or duplicate backend identity");
    ids.add(source.backendId);
    const state = JSON.parse(
      await readFile(source.file, "utf8"),
    ) as FeishuState;
    validate(state, 2, manifest.chatId);
    sources.push({ source, state });
  }
  if (!sources.length) throw new Error("No sources for selected application");
  const outputs: Array<{ file: string; state: FeishuState }> = [];
  if (manifest.mode === "import") {
    const state: FeishuState = { version: 3, topics: {}, processed: {} };
    const roots = new Set<string>();
    for (const { source, state: input } of sources) {
      for (const topics of Object.values(input.topics))
        for (const topic of Object.values(topics)) {
          if (topic.status !== "active") throw new Error("Unsettled topic");
          if (roots.has(topic.rootMessageId))
            throw new Error("Conflicting topic root");
          roots.add(topic.rootMessageId);
          const output = { ...topic, backendId: source.backendId };
          (state.topics[manifest.chatId] ??= {})[
            topicKey(topic.terminalSessionId, source.backendId)
          ] = output;
        }
      for (const [id, entry] of Object.entries(input.processed)) {
        if (state.processed[id])
          throw new Error("Conflicting processed message");
        state.processed[id] = { ...settle(entry), backendId: source.backendId };
      }
    }
    outputs.push({ file: manifest.output, state });
  } else {
    if (!manifest.hubFile) throw new Error("hubFile required");
    const hub = JSON.parse(
      await readFile(manifest.hubFile, "utf8"),
    ) as FeishuState;
    validate(hub, 3, manifest.chatId);
    for (const topic of Object.values(hub.topics[manifest.chatId] ?? {}))
      if (!ids.has(topic.backendId!))
        throw new Error("Rollback lacks source for a hub backend");
    for (const entry of Object.values(hub.processed))
      if (!ids.has(entry.backendId!))
        throw new Error("Rollback lacks delivery owner");
    for (const { source, state } of sources) {
      for (const topic of Object.values(hub.topics[manifest.chatId] ?? {})) {
        if (topic.backendId !== source.backendId) continue;
        const copy: FeishuTopicRecord = { ...topic };
        delete copy.backendId;
        (state.topics[manifest.chatId] ??= {})[copy.terminalSessionId] = copy;
      }
      for (const [id, entry] of Object.entries(hub.processed)) {
        if (entry.backendId !== source.backendId) continue;
        if (
          state.processed[id] &&
          state.processed[id]!.terminalSessionId !== entry.terminalSessionId
        )
          throw new Error("Conflicting delivery target");
        const copy = settle(entry);
        delete copy.backendId;
        state.processed[id] = copy;
      }
      outputs.push({
        file: path.join(manifest.output, `${source.backendId}.json`),
        state,
      });
    }
  }
  // Validation completes before any output. wx prevents overwriting either source or destination.
  for (const output of outputs) {
    await mkdir(path.dirname(output.file), { recursive: true, mode: 0o700 });
    await writeFile(output.file, JSON.stringify(output.state, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
  }
  return outputs.map((output) => output.file);
}
async function cli() {
  const file = process.argv[2];
  if (!file)
    throw new Error(
      "Usage: tsx scripts/feishu/migrate-state.ts <manifest.json>; stop all senders/bridges first",
    );
  const result = await migrateFeishuState(
    JSON.parse(await readFile(file, "utf8")),
  );
  console.log(JSON.stringify({ converted: result.length, outputs: result }));
}

if (require.main === module)
  void cli().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
