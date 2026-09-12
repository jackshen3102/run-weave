import {
  access,
  copyFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const marker = "Runweave managed Pi extension";
const legacyMarker = "export default function runweave(pi:";
export const bridgeAssets = [
  "app-server-client.cjs",
  "runweave-hook-bridge.cjs",
  "runweave-hook-payload.cjs",
  "feishu_stop_notify.sh",
];
const exists = async (file) => {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
};
const read = async (file) =>
  (await exists(file)) ? readFile(file, "utf8") : null;

/** Both desktop and development installs use the same ownership and upgrade rules. */
export async function installPi({ agentDir, assetsDir }) {
  if (!(await exists(agentDir))) return { status: "absent" };
  const targetDir = path.join(agentDir, "extensions", "runweave");
  const target = path.join(targetDir, "index.ts");
  const previous = await read(target);
  if (
    previous !== null &&
    !previous.includes(marker) &&
    !previous.includes(legacyMarker)
  )
    return { status: "unmanaged" };
  // Read the entire release before changing any installed files.
  const content = await readFile(path.join(assetsDir, "runweave.js"), "utf8");
  const skill = await readFile(path.join(assetsDir, "SKILL.md"), "utf8");
  const assets = await Promise.all(
    bridgeAssets.map(async (name) => [
      name,
      await readFile(path.join(assetsDir, "bridge", name), "utf8"),
    ]),
  );
  await mkdir(path.join(targetDir, "bridge"), { recursive: true });
  if (
    previous !== null &&
    previous !== content &&
    !(await exists(`${target}.runweave-hook-backup`))
  )
    await copyFile(target, `${target}.runweave-hook-backup`);
  for (const [name, value] of assets)
    await replace(path.join(targetDir, "bridge", name), value);
  await replace(target, content);
  const skillTarget = path.join(agentDir, "skills", "runweave", "SKILL.md");
  const previousSkill = await read(skillTarget);
  if (
    previousSkill === null ||
    previousSkill.includes("Runweave Pi integration")
  ) {
    await mkdir(path.dirname(skillTarget), { recursive: true });
    await replace(skillTarget, skill);
  }
  return { status: previous === content ? "unchanged" : "installed" };
}

async function replace(target, content) {
  if ((await read(target)) === content) return;
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, target);
}
