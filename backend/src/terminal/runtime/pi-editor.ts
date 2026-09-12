import { createHash } from "node:crypto";
import { request } from "node:http";
import path from "node:path";
import type {
  PiEditorRequest,
  PiEditorResponse,
} from "@runweave/shared/terminal/pi-agent";
import type { TmuxPaneTarget } from "../tmux/types";

/** Local-only control, in a uid-private directory. No fallback to destructive key sequences. */
export async function replacePiEditor(
  target: TmuxPaneTarget,
  input: PiEditorRequest,
): Promise<void> {
  const key = createHash("sha256")
    .update(`${target.socketPath}\0${target.paneId}`)
    .digest("hex")
    .slice(0, 24);
  const socketPath = path.join(
    "/tmp",
    `rw-pi-${process.getuid?.() ?? "user"}`,
    `${key}.sock`,
  );
  await new Promise<void>((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: "/editor",
        method: "POST",
        timeout: 3000,
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
          if (body.length > 8192) res.destroy();
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            const result = JSON.parse(body) as PiEditorResponse;
            if (res.statusCode !== 200 || result.applied !== true)
              throw new Error("Pi editor identity changed; draft was retained");
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("timeout", () =>
      req.destroy(new Error("Pi editor timed out; draft was retained")),
    );
    req.on("error", () =>
      reject(
        new Error(
          "Pi Runweave extension unavailable; reload Pi before sending this draft",
        ),
      ),
    );
    req.end(JSON.stringify(input));
  });
}
