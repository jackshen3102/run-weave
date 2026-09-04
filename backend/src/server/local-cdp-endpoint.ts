import type express from "express";
import { isLocalDirectHttpRequest } from "./local-request";

export function isLocalDirectRequest(req: express.Request): boolean {
  return isLocalDirectHttpRequest(req);
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname === "localhost"
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
