import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemoizedFn } from "ahooks";
import { useSearchParams } from "react-router-dom";
import {
  EVOLUTION_GLOBAL_SCOPE_ID,
  type CandidateAsset,
  type CreateEvolutionRunRequest,
  type CreateEvolutionScheduleRequest,
  type EvolutionSchedule,
  type EvolutionScopePolicy,
  type UpdateEvolutionScheduleRequest,
} from "@runweave/shared/evolution";
import {
  authorizeEvolutionCandidateCanary,
  cancelEvolutionRun,
  createEvolutionRun,
  createEvolutionSchedule,
  deleteEvolutionSchedule,
  fetchEvolutionCandidates,
  fetchEvolutionInsights,
  fetchEvolutionProviders,
  fetchEvolutionRunArtifacts,
  fetchEvolutionRuns,
  fetchEvolutionRuntimeTraces,
  fetchEvolutionSchedules,
  fetchEvolutionScopePolicy,
  retryEvolutionRun,
  retireEvolutionCandidate,
  updateEvolutionSchedule,
  updateEvolutionScopePolicy,
} from "../services/evolution";
import { listTerminalProjects } from "../services/terminal/index";
import {
  EvolutionScheduleDialog,
  RetireEvolutionCandidateDialog,
} from "./evolution/evolution-dialogs";
import {
  EvolutionErrorNotice,
  EvolutionHeader,
  EvolutionLoadingPanel,
  EvolutionOverview,
  EvolutionSidebar,
  TERMINAL_STAGES,
  type EvolutionScopeOption,
  type EvolutionView,
} from "./evolution/evolution-page-panels";
import { EvolutionInsightsPanel } from "./evolution/evolution-insights-panel";
import {
  EMPTY_CANDIDATES,
  EMPTY_INSIGHTS,
  EMPTY_PROJECTS,
  EMPTY_RUNS,
  EMPTY_SCHEDULES,
  EMPTY_TRACES,
  EVOLUTION_VIEWS,
  buildEvolutionScopeOptions,
  evolutionErrorMessage,
} from "./evolution/evolution-page-state";
import { EvolutionRunsPanel } from "./evolution/evolution-runs-panel";
import {
  EvolutionCandidatesPanel,
  EvolutionSchedulesPanel,
} from "./evolution/evolution-assets-panels";

export function EvolutionPage({
  apiBase,
  token,
  onNavigateHome,
}: {
  apiBase: string;
  token: string;
  onNavigateHome: () => void;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] =
    useState<EvolutionSchedule | null>(null);
  const [retiringCandidate, setRetiringCandidate] =
    useState<CandidateAsset | null>(null);

  const requestedView = searchParams.get("view");
  const view: EvolutionView =
    requestedView && EVOLUTION_VIEWS.has(requestedView as EvolutionView)
      ? (requestedView as EvolutionView)
      : "overview";

  const runsQuery = useQuery({
    queryKey: ["evolution", "runs", apiBase],
    queryFn: () => fetchEvolutionRuns(apiBase, token, { limit: 200 }),
    refetchInterval: (query) =>
      query.state.data?.runs.some((run) => !TERMINAL_STAGES.has(run.stage))
        ? 5_000
        : false,
  });
  const providersQuery = useQuery({
    queryKey: ["evolution", "providers", apiBase],
    queryFn: () => fetchEvolutionProviders(apiBase, token),
    refetchInterval: 30_000,
  });
  const schedulesQuery = useQuery({
    queryKey: ["evolution", "schedules", apiBase],
    queryFn: () => fetchEvolutionSchedules(apiBase, token),
  });
  const candidatesQuery = useQuery({
    queryKey: ["evolution", "candidates", apiBase],
    queryFn: () => fetchEvolutionCandidates(apiBase, token),
  });
  const insightsQuery = useQuery({
    queryKey: ["evolution", "insights", apiBase],
    queryFn: () => fetchEvolutionInsights(apiBase, token),
  });
  const tracesQuery = useQuery({
    queryKey: ["evolution", "runtime-traces", apiBase],
    queryFn: () =>
      fetchEvolutionRuntimeTraces(apiBase, token, {
        limit: 200,
      }),
  });
  const projectsQuery = useQuery({
    queryKey: ["evolution", "project-metadata", apiBase],
    queryFn: () => listTerminalProjects(apiBase, token),
  });

  const runs = runsQuery.data?.runs ?? EMPTY_RUNS;
  const schedules = schedulesQuery.data?.schedules ?? EMPTY_SCHEDULES;
  const candidates = candidatesQuery.data?.candidates ?? EMPTY_CANDIDATES;
  const insights = insightsQuery.data?.insights ?? EMPTY_INSIGHTS;
  const traces = tracesQuery.data?.traces ?? EMPTY_TRACES;
  const providers = providersQuery.data?.providers ?? [];
  const projects = projectsQuery.data ?? EMPTY_PROJECTS;
  const scopeOptions = useMemo<EvolutionScopeOption[]>(
    () => buildEvolutionScopeOptions(projects),
    [projects],
  );
  const requestedScopeId = searchParams.get("scope") ?? "";
  const selectedScopeId = scopeOptions.some(
    (scope) => scope.id === requestedScopeId,
  )
    ? requestedScopeId
    : EVOLUTION_GLOBAL_SCOPE_ID;
  const selectedScope =
    scopeOptions.find((scope) => scope.id === selectedScopeId) ??
    scopeOptions[0]!;
  const scopedRuns = selectedScopeId
    ? runs.filter((run) => run.learningScopeId === selectedScopeId)
    : runs;
  const scopedSchedules = selectedScopeId
    ? schedules.filter(
        (schedule) => schedule.learningScopeId === selectedScopeId,
      )
    : schedules;
  const scopedCandidates = selectedScopeId
    ? candidates.filter(
        (candidate) => candidate.learningScopeId === selectedScopeId,
      )
    : candidates;
  const scopedInsights = selectedScopeId
    ? insights.filter((insight) => insight.learningScopeId === selectedScopeId)
    : insights;
  const scopedTraces = selectedScopeId
    ? traces.filter((trace) => trace.learningScopeId === selectedScopeId)
    : traces;
  const requestedRunId = searchParams.get("run");
  const selectedRunId =
    (requestedRunId &&
      scopedRuns.some((run) => run.runId === requestedRunId) &&
      requestedRunId) ||
    scopedRuns[0]?.runId ||
    null;

  const artifactsQuery = useQuery({
    queryKey: ["evolution", "artifacts", apiBase, selectedRunId],
    queryFn: () =>
      fetchEvolutionRunArtifacts(apiBase, token, selectedRunId ?? ""),
    enabled: view === "runs" && selectedRunId !== null,
    refetchInterval: scopedRuns.some(
      (run) => run.runId === selectedRunId && !TERMINAL_STAGES.has(run.stage),
    )
      ? 5_000
      : false,
  });
  const selectedRunStage = scopedRuns.find(
    (run) => run.runId === selectedRunId,
  )?.stage;
  useEffect(() => {
    if (
      view !== "runs" ||
      selectedRunId === null ||
      !selectedRunStage ||
      !TERMINAL_STAGES.has(selectedRunStage)
    ) {
      return;
    }
    void queryClient.invalidateQueries({
      queryKey: ["evolution", "artifacts", apiBase, selectedRunId],
    });
  }, [apiBase, queryClient, selectedRunId, selectedRunStage, view]);
  const policyQuery = useQuery({
    queryKey: ["evolution", "policy", apiBase, selectedScopeId],
    queryFn: () => fetchEvolutionScopePolicy(apiBase, token, selectedScopeId),
    enabled: view === "candidates" && selectedScopeId.length > 0,
  });

  const invalidateEvolution = useMemoizedFn(async () => {
    await queryClient.invalidateQueries({ queryKey: ["evolution"] });
  });
  const updateParams = useMemoizedFn(
    (changes: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParams);
      for (const [key, value] of Object.entries(changes)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      setSearchParams(next, { replace: true });
    },
  );
  const selectView = useMemoizedFn((nextView: EvolutionView) => {
    updateParams({
      view: nextView === "overview" ? null : nextView,
      run: nextView === "runs" ? selectedRunId : null,
    });
  });
  const selectScope = useMemoizedFn((scopeId: string) => {
    updateParams({ scope: scopeId, run: null });
  });
  const selectRun = useMemoizedFn((runId: string) => {
    updateParams({ view: "runs", run: runId });
  });
  const openScheduleDialog = useMemoizedFn(() => {
    setEditingSchedule(null);
    setScheduleDialogOpen(true);
  });
  const closeScheduleDialog = useMemoizedFn(() => {
    setScheduleDialogOpen(false);
    setEditingSchedule(null);
  });
  const editSchedule = useMemoizedFn((schedule: EvolutionSchedule) => {
    setEditingSchedule(schedule);
    setScheduleDialogOpen(true);
  });
  const closeRetireCandidateDialog = useMemoizedFn(() => {
    setRetiringCandidate(null);
  });

  const createRunMutation = useMutation({
    mutationFn: (input: CreateEvolutionRunRequest) =>
      createEvolutionRun(apiBase, token, input),
    onSuccess: async (run) => {
      updateParams({
        view: "runs",
        scope: run.learningScopeId,
        run: run.runId,
      });
      await invalidateEvolution();
    },
  });
  const startReflection = useMemoizedFn(() => {
    createRunMutation.reset();
    createRunMutation.mutate({
      scope:
        selectedScope.kind === "global"
          ? { type: "global" }
          : { type: "project", projectId: selectedScope.id },
    });
  });
  const cancelRunMutation = useMutation({
    mutationFn: (runId: string) => cancelEvolutionRun(apiBase, token, runId),
    onSuccess: invalidateEvolution,
  });
  const retryRunMutation = useMutation({
    mutationFn: (runId: string) => retryEvolutionRun(apiBase, token, runId),
    onSuccess: async (run) => {
      updateParams({ scope: run.learningScopeId, run: run.runId });
      await invalidateEvolution();
    },
  });
  const createScheduleMutation = useMutation({
    mutationFn: (input: CreateEvolutionScheduleRequest) =>
      createEvolutionSchedule(apiBase, token, input),
    onSuccess: async (schedule) => {
      closeScheduleDialog();
      updateParams({ view: "schedules", scope: schedule.learningScopeId });
      await invalidateEvolution();
    },
  });
  const updateScheduleMutation = useMutation({
    mutationFn: ({
      scheduleId,
      input,
    }: {
      scheduleId: string;
      input: UpdateEvolutionScheduleRequest;
    }) => updateEvolutionSchedule(apiBase, token, scheduleId, input),
    onSuccess: async () => {
      closeScheduleDialog();
      await invalidateEvolution();
    },
  });
  const deleteScheduleMutation = useMutation({
    mutationFn: (scheduleId: string) =>
      deleteEvolutionSchedule(apiBase, token, scheduleId),
    onSuccess: invalidateEvolution,
  });
  const policyMutation = useMutation({
    mutationFn: ({
      learningScopeId,
      policy,
    }: {
      learningScopeId: string;
      policy: Omit<
        EvolutionScopePolicy,
        "learningScopeId" | "revision" | "updatedAt" | "updatedBy"
      >;
    }) => updateEvolutionScopePolicy(apiBase, token, learningScopeId, policy),
    onSuccess: invalidateEvolution,
  });
  const authorizeCandidateMutation = useMutation({
    mutationFn: (candidateId: string) =>
      authorizeEvolutionCandidateCanary(apiBase, token, candidateId),
    onSuccess: invalidateEvolution,
  });
  const retireCandidateMutation = useMutation({
    mutationFn: ({
      candidateId,
      reason,
    }: {
      candidateId: string;
      reason: string;
    }) => retireEvolutionCandidate(apiBase, token, candidateId, reason),
    onSuccess: async () => {
      setRetiringCandidate(null);
      await invalidateEvolution();
    },
  });

  const submitSchedule = useMemoizedFn(
    (
      input: CreateEvolutionScheduleRequest | UpdateEvolutionScheduleRequest,
    ) => {
      if (editingSchedule) {
        updateScheduleMutation.mutate({
          scheduleId: editingSchedule.scheduleId,
          input,
        });
      } else {
        createScheduleMutation.mutate(input as CreateEvolutionScheduleRequest);
      }
    },
  );
  const toggleSchedule = useMemoizedFn((schedule: EvolutionSchedule) => {
    updateScheduleMutation.mutate({
      scheduleId: schedule.scheduleId,
      input: { enabled: !schedule.enabled },
    });
  });
  const removeSchedule = useMemoizedFn((schedule: EvolutionSchedule) => {
    if (
      window.confirm(`删除运行计划“${schedule.name}”？该操作不会删除已有 Run。`)
    ) {
      deleteScheduleMutation.mutate(schedule.scheduleId);
    }
  });
  const updateCanary = useMemoizedFn(
    (memoryCanaryEnabled: boolean, canaryRate: number) => {
      const policy = policyQuery.data;
      if (!policy) return;
      if (
        memoryCanaryEnabled &&
        !window.confirm(
          `为 ${policy.learningScopeId} 启用 ${Math.round(canaryRate * 100)}% Memory Canary？`,
        )
      ) {
        return;
      }
      policyMutation.mutate({
        learningScopeId: policy.learningScopeId,
        policy: {
          memoryCanaryEnabled,
          canaryRate,
          maxInjectedAssets: policy.maxInjectedAssets,
          maxInjectionBytes: policy.maxInjectionBytes,
          autoPromotion: policy.autoPromotion,
          minimumPromotionGrade: policy.minimumPromotionGrade,
          minimumPromotionSamples: policy.minimumPromotionSamples,
        },
      });
    },
  );
  const authorizeCandidate = useMemoizedFn((candidate: CandidateAsset) => {
    if (
      window.confirm(
        `将 Memory ${candidate.assetId} 授权进入 Canary？它只会按当前 scope policy 注入匹配的 code worker。`,
      )
    ) {
      authorizeCandidateMutation.mutate(candidate.assetId);
    }
  });
  const retireCandidate = useMemoizedFn((candidate: CandidateAsset) => {
    retireCandidateMutation.reset();
    setRetiringCandidate(candidate);
  });
  const retryQueries = useMemoizedFn(() => {
    cancelRunMutation.reset();
    retryRunMutation.reset();
    updateScheduleMutation.reset();
    deleteScheduleMutation.reset();
    policyMutation.reset();
    authorizeCandidateMutation.reset();
    retireCandidateMutation.reset();
    void Promise.all([
      runsQuery.refetch(),
      providersQuery.refetch(),
      schedulesQuery.refetch(),
      candidatesQuery.refetch(),
      insightsQuery.refetch(),
      artifactsQuery.refetch(),
    ]);
  });

  const firstError =
    runsQuery.error ??
    providersQuery.error ??
    schedulesQuery.error ??
    candidatesQuery.error ??
    insightsQuery.error ??
    tracesQuery.error ??
    artifactsQuery.error ??
    policyQuery.error ??
    createRunMutation.error ??
    authorizeCandidateMutation.error ??
    retireCandidateMutation.error ??
    cancelRunMutation.error ??
    retryRunMutation.error ??
    updateScheduleMutation.error ??
    deleteScheduleMutation.error ??
    policyMutation.error;
  const initialLoading =
    runsQuery.isLoading ||
    providersQuery.isLoading ||
    schedulesQuery.isLoading ||
    candidatesQuery.isLoading ||
    insightsQuery.isLoading;
  const scheduleMutation =
    editingSchedule !== null ? updateScheduleMutation : createScheduleMutation;
  const runActionPending =
    cancelRunMutation.isPending || retryRunMutation.isPending;
  const scheduleActionPending =
    createScheduleMutation.isPending ||
    updateScheduleMutation.isPending ||
    deleteScheduleMutation.isPending;
  const candidateActionPending =
    authorizeCandidateMutation.isPending || retireCandidateMutation.isPending;

  return (
    <main className="h-dvh overflow-hidden bg-background text-foreground">
      <div className="grid h-full min-h-0 grid-cols-[220px_minmax(0,1fr)] max-md:grid-cols-1 max-md:grid-rows-[auto_minmax(0,1fr)]">
        <EvolutionSidebar
          view={view}
          scopes={scopeOptions}
          selectedScopeId={selectedScopeId}
          counts={{
            runs: scopedRuns.length,
            insights: scopedInsights.length,
            candidates: scopedCandidates.length,
            schedules: scopedSchedules.length,
          }}
          providers={providers}
          onSelectView={selectView}
          onSelectScope={selectScope}
          onNavigateHome={onNavigateHome}
        />
        <section className="flex min-h-0 min-w-0 flex-col overflow-hidden">
          <EvolutionHeader
            view={view}
            scopeLabel={selectedScope.label}
            reflectionPending={createRunMutation.isPending}
            onStartReflection={startReflection}
            onOpenSchedule={openScheduleDialog}
          />
          <div className="min-h-0 flex-1 overflow-auto p-5 max-sm:p-3">
            {firstError ? (
              <EvolutionErrorNotice
                message={evolutionErrorMessage(firstError)}
                onRetry={retryQueries}
              />
            ) : null}
            <div className={firstError ? "mt-4" : ""}>
              {initialLoading ? <EvolutionLoadingPanel /> : null}
              {!initialLoading && view === "overview" ? (
                <EvolutionOverview
                  runs={scopedRuns}
                  insights={scopedInsights}
                  candidates={scopedCandidates}
                  schedules={scopedSchedules}
                  providers={providers}
                  runtimeAvailable={
                    providersQuery.data?.runtimeAvailable ?? false
                  }
                  scopeLabel={selectedScope.label}
                  onSelectRun={selectRun}
                  onSelectView={selectView}
                />
              ) : null}
              {!initialLoading && view === "runs" ? (
                <EvolutionRunsPanel
                  runs={scopedRuns}
                  scopeLabel={selectedScope.label}
                  selectedRunId={selectedRunId}
                  traces={scopedTraces}
                  artifacts={artifactsQuery.data}
                  actionPending={runActionPending}
                  onSelectRun={selectRun}
                  onCancelRun={cancelRunMutation.mutate}
                  onRetryRun={retryRunMutation.mutate}
                />
              ) : null}
              {!initialLoading && view === "insights" ? (
                <EvolutionInsightsPanel insights={scopedInsights} />
              ) : null}
              {!initialLoading && view === "candidates" ? (
                <EvolutionCandidatesPanel
                  candidates={scopedCandidates}
                  policy={policyQuery.data}
                  selectedScopeId={selectedScopeId}
                  policyPending={policyMutation.isPending}
                  candidateActionPending={candidateActionPending}
                  onUpdateCanary={updateCanary}
                  onAuthorizeCandidate={authorizeCandidate}
                  onRetireCandidate={retireCandidate}
                />
              ) : null}
              {!initialLoading && view === "schedules" ? (
                <EvolutionSchedulesPanel
                  schedules={scopedSchedules}
                  actionPending={scheduleActionPending}
                  onEdit={editSchedule}
                  onToggle={toggleSchedule}
                  onDelete={removeSchedule}
                />
              ) : null}
            </div>
          </div>
        </section>
      </div>

      {scheduleDialogOpen ? (
        <EvolutionScheduleDialog
          key={editingSchedule?.scheduleId ?? "new"}
          open
          pending={scheduleMutation.isPending}
          error={
            scheduleMutation.error
              ? evolutionErrorMessage(scheduleMutation.error)
              : null
          }
          schedule={editingSchedule}
          initialProjectId={selectedScopeId}
          onOpenChange={(open) => {
            if (!open) closeScheduleDialog();
          }}
          onSubmit={submitSchedule}
        />
      ) : null}
      {retiringCandidate ? (
        <RetireEvolutionCandidateDialog
          candidate={retiringCandidate}
          pending={retireCandidateMutation.isPending}
          error={
            retireCandidateMutation.error
              ? evolutionErrorMessage(retireCandidateMutation.error)
              : null
          }
          onOpenChange={(open) => {
            if (!open) closeRetireCandidateDialog();
          }}
          onSubmit={(reason) => {
            retireCandidateMutation.mutate({
              candidateId: retiringCandidate.assetId,
              reason,
            });
          }}
        />
      ) : null}
    </main>
  );
}
