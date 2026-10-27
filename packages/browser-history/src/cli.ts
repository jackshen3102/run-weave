import { parseArgs } from "node:util";
import path from "node:path";
import { defaultHistoryRoot } from "./files.js";
import { collectHistory, readHistory, historySources } from "./collect.js";
import { nativeInstall } from "./native-install.js";
async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || command === "--help") {
    console.log(
      "browser-history status | collect --from YYYY-MM-DD --to YYYY-MM-DD --out <new-dir> | read --bundle <dir> --id <id> --verify-source | native-install/native-uninstall --browser chrome|edge --extension-id <id> [--root <dir>] [--home <isolated-home>]",
    );
    return;
  }
  const options: Record<string, { type: "string" | "boolean" }> = {};
  for (const key of [
    "root",
    "from",
    "to",
    "timezone",
    "out",
    "bundle",
    "id",
    "browser",
    "extension-id",
    "home",
  ])
    options[key] = { type: "string" };
  options["verify-source"] = options.json = { type: "boolean" };
  const { values: v } = parseArgs({ args: argv, options });
  const arg = (key: string) => {
    const value = v[key];
    if (typeof value !== "string" || !value) throw Error("MISSING_" + key);
    return value;
  };
  const root =
    typeof v.root === "string" ? path.resolve(v.root) : defaultHistoryRoot();
  let result: unknown;
  if (command === "status")
    result = {
      root,
      coverage: "observed-only",
      sources: await historySources(root),
    };
  else if (command === "collect") {
    const r = await collectHistory(
      root,
      arg("from"),
      arg("to"),
      typeof v.timezone === "string" ? v.timezone : "Asia/Shanghai",
      arg("out"),
    );
    process.exitCode = r.exitCode;
    result = r;
  } else if (command === "read")
    result = await readHistory(
      arg("bundle"),
      arg("id"),
      v["verify-source"] === true,
    );
  else if (command === "native-install" || command === "native-uninstall")
    result = await nativeInstall({
      browser: arg("browser"),
      id: typeof v["extension-id"] === "string" ? v["extension-id"] : undefined,
      root,
      home: typeof v.home === "string" ? v.home : undefined,
      uninstall: command === "native-uninstall",
    });
  else throw Error("UNKNOWN_COMMAND");
  console.log(JSON.stringify(result, null, 2));
}
main().catch((e) => {
  console.error(
    JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
  );
  process.exitCode = 1;
});
