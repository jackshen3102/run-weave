import type {
  AnalysisProfile,
  EvolutionProviderAvailability,
  EvolutionRunAttempt,
  ProviderPolicy,
} from "@runweave/shared/evolution";
import type { EvolutionProviderName } from "./types";

export interface EvolutionProviderAssignment {
  provider: EvolutionProviderName;
  selectionReason: EvolutionRunAttempt["selectionReason"];
}

export function selectEvolutionProviders(params: {
  policy: ProviderPolicy;
  profile: AnalysisProfile;
  availability: EvolutionProviderAvailability[];
}): EvolutionProviderAssignment[] {
  const available = new Set(
    params.availability
      .filter((item) => item.available)
      .map((item) => item.provider),
  );
  const count = params.profile === "quick" ? 1 : 2;
  if (params.policy === "mixed") {
    if (!available.has("codex") || !available.has("trae")) {
      throw new Error("evolution_provider_mixed_unavailable");
    }
    const assignments: EvolutionProviderAssignment[] = [
      { provider: "codex", selectionReason: "cross_provider" },
      { provider: "trae", selectionReason: "cross_provider" },
    ];
    return assignments.slice(0, count);
  }
  if (params.policy === "codex" || params.policy === "trae") {
    if (!available.has(params.policy)) {
      throw new Error(`evolution_provider_${params.policy}_unavailable`);
    }
    return Array.from({ length: count }, () => ({
      provider: params.policy as EvolutionProviderName,
      selectionReason: "explicit_policy" as const,
    }));
  }
  if (available.has("codex") && available.has("trae")) {
    const assignments: EvolutionProviderAssignment[] = [
      { provider: "codex", selectionReason: "cross_provider" },
      { provider: "trae", selectionReason: "cross_provider" },
    ];
    return assignments.slice(0, count);
  }
  const fallback = available.has("codex")
    ? "codex"
    : available.has("trae")
      ? "trae"
      : null;
  if (!fallback) throw new Error("evolution_provider_unavailable");
  return Array.from({ length: count }, () => ({
    provider: fallback,
    selectionReason: "fallback_single_provider" as const,
  }));
}
