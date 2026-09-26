import { Router } from "express";
import { configuration, ConfigurationError, flattenConfiguration, fieldForPath } from "@runweave/config-node";
import { CONFIGURATION_FIELDS, isConfigurationObject, type ConfigurationObject, type ConfigurationPatch } from "@runweave/shared/configuration";

function publicStatus() {
  const status = configuration().status();
  const values: ConfigurationObject = {};
  for (const [key, value] of flattenConfiguration(status.values)) {
    const configuredKey = key.endsWith(".configured") ? key.slice(0, -11) : key;
    if (fieldForPath(configuredKey)?.remote) values[key] = value;
  }
  return { ...status, values, fields: CONFIGURATION_FIELDS.filter((field) => field.remote).map(({ path, type, domain, sensitive, apply, description, default: defaultValue }) => ({ path, type, domain, sensitive, apply, description, default: defaultValue })) };
}

export function createConfigurationRouter(): Router {
  const router = Router();
  router.get("/", (_req, res) => {
    try { res.json(publicStatus()); }
    catch (error) { respondError(res, error); }
  });
  router.patch("/", async (req, res) => {
    try {
      const body: unknown = req.body;
      if (!isConfigurationObject(body) || !Number.isSafeInteger(body.expectedRevision) || typeof body.expectedDigest !== "string" || !/^[a-f0-9]{64}$/.test(body.expectedDigest) || !isConfigurationObject(body.changes)) throw new ConfigurationError("CONFIG_PATCH_INVALID");
      const identity = body.expectedEnvironment;
      const expected = configuration().context;
      if (!isConfigurationObject(identity) || identity.kind !== expected.kind || identity.instanceId !== expected.instanceId) throw new ConfigurationError("CONFIG_IDENTITY_CONFLICT");
      configuration().store.patch(body as unknown as ConfigurationPatch, { remote: true });
      await configuration().reload();
      res.json(publicStatus());
    } catch (error) { respondError(res, error); }
  });
  router.post("/reload", async (_req, res) => {
    try { await configuration().reload(); res.json(publicStatus()); }
    catch (error) { respondError(res, error); }
  });
  return router;
}

function respondError(res: import("express").Response, error: unknown): void {
  const code = error instanceof ConfigurationError ? error.code : "CONFIG_OPERATION_FAILED";
  const status = /CONFLICT|BUSY/.test(code) ? 409 : code === "CONFIG_FIELD_FORBIDDEN" ? 403 : 400;
  // Parser and filesystem error strings can contain credentials or private paths.
  res.status(status).json({ error: { code, ...(error instanceof ConfigurationError && error.location ? { location: error.location } : {}) } });
}
