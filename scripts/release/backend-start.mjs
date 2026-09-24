import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(path.join(root, "manifest.json"), "utf8"),
);
if (
  manifest.platform !== process.platform ||
  manifest.arch !== process.arch ||
  manifest.nodeModuleAbi !== process.versions.modules
) {
  throw new Error(
    `Backend release target ${manifest.platform}/${manifest.arch}/ABI ${manifest.nodeModuleAbi} does not match ${process.platform}/${process.arch}/ABI ${process.versions.modules}`,
  );
}

const backendDir = path.join(root, "backend");
process.env.FRONTEND_DIST_DIR = path.join(root, "frontend", "dist");
process.env.RUNWEAVE_ACTIVITY_WORKER_ENTRY = path.join(
  backendDir,
  "activity-sqlite-worker.cjs",
);
process.env.RUNWEAVE_EVOLUTION_WORKER_ENTRY = path.join(
  backendDir,
  "evolution-sqlite-worker.cjs",
);
process.env.RUNWEAVE_SCHEDULED_TASKS_WORKER_ENTRY = path.join(
  backendDir,
  "scheduled-tasks-sqlite-worker.cjs",
);
process.env.RUNWEAVE_BETTER_SQLITE3_PACKAGE_DIR = path.join(
  backendDir,
  "node_modules",
  "better-sqlite3",
);
process.env.RUNWEAVE_BETTER_SQLITE3_NATIVE_BINDING = path.join(
  process.env.RUNWEAVE_BETTER_SQLITE3_PACKAGE_DIR,
  "prebuilds",
  manifest.sqlitePrebuild,
);
process.env.RUNWEAVE_NODE_PTY_DIR = path.join(
  backendDir,
  "node_modules",
  "node-pty",
);

createRequire(import.meta.url)(path.join(backendDir, "index.cjs"));
