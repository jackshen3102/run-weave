import { settingText, resolveConfigurationContext, acquireConfigurationOwner, configurationOption } from "@runweave/config-node";
import { randomBytes } from "node:crypto";
import { GatewayStore } from "./store";
import { hash, identifier } from "./auth";
const [command, hostId, environment] = process.argv.slice(2);
if (command === "status") {
  const url = configurationOption("url") ?? `http://127.0.0.1:${settingText("services.pushGateway.port") ?? "8092"}`;
  const response = await fetch(`${url}/admin/status`, {
    headers: {
      Authorization: `Bearer ${settingText("services.pushGateway.adminToken") ?? ""}`,
    },
  });
  if (!response.ok) throw new Error(`Status failed (${response.status})`);
  process.stdout.write(`${JSON.stringify(await response.json(), null, 2)}\n`);
} else {
  if (
    !settingText("services.pushGateway.directory") ||
    !identifier(hostId) ||
    !["add-host", "revoke-host"].includes(command ?? "")
  ) {
    throw new Error(
      "Stop gateway; configure services.pushGateway.directory and specify --instance; admin add-host <hostId> <sandbox|production> or revoke-host <hostId>",
    );
  }
  const owner = acquireConfigurationOwner(resolveConfigurationContext({ requireExplicit: true }), "push-gateway");
  const store = new GatewayStore(settingText("services.pushGateway.directory")!);
  try {
    if (command === "add-host") {
      if (environment !== "sandbox" && environment !== "production")
        throw new Error("Choose sandbox or production explicitly");
      const token = randomBytes(32).toString("base64url");
      store.update((data) => {
        data.senders[hash(token)] = { hostId, environments: [environment] };
      });
      process.stdout.write(
        `Store this sender credential privately; it is shown only once:\n${token}\n`,
      );
    } else {
      store.update((data) => {
        for (const sender of Object.values(data.senders))
          if (sender.hostId === hostId) sender.revoked = true;
      });
      process.stdout.write("Host sender credentials revoked\n");
    }
  } finally {
    store.close();
    owner.release();
  }
}
