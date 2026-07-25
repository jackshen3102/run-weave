import { parentPort, workerData } from "node:worker_threads";
import { EvolutionActivationDatabase } from "./database";
import type {
  EvolutionWorkerCommand,
  EvolutionWorkerResponse,
  EvolutionWorkerResult,
} from "./worker-protocol";

if (!parentPort) throw new Error("evolution_worker_parent_port_required");
const port = parentPort;

const database = new EvolutionActivationDatabase(
  (workerData as { databasePath: string }).databasePath,
);

function execute(command: EvolutionWorkerCommand): EvolutionWorkerResult {
  switch (command.op) {
    case "list-candidates":
      return database.listCandidates();
    case "put-candidate":
      database.putCandidate(command.candidate);
      return true;
    case "get-policy":
      return database.getPolicy(command.learningScopeId);
    case "put-policy":
      database.putPolicy(command.policy);
      return true;
    case "put-trace":
      database.putRuntimeTrace(command.trace);
      return true;
    case "append-trace-event":
      database.appendRuntimeTraceEvent(command.event);
      return true;
    case "get-trace":
      return database.getRuntimeTrace(command.traceId);
    case "list-traces":
      return database.listRuntimeTraces(command.runId);
    case "list-recent-traces":
      return database.listRecentRuntimeTraces(
        command.learningScopeId,
        command.limit,
      );
    case "put-context-pack":
      database.putContextPack(command.manifest);
      return true;
    case "get-context-pack":
      return database.getContextPack(command.contextPackId);
    case "get-context-pack-by-run":
      return database.getContextPackByRun(command.runId);
    case "put-trace-segments":
      database.putTraceSegments(command.segments);
      return true;
    case "list-trace-segments":
      return database.listTraceSegments(command.runId);
    case "put-episodes":
      database.putEpisodes(command.episodes);
      return true;
    case "list-episodes":
      return database.listEpisodes(command.runId);
    case "put-analysis-report":
      database.putAnalysisReport(command.report);
      return true;
    case "list-analysis-reports":
      return database.listAnalysisReports(command.runId);
    case "put-run-attempt":
      database.putRunAttempt(command.attempt);
      return true;
    case "list-run-attempts":
      return database.listRunAttempts(command.runId);
    case "put-claims":
      database.putClaims(command.claims);
      return true;
    case "list-claims":
      return database.listClaims(command.runId);
    case "put-claim-novelty":
      database.putClaimNovelty(command.items);
      return true;
    case "list-claim-novelty":
      return database.listClaimNovelty(command.runId);
    case "put-insight-revision":
      database.putInsightRevision(command);
      return true;
    case "list-insights":
      return database.listInsights(command.learningScopeId);
    case "get-insight":
      return database.getInsight(command.insightId);
    case "list-insight-revisions-by-run":
      return database.listInsightRevisionsByRun(command.runId);
    case "list-evidence-dependencies":
      return database.listEvidenceDependencies();
    case "apply-evidence-reconciliation":
      database.applyEvidenceReconciliation(command.reconciliation);
      return true;
    case "commit-run-knowledge":
      return database.commitRunKnowledge(command.params);
    case "create-run":
      database.createRun(command.run);
      return true;
    case "get-run":
      return database.getRun(command.runId);
    case "list-runs":
      return database.listRuns(command.query);
    case "claim-next-run":
      return database.claimNextRun(command);
    case "heartbeat-run-claim":
      return database.heartbeatRunClaim(command);
    case "transition-run":
      return database.transitionRun(command.transition);
    case "cancel-run":
      return database.cancelRun(command.runId, command.now);
    case "recover-expired-runs":
      return database.recoverExpiredRuns(command.now);
    case "put-schedule":
      database.putSchedule(command.schedule);
      return true;
    case "get-schedule":
      return database.getSchedule(command.scheduleId);
    case "list-schedules":
      return database.listSchedules(command.learningScopeId);
    case "materialize-due-schedule":
      return database.materializeDueSchedule(command.params);
    case "delete-schedule":
      return database.deleteSchedule(command.scheduleId);
    case "get-watermark":
      return database.getWatermark(command.learningScopeId, command.source);
    case "put-watermark":
      database.putWatermark(command);
      return true;
    case "integrity":
      return database.integrity();
    case "close":
      database.close();
      return true;
  }
}

port.on("message", (command: EvolutionWorkerCommand) => {
  let response: EvolutionWorkerResponse;
  try {
    response = { id: command.id, ok: true, result: execute(command) };
  } catch (error) {
    response = {
      id: command.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  port.postMessage(response);
  if (command.op === "close") port.close();
});
