import path from "node:path";

type ResolutionResult =
  | { status: "ok"; filePath: string }
  | { status: "forbidden" };

function looksLikeStaticAsset(filePath: string): boolean {
  return path.posix.basename(filePath).includes(".");
}

function readRawPath(requestUrl: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/i.exec(requestUrl);
  return match?.[1] || "/";
}

function decodeUrlPath(urlPath: string): string | null {
  try {
    return decodeURIComponent(urlPath);
  } catch {
    return null;
  }
}

export function resolveProtocolFilePath(
  requestUrl: string,
  rendererDist: string,
): ResolutionResult {
  const url = new URL(requestUrl);
  const rawRequestPath = readRawPath(requestUrl);
  const requestPath = url.pathname || "/";
  const decodedRequestPath = decodeUrlPath(rawRequestPath);
  if (!decodedRequestPath) {
    return { status: "forbidden" };
  }
  if (
    decodedRequestPath === ".." ||
    decodedRequestPath.startsWith("../") ||
    decodedRequestPath.includes("/../")
  ) {
    return { status: "forbidden" };
  }
  const normalizedUrlPath = path.posix.normalize(decodedRequestPath);
  if (
    normalizedUrlPath === ".." ||
    normalizedUrlPath.startsWith("../") ||
    normalizedUrlPath.includes("/../")
  ) {
    return { status: "forbidden" };
  }
  const normalizedRequestPath =
    requestPath === "/" || requestPath === ""
      ? "/index.html"
      : looksLikeStaticAsset(requestPath)
        ? requestPath
        : "/index.html";

  const rendererRoot = path.resolve(rendererDist);
  const fullPath = path.resolve(rendererRoot, `.${normalizedRequestPath}`);

  if (
    fullPath !== rendererRoot &&
    !fullPath.startsWith(`${rendererRoot}${path.sep}`)
  ) {
    return { status: "forbidden" };
  }

  return { status: "ok", filePath: fullPath };
}
