import { existsSync } from "node:fs";
import path from "node:path";

interface ResolveFrontendDistDirOptions {
  cwd?: string;
  env?: Partial<Pick<NodeJS.ProcessEnv, "FRONTEND_DIST_DIR">>;
  exists?: (candidate: string) => boolean;
}

export function resolveFrontendDistDir(
  options: ResolveFrontendDistDirOptions = {},
): string {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const configuredDistDir = env.FRONTEND_DIST_DIR?.trim();

  if (configuredDistDir) {
    return path.resolve(configuredDistDir);
  }

  const primaryCandidate = path.resolve(cwd, "frontend/dist");
  const candidates = [
    primaryCandidate,
    path.resolve(cwd, "../frontend/dist"),
    path.resolve(cwd, "../../frontend/dist"),
  ];

  return candidates.find((candidate) => exists(candidate)) ?? primaryCandidate;
}
