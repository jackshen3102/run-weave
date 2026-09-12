import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAgentAssets } from "./build.mjs";
import { installPi } from "../../packages/agent-bridge/src/install-pi.mjs";

await buildAgentAssets();
console.log(
  await installPi({
    agentDir:
      process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi/agent"),
    assetsDir: fileURLToPath(new URL("../../plugins/pi/dist", import.meta.url)),
  }),
);
