import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import {
  addFinding,
  excerpt,
  finishFindings,
  inspectResult,
  makeCall,
  messageText,
  taskTitle,
} from "./evidence.mjs";

const FIELDS = {
  input: "input_tokens",
  cachedInput: "cached_input_tokens",
  output: "output_tokens",
  reasoningOutput: "reasoning_output_tokens",
  total: "total_tokens",
};
export const emptyUsage = () => ({
  input: 0,
  cachedInput: 0,
  output: 0,
  reasoningOutput: 0,
  total: 0,
});

export function addUsage(target, usage) {
  for (const key of Object.keys(FIELDS))
    target[key] =
      target[key] === null || usage[key] === null
        ? null
        : target[key] + usage[key];
}

function counter(value) {
  if (
    !value ||
    !["input_tokens", "output_tokens", "total_tokens"].every(
      (key) => Number.isSafeInteger(value[key]) && value[key] >= 0,
    )
  )
    return null;
  if (value.total_tokens !== value.input_tokens + value.output_tokens)
    return null;
  if (
    value.cached_input_tokens > value.input_tokens ||
    value.reasoning_output_tokens > value.output_tokens
  )
    return null;
  return Object.fromEntries(
    Object.entries(FIELDS).map(([key, field]) => [
      key,
      Number.isSafeInteger(value[field]) && value[field] >= 0
        ? value[field]
        : null,
    ]),
  );
}

function inside(root, directory) {
  const relative = path.relative(root, directory);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

export async function projectScope(cwd) {
  const directory = await realpath(cwd);
  const git = (args) =>
    execFileSync("git", ["-C", directory, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const root = await realpath(git(["rev-parse", "--show-toplevel"]));
  const worktrees = git(["worktree", "list", "--porcelain", "-z"])
    .split("\0")
    .filter((part) => part.startsWith("worktree "))
    .map((part) => path.resolve(part.slice(9)));
  return { root, worktrees: [...new Set([root, ...worktrees])] };
}

export async function listLogs(roots, since) {
  const files = [];
  const unavailable = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      unavailable.push({ path: directory, reason: error.code });
      return;
    }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const info = await stat(file);
          if (info.mtimeMs >= since)
            files.push({ file, size: info.size, modifiedAt: info.mtimeMs });
        } catch (error) {
          unavailable.push({ path: file, reason: error.code });
        }
      }
    }
  }
  for (const root of roots) await visit(root);
  return {
    files: files.sort(
      (a, b) => b.modifiedAt - a.modifiedAt || a.file.localeCompare(b.file),
    ),
    unavailable,
  };
}

export async function readSession(candidate, scope, since) {
  const stream = createReadStream(candidate.file, {
    end: Math.max(0, candidate.size - 1),
  });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let meta,
    current,
    previous,
    line = 0,
    invalid = 0,
    duplicates = 0,
    resets = 0;
  const turns = new Map(),
    calls = new Map(),
    warnings = new Set();
  const getTurn = (id, timestamp) => {
    if (!turns.has(id))
      turns.set(id, {
        id,
        line,
        startedAt: timestamp,
        endedAt: null,
        title: "未关联用户输入",
        usage: emptyUsage(),
        usageSamples: 0,
        findings: [],
        calls: new Map(),
        skills: new Set(),
        coverage: new Set(),
        inputPeak: 0,
        previousInput: null,
      });
    return turns.get(id);
  };
  try {
    for await (const raw of lines) {
      line++;
      let record;
      try {
        record = JSON.parse(raw);
      } catch {
        invalid++;
        continue;
      }
      const payload = record.payload;
      if (!payload || typeof payload !== "object") continue;
      if (!meta) {
        if (record.type !== "session_meta") return { excluded: "缺少会话身份" };
        meta = payload;
        if (typeof meta.id !== "string" || typeof meta.cwd !== "string")
          return { excluded: "会话身份不完整" };
        const directory = await realpath(meta.cwd).catch(() =>
          path.resolve(meta.cwd),
        );
        if (!scope.worktrees.some((root) => inside(root, directory)))
          return { excluded: "其他项目" };
      }
      if (record.type === "turn_context")
        current = getTurn(
          payload.turn_id ?? `unknown-${line}`,
          record.timestamp,
        );
      if (record.type === "event_msg" && payload.type === "task_started")
        current = getTurn(
          payload.turn_id ?? `unknown-${line}`,
          record.timestamp,
        );
      const inWindow =
        Number.isFinite(Date.parse(record.timestamp)) &&
        Date.parse(record.timestamp) >= since;
      if (
        record.type === "response_item" &&
        payload.type === "message" &&
        payload.role === "user"
      ) {
        const text = messageText(payload);
        if (
          /^(?:# AGENTS\.md|<(?:environment_context|skill|recommended_plugins)>)/.test(
            text,
          )
        )
          continue;
        if (/^The following is the Codex agent history/.test(text))
          return { excluded: "审批评估会话" };
        if (current && inWindow) {
          if (current.title === "未关联用户输入")
            current.title = taskTitle(text);
          if (
            /没有.{0,8}(?:改.{0,4}代码|复现)|你有.{0,12}(?:测试|验证)|那你标记已处理/.test(
              text,
            )
          ) {
            addFinding(
              current,
              "delivery-question",
              "用户追问交付或验证状态",
              ["流程", "Agent 行为", "项目说明"],
              { line, text: excerpt(text) },
              "需要核对用户预期、先前结论与实际证据。可能是正常澄清，不自动认定返工。",
            );
          }
        }
      }
      if (record.type === "event_msg" && payload.type === "token_count") {
        const usage = counter(payload.info?.total_token_usage);
        if (!usage) {
          if (inWindow) warnings.add("存在缺失或无效的用量记录");
          continue;
        }
        const base = previous ?? emptyUsage();
        previous = usage;
        const delta = Object.fromEntries(
          Object.keys(FIELDS).map((key) => [
            key,
            usage[key] === null || base[key] === null
              ? null
              : usage[key] - base[key],
          ]),
        );
        if (!inWindow) continue;
        if (Object.values(delta).some((value) => value !== null && value < 0)) {
          resets++;
          continue;
        }
        if (delta.total === 0) {
          duplicates++;
          continue;
        }
        current ??= getTurn("unassigned", record.timestamp);
        if (current.id === "unassigned")
          current.coverage.add("用量没有轮次标识");
        addUsage(current.usage, delta);
        current.usageSamples++;
        const input = payload.info?.last_token_usage?.input_tokens;
        if (Number.isSafeInteger(input) && input >= 0) {
          if (
            current.previousInput !== null &&
            input >= current.previousInput * 2 &&
            input - current.previousInput >= 32768
          ) {
            addFinding(
              current,
              "context-growth",
              "单次输入上下文明显增长",
              ["Agent 行为", "工具", "项目说明"],
              {
                line,
                text: `相邻用量采样的输入从 ${current.previousInput} 增长到 ${input} Token。`,
              },
              "输入增长可能来自必要资料、工具输出或任务范围变化；并不等于浪费，需查看相邻操作。",
            );
          }
          current.inputPeak = Math.max(current.inputPeak, input);
          current.previousInput = input;
        }
      }
      if (
        record.type === "event_msg" &&
        ["task_complete", "turn_aborted"].includes(payload.type)
      ) {
        const target = turns.get(payload.turn_id) ?? current;
        if (target) {
          target.endedAt = record.timestamp;
          target.outcome = payload.type;
        }
      }
      if (!current || !inWindow || record.type !== "response_item") continue;
      if (["function_call", "custom_tool_call"].includes(payload.type)) {
        const call = makeCall(payload, line);
        calls.set(payload.call_id, { call, turn: current });
        for (const skill of call.skills) current.skills.add(skill);
      }
      if (
        ["function_call_output", "custom_tool_call_output"].includes(
          payload.type,
        )
      ) {
        const pending = calls.get(payload.call_id);
        if (pending) {
          inspectResult(pending.turn, pending.call, payload, line);
          calls.delete(payload.call_id);
        }
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  if (!meta) return { excluded: "空日志" };
  if (current && !current.endedAt) return { excluded: "仍在进行的会话" };
  if (invalid)
    warnings.add(`${invalid} 条记录未能解析（包括可能未写完的末行）`);
  if (resets) warnings.add(`${resets} 次累计计数回退，回退点用量未计入`);
  const included = [...turns.values()].filter(
    (turn) => turn.usageSamples || turn.findings.length || turn.calls.size,
  );
  if (!included.length) return { excluded: "时间范围内没有可用记录" };
  const usage = emptyUsage();
  for (const turn of included) {
    if (!turn.usageSamples) {
      turn.coverage.add("该轮没有可用用量数据，不代表消耗为零");
      turn.usage = Object.fromEntries(
        Object.keys(FIELDS).map((key) => [key, null]),
      );
    }
    addUsage(usage, turn.usage);
    finishFindings(turn);
    turn.findings.forEach((finding) => {
      finding.id = `${meta.id}/${turn.id}/${finding.rule}`;
    });
    turn.skills = [...turn.skills];
    turn.coverage = [...turn.coverage];
    delete turn.calls;
    delete turn.previousInput;
  }
  return {
    id: meta.id,
    parentSessionId: meta.forked_from_id ?? null,
    file: candidate.file,
    cwd: meta.cwd,
    title: included[0].title,
    modifiedAt: new Date(candidate.modifiedAt).toISOString(),
    usage,
    turns: included,
    coverage: {
      warnings: [...warnings],
      duplicates,
      resets,
      invalid,
      usageSamples: included.reduce((sum, turn) => sum + turn.usageSamples, 0),
    },
  };
}
