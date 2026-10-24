import os from "node:os";
import path from "node:path";
import { open } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { DailyManifest, DailyProvider } from "@runweave/shared/daily-record";
import { collectNative } from "./native.js";
import {
  dates,
  dayFormatter,
  hash,
  loadBundle,
  publishDirectory,
} from "./data.js";
import { readFacts, render } from "./facts.js";
import { assignProjects } from "./projects.js";

const help = `本地 Agent 每日事实记录（只读本机来源）
collect --from YYYY-MM-DD --to YYYY-MM-DD --timezone Asia/Shanghai --out <新目录> [--home <来源HOME>] [--providers codex,pi] [--machine-id <固定ID>] [--exclude-thread <ID>]
review --bundle <材料目录> [--date YYYY-MM-DD] [--thread <ID>] [--max-chars 1200] [--role user|assistant|tool]
read --bundle <材料目录> --id <材料ID> [--verify-source]
validate --bundle <材料目录> --facts <facts.json>
render --bundle <材料目录> --facts <facts.json> --out <新目录>
日期两端均包含。新目录不得已存在；0=成功，2=材料覆盖不完整，1=输入或校验失败。`;

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help") {
    process.stdout.write(help + "\n");
    return;
  }
  const { values } = parseArgs({
    args,
    options: {
      from: { type: "string" },
      to: { type: "string" },
      timezone: { type: "string", default: "Asia/Shanghai" },
      out: { type: "string" },
      home: { type: "string" },
      providers: { type: "string" },
      "machine-id": { type: "string" },
      "exclude-thread": { type: "string", multiple: true },
      bundle: { type: "string" },
      facts: { type: "string" },
      date: { type: "string" },
      thread: { type: "string" },
      id: { type: "string" },
      role: { type: "string" },
      "max-chars": { type: "string", default: "1200" },
      "verify-source": { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const required = (
    name: "from" | "to" | "out" | "bundle" | "facts" | "id",
  ) => {
    const value = values[name];
    if (!value) throw new Error(`缺少 --${name}`);
    return value;
  };
  const output = (value: unknown) =>
    process.stdout.write(JSON.stringify(value, null, 2) + "\n");
  if (command === "collect") {
    const from = required("from"),
      to = required("to"),
      days = dates(from, to),
      timeZone = values.timezone;
    dayFormatter(timeZone);
    const providers = values.providers?.split(",") as DailyProvider[] | undefined;
    if (providers && (!providers.length || new Set(providers).size !== providers.length ||
      providers.some((v) => !["codex", "pi", "claude", "trae"].includes(v))))
      throw new Error("providers 须为不重复的 codex,pi,claude,trae 列表");
    const { materials, sources } = await collectNative({
      from,
      to,
      timeZone,
      home: values.home,
      providers,
      excludeThreads: values["exclude-thread"],
    });
    await assignProjects(materials);
    const jsonl =
      materials.map((material) => JSON.stringify(material)).join("\n") +
      (materials.length ? "\n" : "");
    const materialsSha256 = hash(jsonl);
    const manifest: DailyManifest = {
      schemaVersion: 1,
      collectionId: hash(
        JSON.stringify({ from, to, timeZone, materialsSha256, sources }),
      ),
      machineId: values["machine-id"] ?? os.hostname(),
      collectedAt: new Date().toISOString(),
      from,
      to,
      timeZone,
      days,
      materialsSha256,
      sources,
    };
    const sessions = new Map<
      string,
      {
        day: string;
        provider: string;
        threadId: string;
        cwd: string;
        project: (typeof materials)[number]["project"];
        origin: string;
        user: number;
        assistant: number;
        tool: number;
      }
    >();
    for (const material of materials) {
      const key = `${material.day}:${material.provider}:${material.threadId}`;
      const session = sessions.get(key) ?? {
        day: material.day,
        provider: material.provider,
        threadId: material.threadId,
        cwd: material.cwd,
        project: material.project,
        origin: material.origin,
        user: 0,
        assistant: 0,
        tool: 0,
      };
      session[material.role]++;
      sessions.set(key, session);
    }
    const out = path.resolve(required("out"));
    await publishDirectory(out, {
      "manifest.json": JSON.stringify(manifest, null, 2) + "\n",
      "materials.jsonl": jsonl,
      "sessions.json": JSON.stringify([...sessions.values()], null, 2) + "\n",
      "facts.template.json":
        JSON.stringify(
          {
            schemaVersion: 1,
            collectionId: manifest.collectionId,
            days: days.map((date) => ({ date, items: [] })),
          },
          null,
          2,
        ) + "\n",
    });
    output({
      bundle: out,
      collectionId: manifest.collectionId,
      materials: materials.length,
      sessions: sessions.size,
      sources,
    });
    if (sources.some((source) => source.status !== "complete"))
      process.exitCode = 2;
    return;
  }
  const { manifest, materials } = await loadBundle(
    path.resolve(required("bundle")),
  );
  await assignProjects(materials);
  if (command === "review") {
    const limit = Number(values["max-chars"]);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100000)
      throw new Error("max-chars 须为 1–100000");
    if (values.role && !["user", "assistant", "tool"].includes(values.role))
      throw new Error("role 无效");
    output(
      materials
        .filter(
          (item) =>
            (!values.date || item.day === values.date) &&
            (!values.thread || item.threadId === values.thread) &&
            (values.role ? item.role === values.role : item.role !== "tool"),
        )
        .map((item) => ({
          id: item.id,
          day: item.day,
          provider: item.provider,
          threadId: item.threadId,
          cwd: item.cwd,
          project: item.project,
          origin: item.origin,
          role: item.role,
          phase: item.phase,
          text: item.text.slice(0, limit),
          truncated: item.text.length > limit,
        })),
    );
    return;
  }
  if (command === "read") {
    const material = materials.find((item) => item.id === required("id"));
    if (!material) throw new Error("材料 ID 不存在");
    if (values["verify-source"]) {
      const handle = await open(material.locator.path, "r");
      try {
        const raw = Buffer.alloc(material.locator.byteLength);
        const { bytesRead } = await handle.read(
          raw,
          0,
          raw.length,
          material.locator.byteOffset,
        );
        if (bytesRead !== raw.length || hash(raw) !== material.locator.sha256)
          throw new Error("原始来源已变动或不可完整读取");
      } finally {
        await handle.close();
      }
    }
    output(material);
    return;
  }
  if (command === "validate" || command === "render") {
    const facts = await readFacts(required("facts"), manifest, materials);
    if (command === "validate")
      output({
        valid: true,
        days: facts.days.length,
        facts: facts.days.reduce((count, day) => count + day.items.length, 0),
        note: "引用与日期校验通过；事实语义仍需对照原文",
      });
    else {
      output(await render(path.resolve(required("out")), facts, manifest));
      if (manifest.sources.some((source) => source.status !== "complete"))
        process.exitCode = 2;
    }
    return;
  }
  throw new Error(`未知命令 ${command}\n${help}`);
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
