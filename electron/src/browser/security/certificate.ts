import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import type { Certificate } from "electron";
import type { TerminalBrowserProfileId } from "@runweave/shared/terminal-browser-profile";
import { TerminalBrowserError } from "../errors.js";
import { getTerminalBrowserSession } from "../runtime.js";
import { getWhistleRootCa } from "../whistle/client.js";
import { getTerminalBrowserWhistleState } from "../whistle/runtime.js";

const installedFingerprints = new Map<TerminalBrowserProfileId, string>();

function normalizeFingerprint(value: string): string {
  return value.replaceAll(":", "").toUpperCase();
}

function chainContainsFingerprint(
  certificate: Certificate,
  expected: string,
): boolean {
  const visited = new Set<Certificate>();
  let current: Certificate | undefined = certificate;
  for (let depth = 0; current && depth < 16; depth += 1) {
    if (visited.has(current)) {
      break;
    }
    visited.add(current);
    if (normalizeFingerprint(current.fingerprint) === expected) {
      return true;
    }
    if (!current.issuerCert || current.issuerCert === current) {
      break;
    }
    current = current.issuerCert;
  }
  return false;
}

function certificateMatchesHostname(
  certificate: X509Certificate,
  hostname: string,
): boolean {
  return isIP(hostname)
    ? certificate.checkIP(hostname) !== undefined
    : certificate.checkHost(hostname) !== undefined;
}

function chainIsSignedByRoot(
  certificate: Certificate,
  root: X509Certificate,
  expectedFingerprint: string,
): boolean {
  const visited = new Set<Certificate>();
  let current: Certificate | undefined = certificate;
  for (let depth = 0; current && depth < 16; depth += 1) {
    if (visited.has(current)) {
      return false;
    }
    visited.add(current);
    if (normalizeFingerprint(current.fingerprint) === expectedFingerprint) {
      return true;
    }

    let parsed: X509Certificate;
    try {
      parsed = new X509Certificate(current.data);
    } catch {
      return false;
    }
    const issuer: Certificate | undefined = current.issuerCert;
    if (!issuer || issuer === current) {
      return parsed.verify(root.publicKey);
    }
    try {
      const parsedIssuer = new X509Certificate(issuer.data);
      if (!parsed.verify(parsedIssuer.publicKey)) {
        return false;
      }
    } catch {
      return false;
    }
    current = issuer;
  }
  return false;
}

export async function ensureTerminalBrowserCertificateTrust(
  profileId: TerminalBrowserProfileId,
): Promise<void> {
  try {
    const whistle = getTerminalBrowserWhistleState(profileId);
    if (whistle.status !== "ready") {
      throw new Error("Whistle is not ready");
    }
    const pem = await getWhistleRootCa(whistle.port);
    const root = new X509Certificate(pem);
    const fingerprint = normalizeFingerprint(root.fingerprint256);
    if (installedFingerprints.get(profileId) === fingerprint) {
      return;
    }
    getTerminalBrowserSession(profileId).setCertificateVerifyProc(
      (request, callback) => {
        let leaf: X509Certificate | null = null;
        try {
          leaf = new X509Certificate(request.certificate.data);
        } catch {
          callback(-3);
          return;
        }
        if (
          request.errorCode === -202 &&
          certificateMatchesHostname(leaf, request.hostname) &&
          (chainContainsFingerprint(request.certificate, fingerprint) ||
            chainContainsFingerprint(
              request.validatedCertificate,
              fingerprint,
            ) ||
            chainIsSignedByRoot(request.certificate, root, fingerprint) ||
            chainIsSignedByRoot(
              request.validatedCertificate,
              root,
              fingerprint,
            ))
        ) {
          callback(0);
          return;
        }
        callback(-3);
      },
    );
    installedFingerprints.set(profileId, fingerprint);
  } catch (error) {
    throw new TerminalBrowserError(
      "WHISTLE_CA_UNAVAILABLE",
      `Failed to install scoped Whistle certificate verification for ${profileId}`,
      {
        profileId,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
}
