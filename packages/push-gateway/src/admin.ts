import { randomBytes } from "node:crypto";
import { GatewayStore } from "./store";
import { hash, identifier } from "./auth";
const [command, hostId, environment] = process.argv.slice(2);
if (command === "status") {
  const url = process.env.PUSH_GATEWAY_ADMIN_URL ?? "http://127.0.0.1:8092";
  const response = await fetch(`${url}/admin/status`, {
    headers: {
      Authorization: `Bearer ${process.env.PUSH_GATEWAY_ADMIN_TOKEN ?? ""}`,
    },
  });
  if (!response.ok) throw new Error(`Status failed (${response.status})`);
  process.stdout.write(`${JSON.stringify(await response.json(), null, 2)}\n`);
} else {
  if (
    !process.env.PUSH_GATEWAY_DATA_DIR ||
    !identifier(hostId) ||
    !["add-host", "revoke-host"].includes(command ?? "")
  ) {
    throw new Error(
      "Stop gateway; set PUSH_GATEWAY_DATA_DIR; admin add-host <hostId> <sandbox|production> or revoke-host <hostId>",
    );
  }
  const store = new GatewayStore(process.env.PUSH_GATEWAY_DATA_DIR);
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
  }
}
