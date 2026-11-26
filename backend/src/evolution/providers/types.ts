export type EvolutionProviderName = "codex" | "trae" | "agy";

export interface EvolutionProviderRequest {
  prompt: string;
  workingDirectory: string;
  outputSchemaPath: string;
  /** Prompt mode leaves schema validation to the caller; native is the default. */
  outputSchemaMode?: "native" | "prompt";
  maxWallTimeMs: number;
  maxOutputBytes: number;
  mcp?: {
    url: string;
    bearerToken: string;
  };
  model?: string;
  effort?: string;
  signal?: AbortSignal;
}

export interface EvolutionProviderResult {
  provider: EvolutionProviderName;
  durationMs: number;
  events: unknown[];
  output: unknown;
}

export interface EvolutionProviderAdapter {
  readonly provider: EvolutionProviderName;
  run(request: EvolutionProviderRequest): Promise<EvolutionProviderResult>;
}
