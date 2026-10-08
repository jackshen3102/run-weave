/** A persistent Backend profile identity, independent of process and release IDs. */
export interface ConnectionIdentity {
  version: 1;
  identityId: string;
  /** Raw Ed25519 public key, unpadded base64url. */
  publicKey: string;
}

export interface ConnectionProbeRequest {
  version: 1;
  /** 32 cryptographically random bytes, unpadded base64url. */
  nonce: string;
}

export interface ConnectionProbeResponse extends ConnectionIdentity {
  nonce: string;
  signature: string;
}

export function connectionProbeMessage(identityId: string, nonce: string): string {
  return `runweave-connection-probe-v1\n${identityId}\n${nonce}`;
}
