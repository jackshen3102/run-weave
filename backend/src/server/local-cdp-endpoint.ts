import type express from "express";

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

function hasForwardedHeaders(req: express.Request): boolean {
  return LOCAL_ONLY_FORWARDED_HEADER_NAMES.some(
    (headerName) => req.headers[headerName] !== undefined,
  );
}

function isLoopbackAddress(address: string | undefined): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

export function isLocalDirectRequest(req: express.Request): boolean {
  return (
    isLoopbackAddress(req.socket.remoteAddress) && !hasForwardedHeaders(req)
  );
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost"
  );
}

export function isValidLocalCdpEndpoint(endpoint: string): boolean {
  try {
    const parsed = new URL(endpoint);
    return (
      parsed.protocol === "http:" &&
      isLoopbackHostname(parsed.hostname) &&
      parsed.port !== "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}
