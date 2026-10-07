import ts from "typescript";
import path from "node:path";

const PATHS =
  /["']([^"'\r\n]*\/SKILL\.md)["']|([^\s"'`<>;(){}\\]+\/SKILL\.md)\b/g;

export function skillPaths(text) {
  return [
    ...new Set(
      [...String(text).matchAll(PATHS)].flatMap((m) => {
        const file = m[1] ?? m[2];
        return /^(?:[/.~]|[\w.-]+\/)/.test(file) ? [file] : [];
      }),
    ),
  ];
}

// Keep plugin identity, but discard cache versions and installation directories.
export function skillIdentity(file, declaredName) {
  const directory = path.posix.basename(path.posix.dirname(file));
  const name = declaredName?.split(":").at(-1) ?? directory;
  const plugin =
    file.match(/\/plugins\/cache\/[^/]+\/([^/]+)\//)?.[1] ??
    file.match(/(?:^|\/)plugins\/([^/]+)\/skills\//)?.[1];
  return { id: plugin ? `${plugin}:${name}` : name, name };
}

export function injectedSkills(text) {
  const match = text
    .trim()
    .match(
      /^<skill>\s*<name>([^<>\r\n]+)<\/name>\s*<path>([^<>\r\n]+\/SKILL\.md)<\/path>\s*([\s\S]+)<\/skill>$/,
    );
  if (!match || !bodyNames(match[3]).includes(match[1].split(":").at(-1)))
    return [];
  return [{ path: match[2], ...skillIdentity(match[2], match[1]) }];
}

function bodyNames(text) {
  return [
    ...text.matchAll(/(?:^|\n)---\r?\n([\s\S]*?)\r?\n---\r?\n(?=\s*\S)/g),
  ].flatMap((match) => {
    const name = match[1].match(/^name:\s*["']?([\w.:-]+)["']?\s*$/m);
    return name ? [name[1]] : [];
  });
}

function literal(node) {
  return node &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;
}

// Parse nested functions.exec as data. Never evaluate historical JavaScript.
function commands(payload) {
  const raw = payload.arguments ?? payload.input ?? "";
  try {
    const args = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (typeof args?.cmd === "string") return [args.cmd];
    if (typeof args?.command === "string") return [args.command];
  } catch {
    /* Free-form functions.exec input. */
  }
  if (typeof raw !== "string") return [];
  const found = [];
  const source = ts.createSourceFile(
    "log.js",
    raw,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "exec_command" &&
      node.arguments[0] &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      for (const field of node.arguments[0].properties) {
        if (
          ts.isPropertyAssignment(field) &&
          field.name.getText(source).replace(/["']/g, "") === "cmd"
        ) {
          const value = literal(field.initializer);
          if (value !== undefined) found.push(value);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function shellSegments(command) {
  // Unsupported expansion, heredocs and comments stay candidates, never proof.
  if (/<<|\$\(|`|(?:^|\s)#|&&|\|\|/.test(command)) return null;
  const tokens =
    command.match(/"(?:\\.|[^"\\])*"|'[^']*'|&&|\|\||[;\n|<>]|[^\s;|<>]+/g) ??
    [];
  const segments = [];
  let current = [],
    start = null;
  for (const token of tokens) {
    if ([";", "\n", "&&", "||", "|", "<", ">"].includes(token)) {
      segments.push({ tokens: current, start, end: token });
      current = [];
      start = token;
    } else current.push(token.replace(/^(["'])([\s\S]*)\1$/, "$2"));
  }
  segments.push({ tokens: current, start, end: null });
  return segments;
}

export function callSkills(payload) {
  const rawInput = payload.arguments ?? payload.input ?? "";
  if (
    !(
      typeof rawInput === "string" ? rawInput : JSON.stringify(rawInput)
    ).includes("SKILL.md")
  )
    return [];
  const result = new Map();
  const extracted = commands(payload);
  for (const command of extracted) {
    const segments = shellSegments(command);
    for (const file of skillPaths(command)) {
      let kind = "candidate";
      const aliasSafe =
        extracted.length === 1 &&
        segments?.every(
          (s) =>
            !s.tokens.length ||
            (s.tokens[0] === "cat" &&
              s.tokens
                .slice(1)
                .every((t) => t === "--" || t.endsWith("/SKILL.md"))),
        );
      const related = segments?.filter((s) =>
        s.tokens.some((t) => t.includes(file)),
      );
      if (related?.length) {
        if (
          related.every(
            (s) =>
              /^(?:rg|grep|find|ls|echo|printf|rm|mv|cp|touch|tee)$/.test(
                s.tokens[0],
              ) ||
              s.start === ">" ||
              s.end === ">" ||
              (s.tokens[0] === "sed" &&
                s.tokens.some((t) => t.startsWith("-i"))),
          )
        )
          continue;
        if (
          related.some(
            (s) =>
              s.tokens[0] === "cat" &&
              s.tokens.includes(file) &&
              s.tokens
                .slice(1)
                .every((t) => !t.startsWith("-") || t === "--") &&
              !["|", "<", ">"].includes(s.end),
          )
        )
          kind = "read";
      }
      const previous = result.get(file);
      if (!previous || kind === "read")
        result.set(file, {
          path: file,
          kind,
          aliasSafe,
          ...skillIdentity(file),
        });
    }
  }
  // Non-shell readers remain candidates; edit/search tools do not imply use.
  if (
    !result.size &&
    /read_file|read_text|open_file|skills.*read/.test(payload.name ?? "")
  ) {
    const raw = payload.arguments ?? payload.input ?? "";
    if (!extracted.length)
      for (const file of skillPaths(
        typeof raw === "string" ? raw : JSON.stringify(raw),
      ))
        result.set(file, {
          path: file,
          kind: "candidate",
          ...skillIdentity(file),
        });
  }
  return [...result.values()];
}

export function successfulBodies(output) {
  const bodies = [];
  let truncated = false,
    failed = false;
  const visit = (value, depth = 0) => {
    if (depth > 20) return;
    if (typeof value === "string") {
      failed ||= /Process exited with code [1-9]\d*\b/.test(value);
      truncated ||= /Warning: truncated output|\[截断\]|Output truncated/.test(
        value,
      );
      try {
        visit(JSON.parse(value), depth + 1);
      } catch {
        // functions.exec can print several independent JSON result envelopes.
        for (const line of value.split("\n")) {
          if (line.startsWith("{")) {
            try {
              visit(JSON.parse(line), depth + 1);
            } catch {
              /* Plain output. */
            }
          }
        }
        if (/Process exited with code 0\b/.test(value)) bodies.push(value);
      }
    } else if (Array.isArray(value)) value.forEach((v) => visit(v, depth + 1));
    else if (value && typeof value === "object") {
      if (
        value.isError === true ||
        value.ok === false ||
        value.status === "rejected" ||
        (Number.isInteger(value.exit_code) && value.exit_code !== 0)
      ) {
        failed = true;
        return;
      }
      if (value.exit_code === 0 && typeof value.output === "string")
        bodies.push(value.output);
      for (const key of ["output", "text", "value", "result", "content"])
        if (key in value) visit(value[key], depth + 1);
    }
  };
  visit(output);
  return truncated || failed ? [] : bodies.flatMap(bodyNames);
}
