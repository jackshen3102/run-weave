/** Read-only current-policy replay against a frozen historical baseline; no watch or delivery imports. */
import { mkdir, readFile, writeFile, appendFile, mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { settingText } from "../../packages/config-node/src/index.ts";
import type { SupervisionInput, TaskOutcome } from "../../packages/shared/src/task-supervision.ts";
import { TaskSupervisionClassifier } from "../../backend/src/task-supervision/classifier.ts";
import { assessClassification, ASSESSMENT_THRESHOLDS } from "../../backend/src/task-supervision/assessment.ts";

type Label = TaskOutcome | "hold";
interface Sample { id: string; group: string; split: "calibration" | "evaluation"; expected: Label; rationale: string; origin: "synthetic" | "historical"; repeat: boolean; input: SupervisionInput }
type Result = Omit<Awaited<ReturnType<TaskSupervisionClassifier["run"]>>, "assessment"> & { assessment?: Awaited<ReturnType<TaskSupervisionClassifier["run"]>>["assessment"] };
interface RecordRow { id: string; strategy: "baseline" | "assessment"; repeat: number; result?: Result; error?: string }
const args = process.argv.slice(2);
const option = (key: string) => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1]; };
if (!option("--input") || !option("--output") || !option("--baseline")) throw new Error("需要 --input <冻结语料.json> --output <本机结果目录> --baseline <历史回放目录>；旧策略只读历史结果，不提供运行时开关。");
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const inputPath = await realpath(path.resolve(option("--input")!));
const baselinePath = await realpath(path.resolve(option("--baseline")!));
await mkdir(path.resolve(option("--output")!), { recursive: true, mode: 0o700 });
const outputPath = await realpath(path.resolve(option("--output")!));
for (const file of [inputPath, outputPath, baselinePath]) {
  if (file === root) throw new Error("不能在源码根目录保存回放原文。");
  if (file.startsWith(`${root}${path.sep}`)) {
    try { execFileSync("git", ["check-ignore", "-q", file], { cwd: root }); }
    catch { throw new Error("语料和结果只能放在源码之外或 Git 忽略目录。"); }
  }
}
const bytes = await readFile(inputPath, "utf8");
const baselineManifest = JSON.parse(await readFile(path.join(baselinePath, "manifest.json"), "utf8")) as { inputSha256: string; model: string; startedAt: string };
if (baselineManifest.inputSha256 !== createHash("sha256").update(bytes).digest("hex")) throw new Error("历史基线与当前冻结语料指纹不一致。");
const samples = JSON.parse(bytes) as Sample[];
if (samples.length !== 120 || new Set(samples.map((s) => s.id)).size !== 120) throw new Error("必须冻结120条不重号语料。");
const groups = new Map<string, string>();
for (const sample of samples) {
  if (!sample.group || !sample.rationale || !["synthetic", "historical"].includes(sample.origin) || !sample.input?.currentReply?.id ||
    !["completed", "continue", "blocked", "hold"].includes(sample.expected)) throw new Error(`语料字段无效：${sample.id}`);
  if (groups.has(sample.group) && groups.get(sample.group) !== sample.split) throw new Error("同任务组跨越校准/留出集合。");
  groups.set(sample.group, sample.split);
}
for (const [split, count] of [["calibration", 10], ["evaluation", 20]] as const)
  for (const label of ["completed", "continue", "blocked", "hold"])
    if (samples.filter((s) => s.split === split && s.expected === label).length !== count) throw new Error("集合必须按四种动作均衡。");
if (samples.filter((s) => s.repeat).length !== 16) throw new Error("必须预先指定16条波动观察语料。");
const concurrency = Number(option("--concurrency") ?? 2);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error("并发只能为1到4。");
const model = option("--model") ?? settingText("backend.taskSupervision.model");
const records = (await readFile(path.join(baselinePath, "results.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as RecordRow).filter((row) => row.strategy === "baseline");
const baselineKeys = new Set(records.map((row) => `${row.id}:${row.repeat}`));
if (records.length !== 152 || baselineKeys.size !== 152 || records.some((row) => !samples.some((s) => s.id === row.id && (row.repeat === 0 || s.repeat && [1, 2].includes(row.repeat))))) throw new Error("历史基线必须恰好包含120条原始判断及16条样本的两次重复，不允许重号或缺失。");
const manifest = { startedAt: new Date().toISOString(), inputSha256: createHash("sha256").update(bytes).digest("hex"), model: model ?? "Codex default (immutable revision unavailable)", concurrency, count: samples.length, expectedCalls: 152, historicalBaseline: baselineManifest };
// Exclusive creation prevents accidental overwrite or selecting a favorable previous run.
await writeFile(path.join(outputPath, "manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx", mode: 0o600 });
await writeFile(path.join(outputPath, "results.jsonl"), records.map((row) => JSON.stringify(row)).join("\n") + "\n", { flag: "wx", mode: 0o600 });
const jobs = (subset: Sample[], repeat = 0) => subset.map((sample) => ({ sample, strategy: "assessment" as const, repeat }));
async function run(batch: ReturnType<typeof jobs>) {
  let index = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (index < batch.length) {
      const job = batch[index++]!;
      const row: RecordRow = { id: job.sample.id, strategy: job.strategy, repeat: job.repeat };
      try {
        row.result = await classifier.run(job.sample.input,
          { model, timeoutMs: 90_000, signal: new AbortController().signal });
      } catch (error) { row.error = error instanceof Error ? error.message : String(error); }
      records.push(row);
      await appendFile(path.join(outputPath, "results.jsonl"), JSON.stringify(row) + "\n", { mode: 0o600 });
      console.log(JSON.stringify({ completed: records.length, ...{ id: row.id, strategy: row.strategy, repeat: row.repeat }, error: Boolean(row.error) }));
    }
  }));
}
function prediction(row: RecordRow, thresholds?: { minimumScore: number; minimumMargin: number }): Label | "error" {
  if (!row.result) return "error";
  if (row.strategy === "baseline") return row.result.outcome;
  const assessment = row.result.assessment!;
  const sample = samples.find((s) => s.id === row.id)!;
  const progress = assessment.progress as (NonNullable<typeof assessment.progress> & { alternativePath: string }) | undefined;
  const recalculated = assessClassification(sample.input, { ...row.result, assessment: {
    coverage: assessment.coverage, criteria: assessment.criteria, missingEvidence: assessment.missingEvidence,
    progress: progress ?? null,
  } }, thresholds);
  return recalculated.disposition === "hold" ? "hold" : row.result.outcome;
}
const errors = (rows: RecordRow[], thresholds?: { minimumScore: number; minimumMargin: number }) => rows.filter((r) => prediction(r, thresholds) !== samples.find((s) => s.id === r.id)!.expected).length;
const temporary = await mkdtemp(path.join(os.tmpdir(), "supervision-replay-"));
const classifier = new TaskSupervisionClassifier(temporary);
try {
  await run(jobs(samples.filter((s) => s.split === "calibration")));
  const selected = { thresholds: ASSESSMENT_THRESHOLDS, errors: errors(records.filter((r) => r.strategy === "assessment")) };
  await writeFile(path.join(outputPath, "frozen-thresholds.json"), JSON.stringify({ ...selected, frozenAt: new Date().toISOString(), source: "current production policy; not retuned" }, null, 2), { flag: "wx", mode: 0o600 });
  await run(jobs(samples.filter((s) => s.split === "evaluation")));
  for (const repeat of [1, 2]) await run(jobs(samples.filter((s) => s.repeat), repeat));
  const evaluation = records.filter((r) => r.repeat === 0 && samples.find((s) => s.id === r.id)!.split === "evaluation");
  const quantile = (values: number[], q: number) => values.sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))] ?? null;
  const summaries = Object.fromEntries((["baseline", "assessment"] as const).map((strategy) => {
    const rows = evaluation.filter((r) => r.strategy === strategy);
    const wrong = rows.filter((r) => prediction(r, selected.thresholds) !== samples.find((s) => s.id === r.id)!.expected);
    const durations = rows.flatMap((r) => r.result ? [r.result.durationMs] : []);
    return [strategy, { count: rows.length, errors: wrong.length, modelFailures: rows.filter((r) => r.error).length,
      falseCompleted: wrong.filter((r) => prediction(r, selected.thresholds) === "completed").length,
      falseContinue: wrong.filter((r) => prediction(r, selected.thresholds) === "continue").length,
      falseBlocked: wrong.filter((r) => prediction(r, selected.thresholds) === "blocked").length,
      falseHold: wrong.filter((r) => prediction(r, selected.thresholds) === "hold").length,
      medianMs: quantile([...durations], .5), p95Ms: quantile([...durations], .95), wrongIds: wrong.map((r) => r.id) }];
  }));
  const differences = evaluation.filter((r) => r.strategy === "baseline").map((baseline) => {
    const candidate = evaluation.find((r) => r.id === baseline.id && r.strategy === "assessment")!;
    const expected = samples.find((s) => s.id === baseline.id)!.expected;
    return Number(prediction(candidate, selected.thresholds) !== expected) - Number(prediction(baseline) !== expected);
  });
  let seed = 17017;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  // Resample whole task groups, retaining their four status variants together.
  const evaluationGroups = [...new Set(samples.filter((s) => s.split === "evaluation").map((s) => s.group))];
  const grouped = evaluationGroups.map((group) => differences.filter((_, index) => samples.find((s) => s.id === evaluation.filter((r) => r.strategy === "baseline")[index]!.id)!.group === group));
  const bootstrap = Array.from({ length: 10000 }, () => Array.from({ length: grouped.length }, () => grouped[Math.floor(random() * grouped.length)]!).flat().reduce((sum, value) => sum + value, 0) / differences.length);
  const summary = { manifest, thresholds: selected.thresholds, strategies: summaries, actualCalls: records.filter((row) => row.strategy === "assessment").length, importedBaselineCount: records.filter((row) => row.strategy === "baseline").length,
    pairedErrorRateDifference: differences.reduce((a, b) => a + b, 0) / differences.length,
    groupedBootstrap95: [quantile([...bootstrap], .025), quantile([...bootstrap], .975)],
    repeatPredictions: records.filter((r) => samples.find((s) => s.id === r.id)!.repeat).map((r) => ({ id: r.id, strategy: r.strategy, repeat: r.repeat, prediction: prediction(r, selected.thresholds) })),
    tokenUsage: "not exposed by classifier; not estimated", goalGenerationCost: "not measured (identical goal snapshots)",
    limitation: "基线为历史结果，非同时运行或同一不可变模型版本的对照；时延不能用于当前策略的因果收益结论。报告层语料不证明实际任务完成率，模型失败和难例波动均保留。" };
  await writeFile(path.join(outputPath, "summary.json"), JSON.stringify(summary, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(summaries));
} finally { await rm(temporary, { recursive: true, force: true }); }
