import { useEffect, useRef, useState } from "react";
import { useMemoizedFn, useDebounce } from "ahooks";
import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  CreateScheduledTaskRequest,
  ScheduledTask,
  ScheduledTaskCapabilities,
  TaskSchedule,
} from "@runweave/shared/scheduled-tasks";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "../../components/ui/dialog";
import { TaskModelSettings } from "./model-settings";
import { TaskProjectSelect } from "./project-select";
import { useScheduledApi, useRefreshTasks, scheduledKeys } from "./queries";
import { displayTime, fieldClass, RequestError } from "./presentation";

export function TaskEditor({
  task,
  defaultProjectId,
  capabilities,
  onClose,
  onSaved,
}: {
  task?: ScheduledTask;
  defaultProjectId: string;
  capabilities: ScheduledTaskCapabilities;
  onClose: () => void;
  onSaved: (task: ScheduledTask) => void;
}) {
  const { api, scope } = useScheduledApi();
  const refresh = useRefreshTasks();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [draft, setDraft] = useState<CreateScheduledTaskRequest>(() => ({
    name: task?.name ?? "",
    projectId: task?.projectId ?? defaultProjectId,
    provider: task?.provider ?? "codex",
    prompt: task?.prompt ?? "",
    model: task?.model ?? "",
    effort: task?.effort ?? "",
    executionPolicy: task?.executionPolicy,
    misfirePolicy: task
      ? task.misfirePolicy
      : { mode: "catch-up-latest", maxDelaySeconds: 86400 },
    enabled: task?.enabled ?? true,
    schedule: task?.schedule ?? {
      kind: "daily",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      localTime: "09:00",
    },
  }));
  const [validationError, setValidationError] = useState<string | null>(null);
  const requestIdentity = useRef<{ body: string; key: string } | null>(null);
  const provider = capabilities.providers.find(
    (item) => item.provider === draft.provider,
  );
  const schedule = useDebounce(draft.schedule, { wait: 350 });
  const preview = useQuery({
    queryKey: [...scheduledKeys.all(scope), "preview", schedule],
    queryFn: ({ signal }) => api.preview(schedule, signal),
    enabled: schedule.kind !== "once" || Boolean(schedule.runAt),
    staleTime: 0,
  });
  const save = useMutation({
    mutationFn: async () => {
      const body = {
        ...draft,
        name: draft.name.trim(),
        prompt: draft.prompt.trim(),
        model: draft.model?.trim() || undefined,
        effort: draft.effort?.trim() || undefined,
      };
      if (task)
        return api.update(task.id, {
          ...body,
          expectedRevision: task.revision,
          model: body.model ?? null,
          effort: body.effort ?? null,
        });
      const serialized = JSON.stringify(body);
      if (requestIdentity.current?.body !== serialized)
        requestIdentity.current = {
          body: serialized,
          key: crypto.randomUUID(),
        };
      return api.create(body, requestIdentity.current.key);
    },
    onSuccess: (result) => {
      void refresh();
      if (mounted.current) onSaved(result);
    },
    onError: () => {
      void refresh();
    },
  });
  const change = <K extends keyof CreateScheduledTaskRequest>(
    key: K,
    value: CreateScheduledTaskRequest[K],
  ) => setDraft((current) => ({ ...current, [key]: value }));
  const changeKind = (kind: TaskSchedule["kind"]) => {
    const timezone = draft.schedule.timezone;
    const localTime =
      "localTime" in draft.schedule ? draft.schedule.localTime : "09:00";
    change(
      "schedule",
      kind === "once"
        ? { kind, timezone, runAt: "" }
        : kind === "weekly"
          ? { kind, timezone, localTime, weekdays: [1] }
          : { kind, timezone, localTime },
    );
  };
  const submit = useMemoizedFn((event: React.FormEvent) => {
    event.preventDefault();
    if (!draft.name.trim() || !draft.prompt.trim() || !draft.projectId) {
      setValidationError("请填写名称、项目和提示词。");
      return;
    }
    if (draft.schedule.kind === "weekly" && !draft.schedule.weekdays.length) {
      setValidationError("请至少选择一个运行日期。");
      return;
    }
    if (
      !capabilities.enabled ||
      !provider?.available ||
      !preview.data ||
      !preview.data.occurrences.length ||
      preview.isError ||
      preview.isFetching ||
      schedule !== draft.schedule
    ) {
      setValidationError("请先选择可用 Agent 并等待时间预览通过。");
      return;
    }
    setValidationError(null);
    save.mutate();
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !save.isPending) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogTitle>{task ? "编辑任务" : "新建定时任务"}</DialogTitle>
        <DialogDescription>
          每次运行建立独立对话，时间预览由当前 Backend 计算。
        </DialogDescription>
        <form className="grid gap-4" onSubmit={submit}>
          <label className="grid gap-1 text-sm">
            任务名称
            <Input
              required
              maxLength={80}
              value={draft.name}
              onChange={(e) => change("name", e.target.value)}
            />
          </label>
          <TaskProjectSelect
            value={draft.projectId}
            onChange={(value) => change("projectId", value)}
          />
          <label className="grid gap-1 text-sm">
            Agent
            <select
              className={fieldClass}
              value={draft.provider}
              onChange={(e) =>
                setDraft((current) => ({
                  ...current,
                  provider: e.target
                    .value as CreateScheduledTaskRequest["provider"],
                  model: "",
                  effort: "",
                }))
              }
            >
              {capabilities.providers.map((item) => (
                <option
                  key={item.provider}
                  value={item.provider}
                  disabled={!item.available}
                >
                  {item.provider === "trae"
                    ? "TraeX"
                    : item.provider === "codex"
                      ? "Codex"
                      : "Pi"}
                  {item.available ? "" : ` · ${item.reason ?? "暂不可用"}`}
                </option>
              ))}
            </select>
          </label>
          {!provider?.available ? (
            <p className="text-sm text-destructive">
              {provider?.reason ?? "当前 Agent 不可用"}
            </p>
          ) : null}
          <TaskModelSettings
            key={draft.provider}
            provider={draft.provider}
            model={draft.model ?? ""}
            effort={draft.effort ?? ""}
            onChange={(model, effort) =>
              setDraft((current) => ({ ...current, model, effort }))
            }
          />
          <label className="grid gap-1 text-sm">
            任务提示词
            <textarea
              className={`${fieldClass} min-h-32`}
              required
              maxLength={12000}
              value={draft.prompt}
              onChange={(e) => change("prompt", e.target.value)}
              placeholder="描述任务、执行要求和期望产出；可以引用 Skill。"
            />
          </label>
          <section className="grid gap-3 rounded-lg border p-3">
            <label className="grid gap-1 text-sm">
              执行权限
              <select
                className={fieldClass}
                value={draft.executionPolicy ?? "sandbox"}
                onChange={(e) =>
                  change(
                    "executionPolicy",
                    e.target
                      .value as CreateScheduledTaskRequest["executionPolicy"],
                  )
                }
              >
                <option value="sandbox">仅沙箱</option>
                <option
                  value="auto-review"
                  disabled={
                    !provider?.executionPolicies?.includes("auto-review")
                  }
                >
                  自动审批
                </option>
              </select>
            </label>
            <p className="text-xs text-muted-foreground">
              {draft.executionPolicy === "auto-review"
                ? "保留沙箱，Git 写入、联网等越界操作由 Codex 自动审查；拒绝或无法审批时记录为受阻。"
                : "可修改工作区普通文件；Git 元数据写入和命令联网受限。需要创建 Worktree、提交或拉取时，可选择自动审批。"}
            </p>
          </section>
          <section className="grid gap-3 rounded-lg border p-3">
            <label className="grid gap-1 text-sm">
              时间规则
              <select
                className={fieldClass}
                value={draft.schedule.kind}
                onChange={(e) =>
                  changeKind(e.target.value as TaskSchedule["kind"])
                }
              >
                <option value="daily">每天</option>
                <option value="weekdays">工作日</option>
                <option value="weekly">每周</option>
                <option value="once">仅一次</option>
              </select>
            </label>
            {draft.schedule.kind === "once" ? (
              <label className="grid gap-1 text-sm">
                执行时间（UTC）
                <Input
                  type="datetime-local"
                  required
                  value={draft.schedule.runAt.slice(0, 16)}
                  onChange={(e) =>
                    change("schedule", {
                      kind: "once",
                      timezone: draft.schedule.timezone,
                      runAt: e.target.value ? `${e.target.value}:00.000Z` : "",
                    })
                  }
                />
                <span className="text-xs text-muted-foreground">
                  下方预览按所选时区显示。
                </span>
              </label>
            ) : (
              <label className="grid gap-1 text-sm">
                当地时间
                <Input
                  type="time"
                  required
                  value={draft.schedule.localTime}
                  onChange={(e) =>
                    change("schedule", {
                      ...draft.schedule,
                      localTime: e.target.value,
                    } as TaskSchedule)
                  }
                />
              </label>
            )}
            {draft.schedule.kind === "weekly" ? (
              <div className="flex flex-wrap gap-3">
                {[1, 2, 3, 4, 5, 6, 0].map((day) => (
                  <label key={day} className="flex items-center gap-1 text-sm">
                    <input
                      type="checkbox"
                      checked={
                        draft.schedule.kind === "weekly" &&
                        draft.schedule.weekdays.includes(day)
                      }
                      onChange={(e) => {
                        if (draft.schedule.kind === "weekly")
                          change("schedule", {
                            ...draft.schedule,
                            weekdays: e.target.checked
                              ? [...draft.schedule.weekdays, day]
                              : draft.schedule.weekdays.filter(
                                  (d) => d !== day,
                                ),
                          });
                      }}
                    />
                    周{"日一二三四五六"[day]}
                  </label>
                ))}
              </div>
            ) : null}
            <label className="grid gap-1 text-sm">
              时区
              <Input
                required
                value={draft.schedule.timezone}
                onChange={(e) =>
                  change("schedule", {
                    ...draft.schedule,
                    timezone: e.target.value,
                  })
                }
                placeholder="Asia/Shanghai"
              />
            </label>
            <div aria-live="polite" className="text-xs text-muted-foreground">
              {preview.isFetching || schedule !== draft.schedule ? (
                "正在计算…"
              ) : preview.data ? (
                <>
                  接下来运行：
                  {preview.data.occurrences.map((at) => (
                    <div key={at}>
                      {displayTime(at, draft.schedule.timezone)}
                    </div>
                  ))}
                  {!preview.data.occurrences.length ? "没有未来执行时间" : null}
                </>
              ) : null}
            </div>
            <RequestError error={preview.error} />
          </section>
          <section className="grid gap-3 rounded-lg border p-3">
            <label className="grid gap-1 text-sm">
              错过执行时间
              <select
                className={fieldClass}
                value={draft.misfirePolicy.mode}
                onChange={(e) =>
                  change(
                    "misfirePolicy",
                    e.target.value === "skip"
                      ? { mode: "skip" }
                      : { mode: "catch-up-latest", maxDelaySeconds: 86400 },
                  )
                }
              >
                <option value="catch-up-latest">恢复后补最近一次</option>
                <option value="skip">错过就跳过</option>
              </select>
            </label>
            {draft.misfirePolicy.mode === "catch-up-latest" ? (
              <label className="grid gap-1 text-sm">
                允许延迟（小时）
                <Input
                  type="number"
                  required
                  min={1}
                  max={168}
                  step={1}
                  value={draft.misfirePolicy.maxDelaySeconds / 3600 || ""}
                  onChange={(e) =>
                    change("misfirePolicy", {
                      mode: "catch-up-latest",
                      maxDelaySeconds: Number(e.target.value) * 3600,
                    })
                  }
                />
              </label>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {draft.misfirePolicy.mode === "catch-up-latest"
                ? "在允许延迟内只补最近一次，更早的安排合并忽略；已有运行时不重复启动。"
                : "超过计划时间 60 秒仍未调度则跳过，等待下一次安排。"}
            </p>
          </section>
          {validationError ? (
            <p role="alert" className="text-sm text-destructive">
              {validationError}
            </p>
          ) : null}
          <RequestError error={save.error} />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={save.isPending}
              onClick={onClose}
            >
              取消
            </Button>
            <Button
              type="submit"
              disabled={
                save.isPending || !capabilities.enabled || !provider?.available
              }
            >
              {save.isPending ? "正在保存…" : "保存任务"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
