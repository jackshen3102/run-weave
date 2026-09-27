import { createHash } from "node:crypto";

export function redact(value) {
  return (
    String(value)
      // eslint-disable-next-line no-control-regex -- Strip ANSI terminal formatting.
      .replace(/\u001b\[[0-9;]*m/g, "")
      .replace(/\bBearer\s+[\w.+/=-]+/gi, "Bearer [REDACTED]")
      .replace(/\b(?:sk-[\w-]{12,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, "[REDACTED]")
      .replace(
        /((?:password|passwd|access[_-]?token|refresh[_-]?token|api[_-]?key|secret|token)["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi,
        "$1[REDACTED]",
      )
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
  );
}

export function excerpt(value, limit = 600) {
  const text = redact(value);
  return text.length > limit ? `${text.slice(0, limit)}… [截断]` : text;
}

export function messageText(payload) {
  return (payload.content ?? [])
    .filter((item) => typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

export function taskTitle(text) {
  const clean = text
    .replace(/<scheduled_run_context>[\s\S]*/g, "")
    .replace(/<image\b[^>]*>[\s\S]*?<\/image>/g, "")
    .replace(/使用随记 Skill[^\n]*/g, "")
    .replace(/\{[^{}]*"format"\s*:\s*"suiji-handoff-v1"[^{}]*\}/g, "")
    .trim();
  return excerpt(clean || "随记任务", 100).replace(/\s+/g, " ");
}

// Unwrap tool transport envelopes. Text in source listings is never executed.
export function toolResult(output, depth = 0) {
  if (depth > 20) return { text: "", failed: false, truncated: true };
  if (typeof output === "string") {
    try {
      return toolResult(JSON.parse(output), depth + 1);
    } catch {
      const lines = output.split("\n");
      if (lines.length > 1 && lines.some((line) => line.startsWith("{"))) {
        return combine(lines.map((line) => toolResult(line, depth + 1)));
      }
      return {
        text: output.slice(0, 64_000),
        failed: false,
        truncated: output.length > 64_000,
      };
    }
  }
  if (Array.isArray(output))
    return combine(output.map((part) => toolResult(part, depth + 1)));
  if (output && typeof output === "object") {
    for (const key of ["output", "text", "value", "result"]) {
      if (!(key in output)) continue;
      const result = toolResult(output[key], depth + 1);
      result.failed ||=
        Number.isInteger(output.exit_code) && output.exit_code !== 0;
      return result;
    }
    const text = JSON.stringify(output);
    return {
      text: text.slice(0, 64_000),
      failed: output.ok === false || output.isError === true,
      truncated: text.length > 64_000,
    };
  }
  return { text: "", failed: false, truncated: false };
}

function combine(results) {
  const text = results.map((result) => result.text).join("\n");
  return {
    text: text.slice(0, 64_000),
    failed: results.some((result) => result.failed),
    truncated:
      text.length > 64_000 || results.some((result) => result.truncated),
  };
}

const BLOCKERS = [
  [
    "viewport",
    "浏览器交互受阻",
    ["工具", "环境"],
    /^\s*(?:[-\d ×]*)element is outside of the viewport\s*$/im,
  ],
  [
    "navigation",
    "导航被浏览器策略拒绝",
    ["流程", "环境"],
    /^Error: Protocol error \(Page.navigate\): Navigation to data: URLs is not allowed/m,
  ],
  [
    "artifact",
    "构建产物未通过一致性校验",
    ["代码", "流程", "环境"],
    /"code"\s*:\s*"artifact_unverified"/,
  ],
  [
    "approval",
    "操作被审批拒绝",
    ["流程", "环境"],
    /(?:Script error:[\s\S]{0,200})Rejected\(/,
  ],
  [
    "missing-path",
    "执行依赖的路径不可用",
    ["代码", "环境"],
    /^\s*(?:Error:.*(?:ENOENT|uv_cwd)|(?:[\w/.-]*sh:|cat:|sed:).*No such file or directory)/m,
  ],
  [
    "port",
    "端口或转发建立失败",
    ["代码", "环境"],
    /^.*(?:channel_setup_fwd_listener_tcpip: cannot listen to port|Could not request local forwarding\.)/m,
  ],
];

export function makeCall(payload, line) {
  const args = payload.arguments ?? payload.input ?? "";
  const raw = typeof args === "string" ? args : JSON.stringify(args);
  return {
    line,
    name: payload.name ?? "tool",
    key: createHash("sha256").update(`${payload.name}\0${raw}`).digest("hex"),
    polling:
      /(?:write_stdin|wait_agent|clock__sleep|tools\.wait\b)/.test(
        `${payload.name} ${raw}`,
      ) || payload.name === "sleep",
    // Avoid treating quoted error examples in source reads as runtime failures.
    sourceRead:
      /\b(?:cat|sed|rg|grep)\s|\.jsonl\b|readFile(?:Sync)?\s*\(|read_text\s*\(/.test(
        raw,
      ),
    summary: excerpt(raw, 350),
    skills: [...raw.matchAll(/\/skills\/([^/\s]+)\/SKILL\.md/g)].map(
      (match) => match[1],
    ),
  };
}

export function inspectResult(turn, call, payload, line) {
  const result = toolResult(payload.output);
  if (result.truncated) turn.coverage.add("部分工具输出超出扫描窗口");
  const clean = redact(result.text);
  const evidence = {
    line,
    callLine: call.line,
    tool: call.name,
    text: excerpt(clean, 700),
  };
  if (!call.sourceRead) {
    for (const [rule, title, categories, pattern] of BLOCKERS) {
      const match = pattern.exec(clean);
      if (!match) continue;
      addFinding(
        turn,
        rule,
        title,
        categories,
        {
          ...evidence,
          text: excerpt(clean.slice(Math.max(0, match.index - 80)), 700),
        },
        "日志包含阻塞信号；需检查上下文、后续恢复和触发条件，不能直接认定为缺陷或浪费。",
      );
    }
  }
  const group = turn.calls.get(call.key) ?? {
    count: 0,
    failures: 0,
    empty: 0,
    evidence: [],
    polling: call.polling,
  };
  group.count++;
  const content = clean
    .replace(/^Script completed\nWall time [^\n]*\nOutput:\n*/m, "")
    .trim();
  if (!content) group.empty++;
  if (
    !call.polling &&
    !call.sourceRead &&
    (result.failed || /^\s*(?:Error:|error:|Script error:)/m.test(clean))
  )
    group.failures++;
  if (group.evidence.length < 4) group.evidence.push(evidence);
  turn.calls.set(call.key, group);
}

export function addFinding(turn, rule, title, categories, evidence, reason) {
  const existing = turn.findings.find((finding) => finding.rule === rule);
  if (existing) {
    existing.occurrences++;
    if (existing.evidence.length < 4) existing.evidence.push(evidence);
    return;
  }
  turn.findings.push({
    rule,
    title,
    categories,
    status: "candidate",
    occurrences: 1,
    reason,
    evidence: [evidence],
  });
}

export function finishFindings(turn) {
  for (const group of turn.calls.values()) {
    if (group.failures >= 2) {
      addFinding(
        turn,
        "repeated-failure",
        "相同操作多次失败",
        ["Agent 行为", "代码", "工具", "环境"],
        group.evidence[0],
        `相同调用参数出现 ${group.failures} 次失败信号。环境可能已变化，需核对是否为必要重试。`,
      );
    }
    if (group.polling && group.count >= 5) {
      addFinding(
        turn,
        "polling",
        "等待期间多次唤醒",
        ["流程", "工具", "Agent 行为"],
        group.evidence[0],
        `相同轮询参数出现 ${group.count} 次，${group.empty} 次未见新输出。这可能是正常等待，不等于重复失败。`,
      );
    }
  }
  return turn.findings;
}
