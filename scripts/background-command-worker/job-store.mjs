import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const UPDATE_JOB_SCHEMA_VERSION = 1;
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

function assertId(value, name) {
  if (typeof value !== "string" || !ID_PATTERN.test(value))
    throw new Error(`Invalid ${name}`);
  return value;
}

export function jobDirectory(root, runId) {
  return path.join(path.resolve(root), assertId(runId, "runId"));
}

function validateDescriptor(value) {
  if (
    value?.schemaVersion !== UPDATE_JOB_SCHEMA_VERSION ||
    value.jobId !== value.runId ||
    typeof value.ownerNonce !== "string" ||
    !/^[a-f0-9]{32,128}$/.test(value.ownerNonce) ||
    value.skillId !== "toolkit:update-runweave-desktop" ||
    !["stable", "beta"].includes(value.target?.channel) ||
    (value.target.channel === "beta" &&
      (typeof value.target.instanceId !== "string" ||
        !ID_PATTERN.test(value.target.instanceId))) ||
    (value.target.channel === "stable" && value.target.instanceId !== null) ||
    typeof value.sourceCwd !== "string" ||
    !path.isAbsolute(value.sourceCwd) ||
    !value.project ||
    typeof value.project.name !== "string" ||
    !value.project.name.trim() ||
    !value.provider ||
    value.provider.kind !== "codex" ||
    typeof value.provider.model !== "string" ||
    !value.provider.model.trim()
  )
    throw new Error("Invalid update job descriptor");
  assertId(value.runId, "runId");
  return value;
}

async function writeExclusive(file, value) {
  const handle = await fs.open(file, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readJson(file) {
  const stat = await fs.lstat(file);
  if (
    !stat.isFile() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error("Update job file is not private");
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function assertPrivateDirectory(directory) {
  const stat = await fs.lstat(directory);
  if (
    !stat.isDirectory() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error("Update job directory is not private");
}

export async function prepareJob(root, descriptor) {
  const validated = validateDescriptor(descriptor);
  const directory = jobDirectory(root, validated.runId);
  await fs.mkdir(path.resolve(root), { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(path.resolve(root));
  await fs.mkdir(directory, { mode: 0o700 });
  try {
    await writeExclusive(path.join(directory, "descriptor.json"), validated);
  } catch (error) {
    await fs.rmdir(directory).catch(() => undefined);
    throw error;
  }
  return directory;
}

export async function readDescriptor(root, runId) {
  await assertPrivateDirectory(path.resolve(root));
  await assertPrivateDirectory(jobDirectory(root, runId));
  const descriptor = validateDescriptor(
    await readJson(path.join(jobDirectory(root, runId), "descriptor.json")),
  );
  if (descriptor.runId !== runId)
    throw new Error("Update job identity mismatch");
  return descriptor;
}

export async function claimJob(root, runId, ownerNonce, processIdentity) {
  const descriptor = await readDescriptor(root, runId);
  if (descriptor.ownerNonce !== ownerNonce)
    throw new Error("Update job owner mismatch");
  if (
    !Number.isSafeInteger(processIdentity?.pid) ||
    processIdentity.pid <= 0 ||
    typeof processIdentity.startedAt !== "string" ||
    !processIdentity.startedAt
  )
    throw new Error("Invalid worker process identity");
  const claim = {
    schemaVersion: UPDATE_JOB_SCHEMA_VERSION,
    runId,
    ownerNonce,
    pid: processIdentity.pid,
    startedAt: processIdentity.startedAt,
    claimedAt: new Date().toISOString(),
  };
  await writeExclusive(
    path.join(jobDirectory(root, runId), "claim.json"),
    claim,
  );
  return claim;
}

export async function readClaim(root, runId) {
  const claim = await readJson(
    path.join(jobDirectory(root, runId), "claim.json"),
  );
  const descriptor = await readDescriptor(root, runId);
  if (
    claim.schemaVersion !== UPDATE_JOB_SCHEMA_VERSION ||
    claim.runId !== runId ||
    claim.ownerNonce !== descriptor.ownerNonce ||
    !Number.isSafeInteger(claim.pid) ||
    claim.pid <= 0 ||
    typeof claim.startedAt !== "string" ||
    !claim.startedAt
  )
    throw new Error("Invalid update job claim");
  return claim;
}

export async function appendJobEvent(root, runId, ownerNonce, event) {
  const claim = await readClaim(root, runId);
  if (claim.ownerNonce !== ownerNonce)
    throw new Error("Update job owner mismatch");
  if (
    !Number.isSafeInteger(event?.sequence) ||
    event.sequence <= 0 ||
    !["running", "output", "thread", "finished"].includes(event.type)
  )
    throw new Error("Invalid update job event");
  const file = path.join(jobDirectory(root, runId), "events.jsonl");
  const existing = await fs.readFile(file, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const previous = existing.trimEnd().split("\n").at(-1);
  const lastSequence = previous ? JSON.parse(previous).sequence : 0;
  if (event.sequence !== lastSequence + 1)
    throw new Error("Update job event sequence mismatch");
  const handle = await fs.open(file, "a", 0o600);
  try {
    await handle.writeFile(
      `${JSON.stringify({ ...event, runId, ownerNonce })}\n`,
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readJobEvents(root, runId) {
  const claim = await readClaim(root, runId);
  const file = path.join(jobDirectory(root, runId), "events.jsonl");
  const content = await fs.readFile(file, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  if (content && !content.endsWith("\n"))
    throw new Error("Incomplete update job event");
  const lines = content.trimEnd() ? content.trimEnd().split("\n") : [];
  return lines.map((line, index) => {
    const event = JSON.parse(line);
    if (
      event.runId !== runId ||
      event.ownerNonce !== claim.ownerNonce ||
      event.sequence !== index + 1 ||
      !["running", "output", "thread", "finished"].includes(event.type)
    )
      throw new Error("Invalid update job event");
    return event;
  });
}

export async function finishJob(root, runId, ownerNonce, receipt) {
  const claim = await readClaim(root, runId);
  if (claim.ownerNonce !== ownerNonce)
    throw new Error("Update job owner mismatch");
  if (
    !["succeeded", "blocked", "failed", "cancelled"].includes(
      receipt?.outcome,
    ) ||
    !Number.isSafeInteger(receipt.lastSequence) ||
    receipt.lastSequence < 0
  )
    throw new Error("Invalid update job receipt");
  if ((await readJobEvents(root, runId)).length !== receipt.lastSequence)
    throw new Error("Update job receipt sequence mismatch");
  const directory = jobDirectory(root, runId);
  const temporary = path.join(directory, `.receipt-${randomUUID()}`);
  try {
    await writeExclusive(temporary, {
      ...receipt,
      schemaVersion: UPDATE_JOB_SCHEMA_VERSION,
      runId,
      ownerNonce,
      finishedAt: new Date().toISOString(),
    });
    await fs.link(temporary, path.join(directory, "receipt.json"));
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function readReceipt(root, runId) {
  const receipt = await readJson(
    path.join(jobDirectory(root, runId), "receipt.json"),
  );
  const claim = await readClaim(root, runId);
  if (
    receipt.schemaVersion !== UPDATE_JOB_SCHEMA_VERSION ||
    receipt.runId !== runId ||
    receipt.ownerNonce !== claim.ownerNonce ||
    !["succeeded", "blocked", "failed", "cancelled"].includes(
      receipt.outcome,
    ) ||
    !Number.isSafeInteger(receipt.lastSequence) ||
    receipt.lastSequence < 0 ||
    !Number.isFinite(Date.parse(receipt.finishedAt))
  )
    throw new Error("Invalid update job receipt");
  if ((await readJobEvents(root, runId)).length !== receipt.lastSequence)
    throw new Error("Update job receipt sequence mismatch");
  return receipt;
}
