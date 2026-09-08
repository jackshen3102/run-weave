import path from "node:path";
import { z } from "zod";
const env = z.object({
  NODE_ENV: z.enum(["development", "production"]).default("development"),
  DATABASE_URL: z.string().url(),
  SUIJI_STORAGE_DIR: z.string().min(1),
  SUIJI_HOST: z.string().default("127.0.0.1"),
  SUIJI_PORT: z.coerce.number().int().min(1).max(65535).default(4783),
  SUIJI_ACCESS_SECONDS: z.coerce.number().int().positive().default(86400),
  SUIJI_REFRESH_SECONDS: z.coerce.number().int().positive().default(2592000),
  SUIJI_LOGIN_ATTEMPTS: z.coerce.number().int().positive().default(8),
  SUIJI_LOGIN_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),
  SUIJI_APP_VERSION: z.string().default("0.1.0"),
  SUIJI_WEB_ORIGINS: z.string().default(""),
  SUIJI_AI_PROVIDER: z.enum(["disabled", "codex-cli"]).default("disabled"),
  SUIJI_CODEX_BIN: z.string().min(1).default("codex"),
  SUIJI_CODEX_HOME: z.string().min(1).optional(),
  SUIJI_AI_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(600).default(180),
  SUIJI_MCP_TOKEN_SHA256: z.string().regex(/^[a-f0-9]{64}$/).or(z.literal("")).optional(),
  SUIJI_MCP_TOKEN_EXPIRES_AT: z.string().datetime().or(z.literal("")).optional(),
});
export function readConfig() {
  const parsed = env.safeParse(process.env);
  if (!parsed.success)
    throw new Error(
      `Invalid configuration fields: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  const c = parsed.data;
  for (const origin of c.SUIJI_WEB_ORIGINS.split(",").filter(Boolean)) {
    if (origin === "runweave://app") continue;
    const url = new URL(origin);
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin)
      throw new Error("SUIJI_WEB_ORIGINS requires exact HTTP(S) origins or runweave://app separated by commas");
  }
  if (c.SUIJI_CODEX_HOME && !path.isAbsolute(c.SUIJI_CODEX_HOME))
    throw new Error("SUIJI_CODEX_HOME must be absolute");
  if (c.NODE_ENV === "production" && c.SUIJI_AI_PROVIDER === "codex-cli" && !c.SUIJI_CODEX_HOME)
    throw new Error("Production Codex requires a persistent SUIJI_CODEX_HOME for its login");
  if (Boolean(c.SUIJI_MCP_TOKEN_SHA256) !== Boolean(c.SUIJI_MCP_TOKEN_EXPIRES_AT))
    throw new Error("MCP requires both token digest and expiration configuration");
  if (!path.isAbsolute(c.SUIJI_STORAGE_DIR))
    throw new Error("SUIJI_STORAGE_DIR must be absolute");
  if (c.NODE_ENV === "production") {
    const db = new URL(c.DATABASE_URL);
    if (!db.username || !db.password || /^(postgres|root)$/.test(db.username))
      throw new Error("Production requires a dedicated API database role");
    if (/^\/(?:tmp|private\/tmp|var\/tmp)(?:\/|$)/.test(c.SUIJI_STORAGE_DIR))
      throw new Error("Production storage must be persistent");
    if (process.env.MIGRATION_DATABASE_URL)
      throw new Error("API must not receive migration credentials");
  }
  return c;
}
export type Config = ReturnType<typeof readConfig>;
