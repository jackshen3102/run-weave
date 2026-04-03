import path from "node:path";

type ResolutionResult =
  | { status: "ok"; filePath: string }
  | { status: "forbidden" };

function looksLikeStaticAsset(filePath: string): boolean {
  return path.posix.basename(filePath).includes(".");
}

export function resolveProtocolFilePath(
  requestUrl: string,
  rendererDist: string,
): ResolutionResult {
  const url = new URL(requestUrl);
  const requestPath = url.pathname || "/";
  const decodedRequestPath = decodeURIComponent(requestPath);
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

  if (fullPath !== rendererRoot && !fullPath.startsWith(`${rendererRoot}${path.sep}`)) {
    return { status: "forbidden" };
  }

  return { status: "ok", filePath: fullPath };
}
