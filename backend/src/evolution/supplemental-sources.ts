import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  ContextPackEvidenceRef,
  DataQualityIssue,
  LearningScopeRef,
  SourceBoundary,
} from "@runweave/shared/evolution";
import { canonicalJson, sha256 } from "../activity/canonical";

const MAX_BASELINE_FILE_BYTES = 256_000;

export interface EvolutionSupplementalSources {
  sources: SourceBoundary[];
  evidence: ContextPackEvidenceRef[];
  dataQualityIssues: DataQualityIssue[];
}

export interface EvolutionSupplementalSourceReader {
  collect(input: {
    learningScope: LearningScopeRef;
    activityEvidence: ContextPackEvidenceRef[];
    afterWatermark: string | null;
    snapshotBoundary: string;
  }): Promise<EvolutionSupplementalSources>;
}

export class DefaultEvolutionSupplementalSourceReader
  implements EvolutionSupplementalSourceReader
{
  constructor(
    private readonly appServer: {
      getThreadDetail(threadId: string): Promise<unknown>;
    },
    private readonly agentTeam: {
      getRun(runId: string): Promise<unknown | null>;
    },
    private readonly resolveProjectRoot: (
      learningScopeId: string,
    ) => string | null,
  ) {}

  async collect(input: {
    learningScope: LearningScopeRef;
    activityEvidence: ContextPackEvidenceRef[];
    afterWatermark: string | null;
    snapshotBoundary: string;
  }): Promise<EvolutionSupplementalSources> {
    const threadIds = unique(
      input.activityEvidence.flatMap((item) =>
        item.relationships.threadId ? [item.relationships.threadId] : [],
      ),
    );
    const runIds = unique(
      input.activityEvidence.flatMap((item) =>
        item.relationships.runId ? [item.relationships.runId] : [],
      ),
    );
    const [appServer, agentTeam, repository] = await Promise.all([
      this.collectAppServer(threadIds, input),
      this.collectAgentTeam(runIds, input),
      this.collectRepository(input),
    ]);
    return {
      sources: [
        ...appServer.sources,
        ...agentTeam.sources,
        ...repository.sources,
      ],
      evidence: [
        ...appServer.evidence,
        ...agentTeam.evidence,
        ...repository.evidence,
      ],
      dataQualityIssues: [
        ...appServer.dataQualityIssues,
        ...agentTeam.dataQualityIssues,
        ...repository.dataQualityIssues,
      ],
    };
  }

  private async collectAppServer(
    threadIds: string[],
    input: {
      afterWatermark: string | null;
      snapshotBoundary: string;
    },
  ): Promise<EvolutionSupplementalSources> {
    const results = await Promise.all(
      threadIds.map(async (threadId) => {
        try {
          const detail = await this.appServer.getThreadDetail(threadId);
          const digest = sha256(canonicalJson(detail));
          return {
            evidence: sourceEvidence({
              evidenceId: `app-server:${threadId}:${digest.slice(0, 16)}`,
              source: "app_server",
              sourceRecordId: threadId,
              digest,
              relationships: { threadId },
            }),
          };
        } catch {
          return {
            issue: qualityIssue(
              "app_server",
              "app_server_thread_unavailable",
              threadId,
            ),
          };
        }
      }),
    );
    return collectedSource(
      "app_server",
      input,
      results.flatMap((result) =>
        result.evidence ? [result.evidence] : [],
      ),
      results.flatMap((result) => (result.issue ? [result.issue] : [])),
    );
  }

  private async collectAgentTeam(
    runIds: string[],
    input: {
      afterWatermark: string | null;
      snapshotBoundary: string;
    },
  ): Promise<EvolutionSupplementalSources> {
    const results = await Promise.all(
      runIds.map(async (runId) => {
        try {
          const run = await this.agentTeam.getRun(runId);
          if (!run) throw new Error("agent_team_run_not_found");
          const digest = sha256(canonicalJson(run));
          return {
            evidence: sourceEvidence({
              evidenceId: `agent-team:${runId}:${digest.slice(0, 16)}`,
              source: "agent_team",
              sourceRecordId: runId,
              digest,
              relationships: { runId },
            }),
          };
        } catch {
          return {
            issue: qualityIssue(
              "agent_team",
              "agent_team_run_unavailable",
              runId,
            ),
          };
        }
      }),
    );
    return collectedSource(
      "agent_team",
      input,
      results.flatMap((result) =>
        result.evidence ? [result.evidence] : [],
      ),
      results.flatMap((result) => (result.issue ? [result.issue] : [])),
    );
  }

  private async collectRepository(input: {
    learningScope: LearningScopeRef;
    activityEvidence: ContextPackEvidenceRef[];
    afterWatermark: string | null;
    snapshotBoundary: string;
  }): Promise<EvolutionSupplementalSources> {
    if (input.learningScope.scopeType === "global") {
      return { sources: [], evidence: [], dataQualityIssues: [] };
    }
    const configuredRoot = this.resolveProjectRoot(
      input.learningScope.learningScopeId,
    );
    if (!configuredRoot) {
      return {
        sources: [],
        evidence: [],
        dataQualityIssues: [
          qualityIssue(
            "repository",
            "repository_root_unavailable",
            input.learningScope.learningScopeId,
          ),
        ],
      };
    }
    let root: string;
    try {
      root = await realpath(configuredRoot);
    } catch {
      return {
        sources: [],
        evidence: [],
        dataQualityIssues: [
          qualityIssue(
            "repository",
            "repository_root_unavailable",
            configuredRoot,
          ),
        ],
      };
    }
    const candidateFiles = new Set<string>([
      path.join(root, "AGENTS.md"),
      path.join(root, "docs", "architecture", "agent-self-evolution.md"),
    ]);
    for (const evidence of input.activityEvidence) {
      const originPath = evidence.origin.path;
      if (!originPath || !withinRoot(root, originPath)) continue;
      let current = path.resolve(originPath);
      while (withinRoot(root, current)) {
        candidateFiles.add(path.join(current, "AGENTS.md"));
        if (current === root) break;
        current = path.dirname(current);
      }
    }
    const evidence: ContextPackEvidenceRef[] = [];
    for (const candidate of candidateFiles) {
      try {
        const resolved = await realpath(candidate);
        if (!withinRoot(root, resolved)) continue;
        const bytes = await readFile(resolved);
        if (bytes.byteLength > MAX_BASELINE_FILE_BYTES) continue;
        const digest = sha256(bytes);
        evidence.push(
          sourceEvidence({
            evidenceId: `repository:${sha256(resolved).slice(0, 24)}`,
            source: "repository",
            sourceRecordId: resolved,
            digest,
            originPath: resolved,
          }),
        );
      } catch {
        // Optional baseline files that do not exist are not data-quality issues.
      }
    }
    return collectedSource("repository", input, evidence, []);
  }
}

function collectedSource(
  source: SourceBoundary["source"],
  boundary: { afterWatermark: string | null; snapshotBoundary: string },
  evidence: ContextPackEvidenceRef[],
  dataQualityIssues: DataQualityIssue[],
): EvolutionSupplementalSources {
  if (evidence.length === 0 && dataQualityIssues.length === 0) {
    return { sources: [], evidence: [], dataQualityIssues: [] };
  }
  return {
    sources: [
      {
        sourceId: source,
        source,
        afterWatermark: boundary.afterWatermark,
        snapshotBoundary: boundary.snapshotBoundary,
        processedThrough: boundary.snapshotBoundary,
        digest: sha256(
          canonicalJson(
            evidence.map((item) => ({
              evidenceId: item.evidenceId,
              digest: item.digest,
            })),
          ),
        ),
        recordCount: evidence.length,
        truncated: false,
      },
    ],
    evidence,
    dataQualityIssues,
  };
}

function sourceEvidence(params: {
  evidenceId: string;
  source: ContextPackEvidenceRef["source"];
  sourceRecordId: string;
  digest: string;
  originPath?: string;
  relationships?: Partial<ContextPackEvidenceRef["relationships"]>;
}): ContextPackEvidenceRef {
  return {
    evidenceId: params.evidenceId,
    source: params.source,
    sourceRecordId: params.sourceRecordId,
    digest: params.digest,
    availability: "available",
    activity: null,
    origin: {
      projectId: null,
      path: params.originPath ?? null,
      branch: null,
      revision: null,
    },
    relationships: {
      terminalSessionId: null,
      threadId: null,
      runId: null,
      interactionId: null,
      correlationId: null,
      causationId: null,
      parentEventId: null,
      ...params.relationships,
    },
    contentRefs: [],
  };
}

function qualityIssue(
  source: DataQualityIssue["source"],
  code: string,
  sourceId: string,
): DataQualityIssue {
  return {
    issueId: `data-quality:${sha256(`${source}\0${code}\0${sourceId}`).slice(0, 24)}`,
    source,
    code,
    severity: "warning",
    detail: `${source} evidence is unavailable for the frozen run.`,
    evidenceIds: [],
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function withinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
