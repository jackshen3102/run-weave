#!/usr/bin/env node

import { DevSessionError } from "./contracts.mjs";
import { inspectBetaPool, recoverBetaPoolSlot } from "./beta-slot-pool.mjs";

function parseArgs(argv) {
  const command = argv[0] === "recover" ? "recover" : "status";
  const args = command === "recover" ? argv.slice(1) : argv;
  const options = { command, json: false, slotId: null, sessionId: null };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (["--force", "--force-kill", "--force-release"].includes(arg)) {
      throw new DevSessionError(`${arg} is not supported`, 2);
    }
    const key = new Map([
      ["--slot", "slotId"],
      ["--session", "sessionId"],
    ]).get(arg);
    if (!key) {
      throw new DevSessionError(`unknown argument: ${arg}`, 2);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new DevSessionError(`missing value for ${arg}`, 2);
    }
    options[key] = value;
    index += 1;
  }
  return options;
}

function printProjection(projection, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(projection, null, 2)}\n`);
    return;
  }
  const rows = projection.slots.map((slot) => ({
    slot: slot.slotId,
    state: slot.derivedState,
    owner: slot.lease.owner?.sessionId ?? "-",
    owned: slot.runtime.ownedHealth,
    recovery: slot.recovery.mode,
    blocker: slot.recovery.blockedBy[0] ?? "-",
  }));
  console.table(rows);
  process.stdout.write(
    `Storage ${projection.storage.mode}: ${projection.storage.effectiveRoot ?? "conflict"}\n` +
      `Observed ${projection.observedAt}; this snapshot does not reserve capacity.\n`,
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "recover") {
    if (!options.slotId) {
      throw new DevSessionError("recover requires --slot", 2);
    }
    const receipt = await recoverBetaPoolSlot({
      slotId: options.slotId,
      sessionId: options.sessionId,
    });
    const result = { ok: receipt.result === "recovered", receipt };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) {
      process.exitCode = 5;
    }
    return;
  }
  printProjection(await inspectBetaPool(), options.json);
}

main().catch((error) => {
  const exitCode = error instanceof DevSessionError ? error.exitCode : 1;
  process.stderr.write(
    `${JSON.stringify(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        exitCode,
        ...(error instanceof DevSessionError && error.details
          ? { details: error.details }
          : {}),
      },
      null,
      2,
    )}\n`,
  );
  process.exit(exitCode);
});
