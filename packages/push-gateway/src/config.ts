import { readFileSync } from "node:fs";
import { createPrivateKey } from "node:crypto";
export function configuration() {
  const {
    APNS_KEY_ID,
    APNS_TEAM_ID,
    APNS_PRIVATE_KEY_FILE,
    PUSH_GATEWAY_DATA_DIR,
  } = process.env;
  if (
    !APNS_KEY_ID ||
    !APNS_TEAM_ID ||
    !APNS_PRIVATE_KEY_FILE ||
    !PUSH_GATEWAY_DATA_DIR
  ) {
    throw new Error(
      "Configure APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY_FILE and PUSH_GATEWAY_DATA_DIR",
    );
  }
  return {
    keyId: APNS_KEY_ID,
    teamId: APNS_TEAM_ID,
    key: createPrivateKey(readFileSync(APNS_PRIVATE_KEY_FILE)),
    directory: PUSH_GATEWAY_DATA_DIR,
    topic: "com.runweave.app.native",
    port: Number(process.env.PUSH_GATEWAY_PORT ?? 8092),
    bind: process.env.PUSH_GATEWAY_BIND ?? "127.0.0.1",
  };
}
export type APNsConfiguration = Pick<
  ReturnType<typeof configuration>,
  "keyId" | "teamId" | "key" | "topic"
>;
