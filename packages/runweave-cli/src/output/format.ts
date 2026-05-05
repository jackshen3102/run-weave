export type OutputMode = "json" | "plain";

export function tailLines(value: string, lineCount: number): string {
  if (lineCount <= 0) {
    return "";
  }
  const lines = value.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") {
    lines.pop();
  }
  return lines.slice(-lineCount).join("\n");
}

export function writeOutput(
  stdout: Pick<NodeJS.WriteStream, "write">,
  mode: OutputMode,
  payload: unknown,
): void {
  if (mode === "json") {
    stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  stdout.write(`${String(payload)}${String(payload).endsWith("\n") ? "" : "\n"}`);
}
