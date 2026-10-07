import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type {
  DevResourcesSnapshot,
  ReleaseDevResourceRequest,
  ReleaseDevResourceResult,
} from "@runweave/shared/dev-resources";
import { DevResourceError, runDevResourceControl } from "./control";

interface OperationRecord {
  resourceId: string;
  ownerId: string | null;
  generation: string;
  request: ReleaseDevResourceRequest;
  result: ReleaseDevResourceResult;
  pid: number | null;
  signature: string | null;
  status: number;
}

function signature(pid: number): string {
  try {
    return execFileSync(
      "ps",
      ["-p", String(pid), "-o", "lstart=", "-o", "command="],
      {
        encoding: "utf8",
        timeout: 2000,
        env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" },
      },
    ).trim();
  } catch {
    return "";
  }
}

export class DevResourcesService {
  private readonly generation = randomUUID();
  private readonly directory = path.join(
    os.homedir(),
    ".runweave",
    "dev-resources",
    "operations",
  );
  private readonly running = new Map<
    string,
    Promise<ReleaseDevResourceResult>
  >();
  private disposed = false;
  private readonly activeResources = new Map<string, string>();

  private async safeDirectory(create = false): Promise<boolean> {
    let current = os.homedir();
    for (const name of [".runweave", "dev-resources", "operations"]) {
      current = path.join(current, name);
      if (create)
        await fs.mkdir(current, { mode: 0o700 }).catch((error) => {
          if (error.code !== "EEXIST") throw error;
        });
      try {
        const stat = await fs.lstat(current);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new DevResourceError(503, "操作记录目录不安全");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    }
    return true;
  }

  private file(key: string): string {
    return path.join(
      this.directory,
      createHash("sha256").update(key).digest("hex") + ".json",
    );
  }

  private async read(file: string): Promise<OperationRecord> {
    const handle = await fs.open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 16_384)
        throw new DevResourceError(503, "操作记录无法读取");
      const value = JSON.parse(
        await handle.readFile("utf8"),
      ) as OperationRecord;
      if (
        !value.request?.idempotencyKey ||
        !value.result?.operationId ||
        !value.resourceId
      )
        throw new DevResourceError(503, "操作记录无效");
      return value;
    } finally {
      await handle.close();
    }
  }

  private async save(file: string, record: OperationRecord): Promise<void> {
    const temporary = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(record), {
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(temporary, file);
  }

  async getSnapshot(): Promise<DevResourcesSnapshot> {
    const snapshot = await runDevResourceControl<DevResourcesSnapshot>({
      command: "inspect",
      generation: this.generation,
      backendPid: process.pid,
    });
    if (!(await this.safeDirectory())) return snapshot;
    const resources = [
      ...snapshot.desktop.resources,
      ...snapshot.desktop.sessions,
      ...snapshot.simulators.resources,
    ];
    const entries = await fs.readdir(this.directory);
    if (entries.length > 2048)
      throw new DevResourceError(
        503,
        "释放操作记录超过安全扫描上限，无法确认进行中的清理",
      );
    for (const entry of entries.slice(-2048)) {
      if (!/^[a-f0-9]{64}\.json$/.test(entry)) continue;
      try {
        const record = await this.read(path.join(this.directory, entry));
        if (!["running", "unknown"].includes(record.result.state)) continue;
        const resource = resources.find(
          (item) => item.id === record.resourceId,
        );
        if (!resource || resource.state === "free") continue;
        if (
          record.ownerId !== resource.owner?.id ||
          (record.generation === this.generation &&
            record.request.expectedOwnershipVersion !==
              resource.ownershipVersion)
        )
          continue;
        // A live helper may survive its Backend, but must still belong to this owner.
        const alive =
          record.pid &&
          record.signature &&
          signature(record.pid) === record.signature;
        resource.operation = {
          id: record.result.operationId,
          state: alive ? "running" : "unknown",
        };
        resource.release = alive
          ? { action: null, disabledReason: "正在释放，请稍后手动刷新" }
          : resource.release;
        if (!alive)
          resource.reason =
            "上次操作结果尚未确认；请检查当前占用，再重新确认清理";
      } catch {
        throw new DevResourceError(503, "操作记录损坏，无法确认进行中的清理");
      }
    }
    return snapshot;
  }

  async release(
    resourceId: string,
    request: ReleaseDevResourceRequest,
  ): Promise<ReleaseDevResourceResult> {
    if (this.disposed) throw new DevResourceError(503, "Backend 正在停止");
    await this.safeDirectory(true);
    const file = this.file(request.idempotencyKey);
    const existingFile = await fs.lstat(file).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!existingFile) {
      const activeKey = this.activeResources.get(resourceId);
      if (activeKey && activeKey !== request.idempotencyKey)
        throw new DevResourceError(409, "该资源已有释放操作进行中");
    }
    const current = existingFile
      ? null
      : await runDevResourceControl<DevResourcesSnapshot>({
          command: "inspect",
          generation: this.generation,
          backendPid: process.pid,
        });
    const resource =
      current &&
      [
        ...current.desktop.resources,
        ...current.desktop.sessions,
        ...current.simulators.resources,
      ].find((item) => item.id === resourceId);
    if (
      current &&
      (!resource ||
        resource.ownershipVersion !== request.expectedOwnershipVersion)
    )
      throw new DevResourceError(409, "占用者已变化，请手动刷新后重新确认");
    const activeKey = this.activeResources.get(resourceId);
    if (!existingFile && activeKey && activeKey !== request.idempotencyKey)
      throw new DevResourceError(409, "该资源已有释放操作进行中");
    const record: OperationRecord = {
      resourceId,
      request,
      ownerId: resource?.owner?.id ?? null,
      generation: this.generation,
      result: {
        operationId: randomUUID(),
        state: "running",
        message: "正在核对占用并释放资源",
      },
      pid: null,
      signature: null,
      status: 200,
    };
    if (!existingFile)
      this.activeResources.set(resourceId, request.idempotencyKey);
    try {
      await fs.writeFile(file, JSON.stringify(record), {
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        this.activeResources.delete(resourceId);
        throw error;
      }
      if (
        !this.running.has(request.idempotencyKey) &&
        this.activeResources.get(resourceId) === request.idempotencyKey
      )
        this.activeResources.delete(resourceId);
      const existing = await this.read(file);
      if (
        existing.resourceId !== resourceId ||
        JSON.stringify(existing.request) !== JSON.stringify(request)
      )
        throw new DevResourceError(409, "幂等键已用于另一请求");
      if ([409, 404, 503].includes(existing.status))
        throw new DevResourceError(existing.status, existing.result.message);
      if (
        existing.result.state === "running" &&
        !this.running.has(request.idempotencyKey) &&
        (!existing.pid ||
          !existing.signature ||
          signature(existing.pid) !== existing.signature)
      ) {
        return {
          ...existing.result,
          state: "unknown",
          message: "上次操作结果尚未确认，请手动刷新核查",
        };
      }
      return existing.result;
    }
    const work = (async () => {
      try {
        const result = await runDevResourceControl<
          Omit<ReleaseDevResourceResult, "operationId">
        >(
          {
            command: "release",
            ...request,
            resourceId,
            generation: this.generation,
            backendPid: process.pid,
          },
          async (pid) => {
            record.pid = pid;
            record.signature = signature(pid);
            await this.save(file, record);
          },
        );
        record.result = { ...result, operationId: record.result.operationId };
      } catch (error) {
        record.status = error instanceof DevResourceError ? error.status : 200;
        record.result = {
          ...record.result,
          state: "blocked",
          message: error instanceof Error ? error.message : "资源清理未完成",
        };
      }
      await this.save(file, record);
      if (
        record.status === 409 ||
        record.status === 404 ||
        record.status === 503
      )
        throw new DevResourceError(record.status, record.result.message);
      return record.result;
    })();
    this.running.set(request.idempotencyKey, work);
    void work
      .finally(() => {
        this.running.delete(request.idempotencyKey);
        if (this.activeResources.get(resourceId) === request.idempotencyKey)
          this.activeResources.delete(resourceId);
      })
      .catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<ReleaseDevResourceResult>((resolve) => {
          timer = setTimeout(() => resolve(record.result), 30_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.allSettled([...this.running.values()]);
  }
}
