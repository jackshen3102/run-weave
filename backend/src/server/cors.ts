import type { RequestHandler } from "express";
import net from "node:net";
import os from "node:os";

const ALWAYS_ALLOWED_APP_ORIGINS = new Set([
  "runweave://app",
  "browser-viewer://app",
  "capacitor://localhost",
  "ionic://localhost",
]);
const LOCAL_DEV_SERVER_PORTS = new Set(["5173", "5174"]);

function getLocalInterfaceHosts(): Set<string> {
  const hosts = new Set(["localhost", "127.0.0.1", "::1"]);
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" || address.family === "IPv6") {
        hosts.add(address.address);
      }
    }
  }
  return hosts;
}

function isPrivateIpv4Host(hostname: string): boolean {
  const parts = hostname.split(".").map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }

  const first = parts[0] ?? -1;
  const second = parts[1] ?? -1;
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
}

function isPrivateIpv6Host(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:")
  );
}

function isAllowedDevServerHost(hostname: string): boolean {
  if (getLocalInterfaceHosts().has(hostname)) {
    return true;
  }
  if (net.isIP(hostname) === 4) {
    return isPrivateIpv4Host(hostname);
  }
  if (net.isIP(hostname) === 6) {
    return isPrivateIpv6Host(hostname);
  }
  return false;
}

function isAllowedLocalOrigin(origin: string): boolean {
  if (ALWAYS_ALLOWED_APP_ORIGINS.has(origin)) {
    return true;
  }
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:") {
      return false;
    }
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
      return true;
    }
    return (
      LOCAL_DEV_SERVER_PORTS.has(parsed.port) &&
      isAllowedDevServerHost(parsed.hostname)
    );
  } catch {
    return false;
  }
}

export function createCorsMiddleware(
  configuredOrigins: string[],
): RequestHandler {
  const allowedOrigins = new Set(configuredOrigins);
  const allowedHeaders = [
    "Content-Type",
    "Authorization",
    "X-Auth-Client",
    "X-Connection-Id",
  ];

  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (allowedOrigins.has(origin) || isAllowedLocalOrigin(origin))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }

    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    );
    res.setHeader("Access-Control-Allow-Headers", allowedHeaders.join(","));

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    next();
  };
}
