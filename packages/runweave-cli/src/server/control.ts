import { createConnection } from "node:net";
import { readFileSync } from "node:fs";
import path from "node:path";
import { controlSocket, type ServerContext } from "./context.js";

export async function foregroundControl(
  ctx: ServerContext,
  action: "stop" | "restart" | "pause",
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const client = createConnection(controlSocket(ctx));
    let data = "";
    client.setTimeout(130_000, () =>
      client.destroy(new Error("Foreground control timed out")),
    );
    client.on("error", reject);
    client.on("connect", () =>
      client.write(
        JSON.stringify({
          action,
          token: readFileSync(
            path.join(ctx.home, "management-token"),
            "utf8",
          ).trim(),
        }) + "\n",
      ),
    );
    client.on("data", (chunk) => {
      data += chunk.toString();
    });
    client.on("end", () => {
      try {
        const result = JSON.parse(data) as { error?: string };
        if (result.error) reject(new Error(result.error));
        else resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

