import { parseArgs } from "node:util";
import { BrowserHistoryWriter } from "./writer.js";
import {
  HISTORY_BATCH_BYTES,
  historyUuid,
  validateHistoryObservation,
  historyObservationKey,
} from "@runweave/shared/browser-history";
function send(value: unknown) {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([header, body]));
}
async function main() {
  const { values, positionals } = parseArgs({
    options: {
      root: { type: "string" },
      browser: { type: "string" },
      "allowed-id": { type: "string" },
    },
    allowPositionals: true,
  });
  const { root, browser } = values;
  if (
    !root ||
    !["chrome", "edge"].includes(browser ?? "") ||
    !/^[a-p]{32}$/.test(values["allowed-id"] ?? "") ||
    positionals.length !== 1 ||
    positionals[0] !== `chrome-extension://${values["allowed-id"]}/`
  )
    throw Error("UNAUTHORIZED_HOST_ORIGIN");
  const writer = new BrowserHistoryWriter(root);
  let sourceId: string | undefined,
    buffer = Buffer.alloc(0);
  async function handle(raw: Buffer) {
    let id: unknown = null;
    try {
      const m = JSON.parse(raw.toString("utf8"));
      id = m.id;
      if (!historyUuid(id) || m.version !== 1) throw Error("INVALID_PROTOCOL");
      if (m.op === "hello") {
        if (!historyUuid(m.sourceId) || typeof m.profileLabel !== "string")
          throw Error("INVALID_SOURCE");
        if (sourceId && sourceId !== m.sourceId) throw Error("SOURCE_CHANGED");
        await writer.registerSource({
          sourceId: m.sourceId,
          browser: browser as "chrome" | "edge",
          profileLabel: m.profileLabel,
        });
        sourceId = m.sourceId;
        send({ id, ok: true, browser, version: 1 });
      } else if (m.op === "append") {
        if (
          !sourceId ||
          !Array.isArray(m.rows) ||
          !m.rows.length ||
          m.rows.length > 100
        )
          throw Error("INVALID_BATCH");
        for (const row of m.rows) {
          validateHistoryObservation(row);
          if (row.sourceId !== sourceId || row.browser !== browser)
            throw Error("SOURCE_MISMATCH");
        }
        await writer.append(m.rows);
        send({
          id,
          ok: true,
          acknowledgements: m.rows.map(historyObservationKey),
          storedAt: writer.lastStoredAt,
        });
      } else if (m.op === "status" && sourceId)
        send({ id, ok: true, storedAt: writer.lastStoredAt });
      else throw Error("UNKNOWN_OPERATION");
    } catch (e) {
      send({
        id,
        ok: false,
        error: e instanceof Error ? e.message : "HOST_ERROR",
      });
    }
  }
  try {
    for await (const chunk of process.stdin) {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (!length || length > HISTORY_BATCH_BYTES)
          throw Error("FRAME_TOO_LARGE");
        if (buffer.length < length + 4) break;
        const raw = buffer.subarray(4, length + 4);
        buffer = buffer.subarray(length + 4);
        await handle(raw);
      }
    }
    if (buffer.length) throw Error("INCOMPLETE_FRAME");
  } finally {
    await writer.close();
  }
}
main().catch((e) => {
  process.stderr.write(String(e) + "\n");
  process.exitCode = 1;
});
