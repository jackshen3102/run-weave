import { useState, type FormEvent, type ReactNode } from "react";
import { useMemoizedFn } from "ahooks";
import type {
  AnalysisProfile,
  CandidateAsset,
  CreateEvolutionScheduleRequest,
  EvolutionSchedule,
  ProviderPolicy,
  UpdateEvolutionScheduleRequest,
} from "@runweave/shared/evolution";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";

const PROFILE_OPTIONS: Array<{ value: AnalysisProfile; label: string }> = [
  { value: "quick", label: "Quick" },
  { value: "standard", label: "Standard" },
  { value: "deep", label: "Deep" },
];

const PROVIDER_OPTIONS: Array<{ value: ProviderPolicy; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "codex", label: "Codex" },
  { value: "trae", label: "Trae" },
  { value: "mixed", label: "Mixed" },
];

function FormField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function SelectField({
  value,
  onChange,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <select
      className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {children}
    </select>
  );
}

export function EvolutionScheduleDialog({
  open,
  pending,
  error,
  schedule,
  initialProjectId,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  pending: boolean;
  error: string | null;
  schedule: EvolutionSchedule | null;
  initialProjectId: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (
    input: CreateEvolutionScheduleRequest | UpdateEvolutionScheduleRequest,
  ) => void;
}) {
  const [projectId, setProjectId] = useState(
    schedule?.learningScopeId ?? initialProjectId,
  );
  const [name, setName] = useState(schedule?.name ?? "");
  const [cronExpression, setCronExpression] = useState(
    schedule?.cronExpression ?? "0 10 * * 1",
  );
  const [timezone, setTimezone] = useState(
    schedule?.timezone ??
      Intl.DateTimeFormat().resolvedOptions().timeZone ??
      "UTC",
  );
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
  const [profile, setProfile] = useState<AnalysisProfile>(
    schedule?.profile ?? "standard",
  );
  const [providerPolicy, setProviderPolicy] = useState<ProviderPolicy>(
    schedule?.providerPolicy ?? "auto",
  );
  const [dataWindow, setDataWindow] = useState(
    schedule?.dataWindow ?? "since_last_success",
  );

  const submit = useMemoizedFn((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const shared = {
      name: name.trim(),
      cronExpression: cronExpression.trim(),
      timezone: timezone.trim(),
      enabled,
      profile,
      providerPolicy,
      dataWindow: dataWindow.trim(),
    };
    onSubmit(schedule ? shared : { ...shared, projectId: projectId.trim() });
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-xl overflow-auto">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>
              {schedule ? "编辑运行计划" : "新建运行计划"}
            </DialogTitle>
            <DialogDescription>
              Schedule 持久化在 Evolution
              数据库；cron、时区与数据窗口按原值提交给 Backend。
            </DialogDescription>
          </DialogHeader>

          <div className="mt-6 grid gap-5 sm:grid-cols-2">
            {!schedule ? (
              <FormField label="Project ID">
                <Input
                  required
                  value={projectId}
                  onChange={(event) => setProjectId(event.target.value)}
                />
              </FormField>
            ) : null}
            <FormField label="名称">
              <Input
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="每周增量反思"
              />
            </FormField>
            <FormField label="Cron">
              <Input
                required
                value={cronExpression}
                onChange={(event) => setCronExpression(event.target.value)}
                placeholder="0 10 * * 1"
              />
            </FormField>
            <FormField label="时区">
              <Input
                required
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
                placeholder="Asia/Shanghai"
              />
            </FormField>
            <FormField label="数据窗口">
              <Input
                required
                value={dataWindow}
                onChange={(event) => setDataWindow(event.target.value)}
                placeholder="since_last_success"
              />
            </FormField>
            <FormField label="Profile">
              <SelectField
                value={profile}
                onChange={(value) => setProfile(value as AnalysisProfile)}
              >
                {PROFILE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </SelectField>
            </FormField>
            <FormField label="Provider policy">
              <SelectField
                value={providerPolicy}
                onChange={(value) => setProviderPolicy(value as ProviderPolicy)}
              >
                {PROVIDER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </SelectField>
            </FormField>
            <label className="flex items-center gap-3 text-sm sm:col-span-2">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
              />
              创建后启用 Schedule
            </label>
          </div>

          {error ? (
            <p className="mt-4 text-sm text-red-600" role="alert">
              {error}
            </p>
          ) : null}
          <DialogFooter className="mt-6">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button
              type="submit"
              disabled={
                pending ||
                !name.trim() ||
                !cronExpression.trim() ||
                !timezone.trim() ||
                (!schedule && !projectId.trim())
              }
            >
              {pending ? "保存中…" : schedule ? "保存" : "创建 Schedule"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RetireEvolutionCandidateDialog({
  candidate,
  pending,
  error,
  onOpenChange,
  onSubmit,
}: {
  candidate: CandidateAsset;
  pending: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState("scope owner rollback");

  const submit = useMemoizedFn((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit(reason.trim());
  });

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>退休 / 回滚 Memory</DialogTitle>
            <DialogDescription>
              退休 {candidate.assetId} 后，后续任务不会再检索或注入该 revision。
              历史 RuntimeTrace 会保留用于审计。
            </DialogDescription>
          </DialogHeader>

          <div className="mt-6">
            <FormField label="回滚原因">
              <Input
                required
                autoFocus
                maxLength={500}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </FormField>
          </div>

          {error ? (
            <p className="mt-4 text-sm text-red-600" role="alert">
              {error}
            </p>
          ) : null}
          <DialogFooter className="mt-6">
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={pending || !reason.trim()}
            >
              {pending ? "回滚中…" : "确认退休"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
