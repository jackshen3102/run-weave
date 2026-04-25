export type TerminalBrowserUrlResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

export function normalizeTerminalBrowserUrl(input: string): TerminalBrowserUrlResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, error: "Enter a URL" };
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return validateHttpUrl(trimmed);
  }

  if (/^\d+$/.test(trimmed)) {
    const port = Number(trimmed);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, error: "Port must be between 1 and 65535" };
    }
    return validateHttpUrl(`http://127.0.0.1:${trimmed}`);
  }

  if (/^(localhost|127(?:\.\d{1,3}){3}|\[::1\]):\d{1,5}(\/.*)?$/i.test(trimmed)) {
    return validateHttpUrl(`http://${trimmed}`);
  }

  return validateHttpUrl(`https://${trimmed}`);
}

function validateHttpUrl(input: string): TerminalBrowserUrlResult {
  try {
    const parsed = new URL(input);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, error: "Only http and https URLs are supported" };
    }
    return { ok: true, url: parsed.toString() };
  } catch {
    return { ok: false, error: "Enter a valid http or https URL" };
  }
}
