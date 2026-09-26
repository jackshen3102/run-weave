import { settingText, configuration as runtimeConfiguration } from "@runweave/config-node";
import { readFileSync } from "node:fs";
import { createPrivateKey } from "node:crypto";
export function configuration() {
  runtimeConfiguration().requireDomain("services.pushGateway");
  const APNS_KEY_ID = settingText("services.pushGateway.keyId");
  const APNS_TEAM_ID = settingText("services.pushGateway.teamId");
  const APNS_PRIVATE_KEY_FILE = settingText("services.pushGateway.privateKeyFile");
  const PUSH_GATEWAY_DATA_DIR = settingText("services.pushGateway.directory");
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
    port: Number(settingText("services.pushGateway.port") ?? 8092),
    bind: settingText("services.pushGateway.bind") ?? "127.0.0.1",
  };
}
export type APNsConfiguration = Pick<
  ReturnType<typeof configuration>,
  "keyId" | "teamId" | "key" | "topic"
>;
