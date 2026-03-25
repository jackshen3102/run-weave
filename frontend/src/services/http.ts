export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

function buildUrl(apiBase: string, path: string): string {
  return `${apiBase}${path}`;
}

export async function requestText(
  apiBase: string,
  path: string,
  init?: RequestInit,
): Promise<string> {
  const response = await fetch(buildUrl(apiBase, path), init);

  if (!response.ok) {
    throw new HttpError(
      response.status,
      `${init?.method ?? "GET"} ${path} failed: ${response.status}`,
    );
  }

  return response.text();
}

export async function requestJson<T>(
  apiBase: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(buildUrl(apiBase, path), init);

  if (!response.ok) {
    throw new HttpError(
      response.status,
      `${init?.method ?? "GET"} ${path} failed: ${response.status}`,
    );
  }

  return (await response.json()) as T;
}

export async function requestVoid(
  apiBase: string,
  path: string,
  init?: RequestInit,
): Promise<void> {
  const response = await fetch(buildUrl(apiBase, path), init);

  if (!response.ok) {
    throw new HttpError(
      response.status,
      `${init?.method ?? "GET"} ${path} failed: ${response.status}`,
    );
  }
}
