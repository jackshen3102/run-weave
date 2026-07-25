#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const OBSERVATIONS = new Set(["pass", "fail", "not_run"]);

function usage() {
  return [
    "Usage:",
    "  node classify-runtime-verdict.mjs --input=<file> [--output=<file>]",
    "",
    "The input contract is documented in references/contracts.md.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { input: null, output: null };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (arg.startsWith("--input=")) {
      options.input = path.resolve(arg.slice("--input=".length));
    } else if (arg.startsWith("--output=")) {
      options.output = path.resolve(arg.slice("--output=".length));
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!options.input) {
    throw new Error("--input is required");
  }
  return options;
}

function validateInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("input must be a JSON object");
  }
  if (typeof input.candidateId !== "string" || !input.candidateId.trim()) {
    throw new Error("candidateId must be a non-empty string");
  }
  if (
    !Number.isInteger(input.staticSevereVotes) ||
    input.staticSevereVotes < 0 ||
    input.staticSevereVotes > 3
  ) {
    throw new Error("staticSevereVotes must be an integer from 0 to 3");
  }
  if (!["established", "not_established"].includes(input.trigger)) {
    throw new Error("trigger must be established or not_established");
  }
  if (
    !OBSERVATIONS.has(input.targetObservation) ||
    !OBSERVATIONS.has(input.cleanObservation)
  ) {
    throw new Error(
      "targetObservation and cleanObservation must be pass, fail, or not_run",
    );
  }
  if (!["none", "severe"].includes(input.runtimeEvidenceDisagreement)) {
    throw new Error("runtimeEvidenceDisagreement must be none or severe");
  }
  if (
    !Array.isArray(input.evidenceRefs) ||
    input.evidenceRefs.length === 0 ||
    input.evidenceRefs.some((item) => typeof item !== "string" || !item.trim())
  ) {
    throw new Error("evidenceRefs must be an array of non-empty strings");
  }
}

function classify(input) {
  if (input.staticSevereVotes < 2) {
    return {
      verdict: "not_candidate",
      reason: "fewer than two independent severe static votes",
    };
  }
  if (input.trigger !== "established") {
    return {
      verdict: "inconclusive",
      reason: "the production trigger precondition could not be established",
    };
  }
  if (
    input.targetObservation === "not_run" ||
    input.cleanObservation === "not_run"
  ) {
    return {
      verdict: "inconclusive",
      reason: "the target and clean control were not both executed",
    };
  }
  if (input.runtimeEvidenceDisagreement === "severe") {
    return {
      verdict: "debate_required",
      reason: "models still seriously disagree about the runtime evidence",
    };
  }
  if (input.targetObservation === "fail" && input.cleanObservation === "pass") {
    return {
      verdict: "automatic_block",
      reason: "the target failed while the clean control passed",
    };
  }
  if (input.targetObservation === "pass" && input.cleanObservation === "pass") {
    return {
      verdict: "dismissed",
      reason:
        "a valid production trigger was executed and the target did not reproduce the candidate",
    };
  }
  return {
    verdict: "inconclusive",
    reason:
      "the clean control failed or the comparison was otherwise confounded",
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const input = JSON.parse(await readFile(options.input, "utf8"));
  validateInput(input);
  const result = {
    ...input,
    ...classify(input),
    classifiedAt: new Date().toISOString(),
  };
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (options.output) {
    await writeFile(options.output, output);
  }
  process.stdout.write(output);
}

await main();
