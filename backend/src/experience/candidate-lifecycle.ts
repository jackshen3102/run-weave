import { createHash } from "node:crypto";
import type {
  ExperienceCandidate,
  ExperienceCandidateView,
} from "@runweave/shared/experience";
import { withExperienceStore } from "./storage";
import { ExperienceError } from "./errors";

export function candidateView(
  candidate: ExperienceCandidate,
): ExperienceCandidateView {
  return {
    candidate,
    version: createHash("sha256")
      .update(JSON.stringify(candidate))
      .digest("hex"),
  };
}

export function readCandidate(
  directory: string,
  candidateId: string,
): ExperienceCandidateView {
  return withExperienceStore(directory, (store) => {
    const candidate = store.get<ExperienceCandidate>("candidates", candidateId);
    if (!candidate)
      throw new ExperienceError("experience_candidate_not_found", 404);
    return candidateView(candidate);
  });
}

export function retireCandidate(
  directory: string,
  candidateId: string,
  expectedVersion: string,
  reason: string,
): ExperienceCandidateView {
  return withExperienceStore(directory, (store) =>
    store.transaction(() => {
      const candidate = store.get<ExperienceCandidate>(
        "candidates",
        candidateId,
      );
      if (!candidate)
        throw new ExperienceError("experience_candidate_not_found", 404);
      // An exact replay returns the original receipt, including its original timestamp.
      if (
        candidate.status === "retired" &&
        candidate.retirement?.expectedVersion === expectedVersion &&
        candidate.retirement.reason === reason
      )
        return candidateView(candidate);
      if (candidateView(candidate).version !== expectedVersion)
        throw new ExperienceError("experience_candidate_version_conflict", 409);
      if (candidate.status === "retired")
        throw new ExperienceError("experience_candidate_already_retired", 409);
      const next: ExperienceCandidate = {
        ...candidate,
        status: "retired",
        retirement: {
          at: new Date().toISOString(),
          reason,
          previousStatus: candidate.status,
          expectedVersion,
        },
      };
      store.put("candidates", candidateId, next);
      return candidateView(next);
    }),
  );
}
