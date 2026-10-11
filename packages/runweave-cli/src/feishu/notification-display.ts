/** Shorten the Hook's generated header; keep the answer and routing IDs intact. */
export function formatFeishuNotification(
  text: string,
  terminalSessionId: string,
  displayName?: string,
): string {
  const machine = displayName?.trim().replace(/\s+/g, " ");
  const header = /^路径: ([^\r\n]+)\r?\n\r?\n/.exec(text);
  const source = header?.[1];
  const suffix = `(${terminalSessionId})`;
  if (!header || !source?.endsWith(suffix))
    return machine ? `${machine}\n\n${text}` : text;

  const directory = source
    .slice(0, -suffix.length)
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  const project = directory.split("/").pop();
  const title = [machine, project].filter(Boolean).join(" · ");
  const answer = text.slice(header[0].length);
  return title ? `${title}\n\n${answer}` : answer;
}
