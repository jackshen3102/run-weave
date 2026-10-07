import { createReadStream } from "node:fs";
import { realpath } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { inside, recordTurnId } from "../token-report/logs.mjs";
import { messageText } from "../token-report/evidence.mjs";
import {
  callSkills,
  injectedSkills,
  skillIdentity,
  successfulBodies,
} from "./evidence.mjs";

export async function readSkillSession(candidate, scope, since, until) {
  if (!candidate.size) return { excluded: "空日志" };
  const stream = createReadStream(candidate.file, { end: candidate.size - 1 });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const calls = new Map(),
    turns = new Map(),
    windowTurns = new Set(),
    injections = [],
    events = [];
  let meta,
    current,
    line = 0,
    invalid = 0,
    inherited = 0;
  const emit = (call, skill, status, resultLine, reason) =>
    events.push({
      id: skill.id,
      name: skill.name,
      path: skill.path,
      status,
      reason,
      turnId: call.turnId,
      timestamp: call.timestamp,
      callId: call.id,
      file: candidate.file,
      line: call.line,
      resultLine,
    });
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
      if (!record || typeof record !== "object") {
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
        const cwd = await realpath(meta.cwd).catch(() =>
          path.resolve(meta.cwd),
        );
        if (scope && !scope.worktrees.some((root) => inside(root, cwd)))
          return { excluded: "其他项目" };
      }
      const timestamp = Date.parse(record.timestamp);
      // Forks/subagents can carry a complete copy of their parent's history.
      if (
        timestamp < Date.parse(meta.timestamp) &&
        (meta.forked_from_id ||
          meta.source?.subagent ||
          meta.thread_source === "subagent")
      ) {
        inherited++;
        continue;
      }
      const inWindow = timestamp >= since && timestamp <= until;
      const turnId = recordTurnId(record, line);
      if (turnId !== null) {
        current = turnId;
        if (!turns.has(current)) turns.set(current, false);
        for (const injection of injections.splice(0)) {
          emit(
            { ...injection, turnId: current },
            injection.skill,
            "confirmed",
            injection.line,
            "injected-body",
          );
          windowTurns.add(current);
        }
      }
      if (current && inWindow) windowTurns.add(current);
      if (
        record.type === "event_msg" &&
        ["task_complete", "turn_aborted"].includes(payload.type)
      )
        turns.set(payload.turn_id ?? current, true);
      if (record.type !== "response_item") continue;
      if (payload.type === "message" && payload.role === "user") {
        const text = messageText(payload);
        if (/^The following is the Codex agent history/.test(text))
          return { excluded: "审批评估会话" };
        if (inWindow)
          for (const skill of injectedSkills(text)) {
            const injection = {
              skill,
              timestamp: record.timestamp,
              id: payload.id ?? `injection-${record.timestamp}-${skill.id}`,
              line,
            };
            if (!current || turns.get(current)) injections.push(injection);
            else
              emit(
                { ...injection, turnId: current },
                skill,
                "confirmed",
                line,
                "injected-body",
              );
          }
      }
      if (
        ["function_call", "custom_tool_call"].includes(payload.type) &&
        current &&
        inWindow
      ) {
        const skills = callSkills(payload);
        const callId = payload.call_id ?? `unpaired-call-${line}`;
        if (skills.length && !calls.has(callId))
          calls.set(callId, {
            id: callId,
            turnId: current,
            line,
            timestamp: record.timestamp,
            skills,
          });
      }
      if (
        ["function_call_output", "custom_tool_call_output"].includes(
          payload.type,
        ) &&
        timestamp <= until
      ) {
        const call = calls.get(payload.call_id);
        if (!call || call.finished) continue;
        const names = successfulBodies(payload.output);
        for (const skill of call.skills) {
          const declaredName = names.includes(skill.name)
            ? skill.name
            : call.skills.length === 1 && skill.aliasSafe && names.length === 1
              ? names[0]
              : null;
          const confirmed = skill.kind === "read" && declaredName !== null;
          emit(
            call,
            confirmed
              ? { ...skill, ...skillIdentity(skill.path, declaredName) }
              : skill,
            confirmed ? "confirmed" : "candidate",
            line,
            confirmed ? "successful-body-read" : "unverified-path",
          );
        }
        call.finished = true;
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  if (!meta) return { excluded: "空日志" };
  if (current && !turns.get(current)) return { excluded: "仍在进行的会话" };
  if (!windowTurns.size) return { excluded: "时间范围内没有可用记录" };
  for (const call of calls.values())
    if (!call.finished)
      for (const skill of call.skills)
        emit(call, skill, "candidate", null, "missing-result");
  return {
    id: meta.id,
    cwd: meta.cwd,
    createdAt: meta.timestamp ?? null,
    parentSessionId:
      meta.forked_from_id ??
      meta.source?.subagent?.thread_spawn?.parent_thread_id ??
      null,
    turns: [...windowTurns],
    events,
    coverage: {
      invalidRecords: invalid,
      inheritedRecords: inherited,
      unassignedInjections: injections.length,
    },
  };
}
