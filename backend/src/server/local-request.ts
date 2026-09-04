import type { IncomingMessage } from "node:http";

const LOCAL_ONLY_FORWARDED_HEADER_NAMES = [
  "cf-connecting-ip",
  "cf-ray",
  "forwarded",
  "via",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
] as const;

export function isLoopbackAddress(address: string | undefined): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

export function hasForwardedRequestHeaders(
  request: Pick<IncomingMessage, "headers">,
): boolean {
  return LOCAL_ONLY_FORWARDED_HEADER_NAMES.some(
    (headerName) => request.headers[headerName] !== undefined,
  );
}

export function isLocalDirectHttpRequest(
  request: Pick<IncomingMessage, "headers" | "socket">,
): boolean {
  return (
    isLoopbackAddress(request.socket.remoteAddress) &&
    !hasForwardedRequestHeaders(request)
  );
}
