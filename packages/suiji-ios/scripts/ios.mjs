import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const [command, ...raw] = process.argv.slice(2);
const args = raw.filter((arg) => arg !== "--");
try {
  {
    const result = spawnSync(
      "python3",
      [
        "-B",
        fileURLToPath(
          new URL("../../../scripts/ios-simulators/pool.py", import.meta.url),
        ),
        command || "doctor",
        "--app",
        "suiji",
        ...args,
      ],
      { stdio: "inherit", cwd: fileURLToPath(new URL("..", import.meta.url)) },
    );
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
