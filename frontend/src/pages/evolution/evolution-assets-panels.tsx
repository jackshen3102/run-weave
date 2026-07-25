import { useEffect, useState } from "react";
import { useMemoizedFn } from "ahooks";
import type {
  CandidateAsset,
  EvolutionSchedule,
  EvolutionScopePolicy,
} from "@runweave/shared/evolution";
import { CircleDot, Clock3, ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "../../components/ui/button";
import {
  formatEvolutionDate,
  EvolutionPanel,
  EvolutionStatusPill,
} from "./evolution-page-panels";

export function EvolutionCandidatesPanel({
  candidates,
  policy,
  selectedScopeId,
  policyPending,
  candidateActionPending,
  onUpdateCanary,
  onAuthorizeCandidate,
  onRetireCandidate,
}: {
  candidates: CandidateAsset[];
  policy: EvolutionScopePolicy | undefined;
  selectedScopeId: string;
  policyPending: boolean;
  candidateActionPending: boolean;
  onUpdateCanary: (enabled: boolean, canaryRate: number) => void;
  onAuthorizeCandidate: (candidate: CandidateAsset) => void;
  onRetireCandidate: (candidate: CandidateAsset) => void;
}) {
  const [canaryPercent, setCanaryPercent] = useState(10);
  useEffect(() => {
    if (policy) {
      setCanaryPercent(
        policy.canaryRate > 0 ? Math.round(policy.canaryRate * 100) : 10,
      );
    }
  }, [policy]);
  const updateCanaryPercent = useMemoizedFn(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const value = Number(event.target.value);
      if (Number.isFinite(value)) {
        setCanaryPercent(Math.max(1, Math.min(100, Math.round(value))));
      }
    },
  );
  const applyCanary = useMemoizedFn(() => {
    onUpdateCanary(true, canaryPercent / 100);
  });
  const disableCanary = useMemoizedFn(() => {
    onUpdateCanary(false, 0);
  });

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(280px,0.6fr)]">
      <EvolutionPanel className="overflow-hidden">
        <div className="border-b border-border/70 px-5 py-4">
          <h2 className="font-semibold">候选资产</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {selectedScopeId
              ? `${selectedScopeId} · ${candidates.length} 条`
              : "尚无学习范围"}
          </p>
        </div>
        {candidates.length > 0 ? (
          <div className="divide-y divide-border/60">
            {candidates.map((candidate) => (
              <article
                key={candidate.revisionId}
                className="[content-visibility:auto] p-5"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">{candidate.statement}</p>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                      {candidate.guidance}
                    </p>
                  </div>
                  <EvolutionStatusPill
                    status={candidate.lifecycle}
                    label={candidate.lifecycle}
                  />
                </div>
                <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <span>{candidate.type}</span>
                  <span>·</span>
                  <span>{candidate.evidenceGrade}</span>
                  <span>·</span>
                  <span>{candidate.risk} risk</span>
                  <span>·</span>
                  <span>revision {candidate.revisionId}</span>
                </div>
                {candidate.evidenceRefs.length > 0 ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {candidate.evidenceRefs.slice(0, 4).map((reference) => (
                      <Button
                        key={reference}
                        variant="outline"
                        size="sm"
                        asChild
                      >
                        <Link
                          to={`/activity?view=facts&search=${encodeURIComponent(reference)}`}
                        >
                          {reference}
                        </Link>
                      </Button>
                    ))}
                  </div>
                ) : null}
                {candidate.type === "memory" ? (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {candidate.lifecycle === "shadow" ? (
                      <Button
                        size="sm"
                        disabled={
                          candidateActionPending ||
                          !policy?.memoryCanaryEnabled ||
                          (policy.canaryRate ?? 0) <= 0
                        }
                        onClick={() => onAuthorizeCandidate(candidate)}
                      >
                        授权进入 Canary
                      </Button>
                    ) : null}
                    {candidate.lifecycle !== "retired" &&
                    candidate.lifecycle !== "rejected" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={candidateActionPending}
                        onClick={() => onRetireCandidate(candidate)}
                      >
                        退休 / 回滚
                      </Button>
                    ) : null}
                    {candidate.lifecycle === "shadow" &&
                    !policy?.memoryCanaryEnabled ? (
                      <span className="self-center text-xs text-muted-foreground">
                        先在右侧显式启用 scope policy
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        ) : (
          <p className="p-8 text-center text-sm text-muted-foreground">
            当前范围没有 Candidate；页面不会为填充状态生成示例资产。
          </p>
        )}
      </EvolutionPanel>

      <EvolutionPanel className="h-fit p-5">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4" />
          <h2 className="font-semibold">Memory Canary Policy</h2>
        </div>
        {policy ? (
          <>
            <div className="mt-5 space-y-3 text-sm">
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">真实注入</span>
                <EvolutionStatusPill
                  status={policy.memoryCanaryEnabled ? "canary" : "draft"}
                  label={policy.memoryCanaryEnabled ? "已启用" : "默认关闭"}
                />
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Canary 比例</span>
                <span>{Math.round(policy.canaryRate * 100)}%</span>
              </div>
              <label className="block">
                <span className="text-muted-foreground">
                  设置实验流量（1–100%）
                </span>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    type="number"
                    min={1}
                    max={100}
                    step={1}
                    value={canaryPercent}
                    disabled={policyPending}
                    onChange={updateCanaryPercent}
                  />
                  <span className="text-muted-foreground">%</span>
                </div>
              </label>
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">单次资产上限</span>
                <span>{policy.maxInjectedAssets}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">单次字节上限</span>
                <span>{policy.maxInjectionBytes}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Policy revision</span>
                <span>{policy.revision}</span>
              </div>
            </div>
            <Button
              className="mt-5 w-full"
              variant="default"
              disabled={policyPending}
              onClick={applyCanary}
            >
              {policy.memoryCanaryEnabled
                ? `更新为 ${canaryPercent}%`
                : `启用 ${canaryPercent}% Canary`}
            </Button>
            {policy.memoryCanaryEnabled ? (
              <Button
                className="mt-2 w-full"
                variant="outline"
                disabled={policyPending}
                onClick={disableCanary}
              >
                关闭真实注入
              </Button>
            ) : null}
          </>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">
            选择已有学习范围后读取真实策略。
          </p>
        )}
      </EvolutionPanel>
    </div>
  );
}

export function EvolutionSchedulesPanel({
  schedules,
  actionPending,
  onEdit,
  onToggle,
  onDelete,
}: {
  schedules: EvolutionSchedule[];
  actionPending: boolean;
  onEdit: (schedule: EvolutionSchedule) => void;
  onToggle: (schedule: EvolutionSchedule) => void;
  onDelete: (schedule: EvolutionSchedule) => void;
}) {
  return (
    <EvolutionPanel className="overflow-hidden">
      <div className="border-b border-border/70 px-5 py-4">
        <h2 className="font-semibold">持久化运行计划</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Schedule 与手动触发共享同一个 Evolution Run 服务
        </p>
      </div>
      {schedules.length > 0 ? (
        <div className="divide-y divide-border/60">
          {schedules.map((schedule) => (
            <article
              key={schedule.scheduleId}
              className="flex flex-wrap items-center justify-between gap-4 p-5"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-medium">{schedule.name}</h3>
                  <EvolutionStatusPill
                    status={schedule.enabled ? "available" : "draft"}
                    label={schedule.enabled ? "已启用" : "已停用"}
                  />
                </div>
                <p className="mt-2 text-sm text-muted-foreground">
                  <Clock3 className="mr-1 inline h-3.5 w-3.5" />
                  {schedule.cronExpression} · {schedule.timezone} ·{" "}
                  {schedule.dataWindow}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {schedule.learningScopeId} · {schedule.profile} ·{" "}
                  {schedule.providerPolicy} · 下次{" "}
                  {formatEvolutionDate(schedule.nextDueAt)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={actionPending}
                  onClick={() => onToggle(schedule)}
                >
                  {schedule.enabled ? "停用" : "启用"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={actionPending}
                  onClick={() => onEdit(schedule)}
                >
                  编辑
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={actionPending}
                  onClick={() => onDelete(schedule)}
                >
                  删除
                </Button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="flex min-h-72 items-center justify-center p-8 text-center">
          <div>
            <CircleDot className="mx-auto h-6 w-6 text-muted-foreground" />
            <h2 className="mt-4 font-semibold">尚未配置 Schedule</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              使用页面右上角“运行计划”创建真实持久化计划。
            </p>
          </div>
        </div>
      )}
    </EvolutionPanel>
  );
}
