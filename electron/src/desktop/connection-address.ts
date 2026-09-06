import os from "node:os";

const EXCLUDED_INTERFACES =
  /^(?:lo|utun|awdl|llw|bridge|vboxnet|vmnet|docker)/iu;

export interface LocalConnectionAddresses {
  port: number | null;
  primary: string | null;
  candidates: string[];
  loopback: string | null;
}

export function resolveLocalConnectionAddresses(
  backendUrl: string,
): LocalConnectionAddresses {
  const port = readPort(backendUrl);
  const loopback = port ? `http://127.0.0.1:${port}` : null;
  if (!port) return { port: null, primary: null, candidates: [], loopback };

  const addresses: Array<{ name: string; address: string }> = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    if (EXCLUDED_INTERFACES.test(name)) continue;
    for (const entry of entries ?? []) {
      if (
        entry.family !== "IPv4" ||
        entry.internal ||
        !isUsableIpv4(entry.address)
      ) {
        continue;
      }
      addresses.push({ name, address: entry.address });
    }
  }
  addresses.sort(
    (left, right) =>
      interfacePriority(left.name) - interfacePriority(right.name) ||
      left.name.localeCompare(right.name) ||
      left.address.localeCompare(right.address),
  );
  const candidates = addresses.map(
    ({ address }) => `http://${address}:${port}`,
  );
  return {
    port,
    primary: candidates[0] ?? null,
    candidates,
    loopback,
  };
}

function readPort(backendUrl: string): number | null {
  try {
    const parsed = new URL(backendUrl);
    const port = Number(
      parsed.port || (parsed.protocol === "https:" ? 443 : 80),
    );
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
  } catch {
    return null;
  }
}

function isUsableIpv4(address: string): boolean {
  return !address.startsWith("127.") && !address.startsWith("169.254.");
}

function interfacePriority(name: string): number {
  if (name === "en0") return 0;
  if (/^en\d+$/u.test(name)) return 1;
  return 2;
}
