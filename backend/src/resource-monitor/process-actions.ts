import type {
  TerminateProcessRequest,
  TerminateProcessResult,
} from "@runweave/shared/resource-monitor";
import type { RuntimeStatusWorkspaceServiceManager as WorkspaceServiceManager } from "../runtime-status/workspace-service-manager";
import {
  readIdentity,
  protectionReason,
  type ProcessIdentity,
} from "./sampler";

export class ResourceRequestError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export class ProcessActions {
  private requests = new Map<
    string,
    {
      target: string;
      force: boolean;
      until: number;
      result: Promise<TerminateProcessResult>;
    }
  >();
  private forcePermissions = new Map<string, number>();
  private inFlight = new Set<Promise<unknown>>();
  private closing = false;
  constructor(
    private manager: WorkspaceServiceManager,
    private getIdentity: (id: string) => ProcessIdentity | undefined,
  ) {}
  terminate(
    id: string,
    input: TerminateProcessRequest,
    session: string,
    authorized: () => boolean,
  ): Promise<TerminateProcessResult> {
    if (this.closing)
      throw new ResourceRequestError(503, "closing", "资源监控正在关闭");
    const now = Date.now();
    for (const [key, entry] of this.requests)
      if (entry.until < now) this.requests.delete(key);
    for (const [key, until] of this.forcePermissions)
      if (until < now) this.forcePermissions.delete(key);
    const key = `${session}:${input.requestId}`;
    const existing = this.requests.get(key);
    if (existing) {
      if (existing.target !== id || existing.force !== input.force)
        throw new ResourceRequestError(
          409,
          "request_conflict",
          "请求标识已用于另一个操作",
        );
      return existing.result;
    }
    if (this.requests.size >= 200)
      throw new ResourceRequestError(429, "busy", "操作请求过多，请稍后重试");
    const result = this.perform(id, input, session, authorized);
    this.requests.set(key, {
      target: id,
      force: input.force,
      until: now + 600_000,
      result,
    });
    this.inFlight.add(result);
    void result
      .finally(() => this.inFlight.delete(result))
      .catch(() => undefined);
    return result;
  }
  private async perform(
    id: string,
    input: TerminateProcessRequest,
    session: string,
    authorized: () => boolean,
  ): Promise<TerminateProcessResult> {
    const identity = this.getIdentity(id);
    if (!identity)
      throw new ResourceRequestError(
        404,
        "unknown_process",
        "进程不在当前快照中，请刷新后选择",
      );
    if (Date.now() - identity.sampledAt > 180_000)
      throw new ResourceRequestError(
        409,
        "stale_process",
        "进程快照已过期，请刷新后选择",
      );
    if (identity.actionKind === "readonly")
      throw new ResourceRequestError(
        403,
        "protected_process",
        identity.actionReason ?? "该进程受保护",
      );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    const forceKey = `${session}:${id}`;
    const response = (
      state: TerminateProcessResult["state"],
      message: string,
      forceAllowed = false,
    ): TerminateProcessResult => ({
      requestId: input.requestId,
      processInstanceId: id,
      state,
      message,
      forceAllowed,
    });
    try {
      const current = await readIdentity(identity.pid, controller.signal);
      if (!authorized())
        throw new ResourceRequestError(401, "unauthorized", "会话已失效");
      if (!current) return response("already_exited", "进程已退出");
      if (current.processInstanceId !== id)
        throw new ResourceRequestError(
          409,
          "identity_changed",
          "进程身份已变化，请重新选择",
        );
      const reason = protectionReason(current, new Set([process.pid]));
      if (reason && identity.actionKind !== "stop_service")
        throw new ResourceRequestError(403, "protected_process", reason);
      if (
        input.force &&
        (this.forcePermissions.get(forceKey) ?? 0) < Date.now()
      )
        throw new ResourceRequestError(
          409,
          "force_not_allowed",
          "先请求结束并核对仍在运行，再确认强制结束",
        );
      const service = this.manager.findOwnedProcess(identity.pid);
      if (identity.actionKind === "stop_service") {
        if (!service || input.force)
          throw new ResourceRequestError(
            409,
            "service_changed",
            "托管服务身份已变化，请重新选择",
          );
        await this.manager.stop(service);
      } else {
        try {
          process.kill(identity.pid, input.force ? "SIGKILL" : "SIGTERM");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH")
            return response("already_exited", "进程已退出");
          throw new ResourceRequestError(
            403,
            "signal_denied",
            "没有结束该进程的权限",
          );
        }
      }
      const deadline = Date.now() + 3_000;
      do {
        const remaining = await readIdentity(identity.pid, controller.signal);
        if (!remaining || remaining.processInstanceId !== id) {
          this.forcePermissions.delete(forceKey);
          return response(
            "exited",
            "已结束；其他进程保持运行，电池功率将在下次采样更新",
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      if (!input.force && identity.actionKind === "terminate")
        this.forcePermissions.set(forceKey, Date.now() + 180_000);
      return response(
        "still_running",
        "仍在运行",
        !input.force && identity.actionKind === "terminate",
      );
    } catch (error) {
      if (error instanceof ResourceRequestError) throw error;
      throw new ResourceRequestError(
        503,
        "verification_failed",
        "无法验证退出结果，请刷新查看；没有自动强制结束",
      );
    } finally {
      clearTimeout(timer);
    }
  }
  async dispose(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.inFlight]);
  }
}
