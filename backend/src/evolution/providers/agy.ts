import { resolveAgyConfiguration } from "@runweave/config-node/agy";
import { runProviderProcess } from "./process-runner";
import type {
  EvolutionProviderAdapter,
  EvolutionProviderRequest,
  EvolutionProviderResult,
} from "./types";

export class AgyEvolutionProvider implements EvolutionProviderAdapter {
  readonly provider = "agy" as const;

  constructor(
    private readonly binary = resolveAgyConfiguration().binary,
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
    "-p",
    request.prompt,
    "--sandbox",
    "--output-format",
    "json",
    ...(request.outputSchemaMode === "prompt"
      ? []
      : ["--json-schema", request.outputSchemaPath]),
    ...(request.model ? ["--model", request.model] : []),
    ...(request.effort ? ["--effort", request.effort] : []),
  ];
}
