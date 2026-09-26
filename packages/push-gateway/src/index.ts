import { acquireConfigurationOwner, configuration as runtimeConfiguration, settingText } from "@runweave/config-node";
import { configuration } from "./config";
import { GatewayStore } from "./store";
import { createGateway } from "./app";
import { createAPNsTransport } from "./apns";
const config = configuration();
const owner = acquireConfigurationOwner(runtimeConfiguration().context, "push-gateway");
const store = new GatewayStore(config.directory);
const server = createGateway(
  store,
  createAPNsTransport(config),
  settingText("services.pushGateway.adminToken"),
);
server.listen(config.port, config.bind, () =>
  process.stdout.write("Push gateway ready\n"),
);
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  server.close(() => {
    store.close();
    owner.release();
    process.exit(0);
  });
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
