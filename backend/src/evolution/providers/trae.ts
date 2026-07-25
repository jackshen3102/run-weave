import { runProviderProcess } from "./process-runner";
import { buildEvolutionMcpConfigArgs } from "./mcp-config";
import { buildEvolutionRestrictedFeatureArgs } from "./restricted-features";
import type {
  EvolutionProviderAdapter,
  EvolutionProviderRequest,
  EvolutionProviderResult,
} from "./types";

export class TraeEvolutionProvider implements EvolutionProviderAdapter {
  readonly provider = "trae" as const;

  constructor(
    private readonly binary = process.env.RUNWEAVE_TRAE_BIN?.trim() ||
      "trae-cli",
  ) {}

  run(request: EvolutionProviderRequest): Promise<EvolutionProviderResult> {
    return runProviderProcess({
      provider: this.provider,
      binary: this.binary,
      args: buildArgs(request),
      request,
    });
  }
}

function buildArgs(request: EvolutionProviderRequest): string[] {
  return [
    ...buildEvolutionMcpConfigArgs(request),
    ...buildEvolutionRestrictedFeatureArgs(),
    "--ask-for-approval",
    "never",
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--color",
    "never",
    "--json",
    "--cd",
    request.workingDirectory,
    "--output-schema",
    request.outputSchemaPath,
    ...(request.model ? ["--model", request.model] : []),
  ];
}
