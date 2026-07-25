export type EvolutionProviderName = "codex" | "trae";

export interface EvolutionProviderRequest {
  prompt: string;
  workingDirectory: string;
  outputSchemaPath: string;
  maxWallTimeMs: number;
  maxOutputBytes: number;
  mcp?: {
    url: string;
    bearerToken: string;
  };
  model?: string;
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
