import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  buildTerminalChildProjectId,
  parseTerminalChildProjectId,
  type TerminalProjectContextAvailability,
} from "@runweave/shared/terminal/project-context";
import type {
  TerminalProjectContextRecord,
  TerminalProjectRecord,
  TerminalSessionRecord,
} from "./manager-records";

interface GitWorktreeRecord {
  worktreePath: string;
  head: string | null;
  branch: string | null;
}

function runGitWorktreeList(projectPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", projectPath, "worktree", "list", "--porcelain", "-z"],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function parseGitWorktreeList(output: string): GitWorktreeRecord[] {
  const records: GitWorktreeRecord[] = [];
  let current: GitWorktreeRecord | null = null;
  const commitCurrent = (): void => {
    if (current?.worktreePath) {
      records.push(current);
    }
    current = null;
  };

  for (const rawField of output.split("\0")) {
    const field = rawField.replace(/^\n+|\n+$/gu, "");
    if (!field) {
      commitCurrent();
      continue;
    }
    if (field.startsWith("worktree ")) {
      commitCurrent();
      current = {
        worktreePath: field.slice("worktree ".length),
        head: null,
        branch: null,
      };
      continue;
    }
    if (!current) {
      continue;
    }
    if (field.startsWith("HEAD ")) {
      current.head = field.slice("HEAD ".length) || null;
      continue;
    }
    if (field.startsWith("branch ")) {
      const branch = field.slice("branch ".length);
      current.branch = branch.startsWith("refs/heads/")
        ? branch.slice("refs/heads/".length)
        : branch || null;
    }
  }
  commitCurrent();
  return records;
}

function isDirectChild(relativePath: string): boolean {
  return (
    relativePath.length > 0 &&
    relativePath !== "." &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath) &&
    path.dirname(relativePath) === "."
  );
}

function contextAvailability(
  parent: TerminalProjectRecord,
): TerminalProjectContextAvailability {
  return parent.path ? "available" : "path_unavailable";
}

export class WorktreeProjectRegistry {
  private readonly contextsByParentProjectId = new Map<
    string,
    Map<string, TerminalProjectContextRecord>
  >();

  clear(parentProjectId: string): void {
    this.contextsByParentProjectId.delete(parentProjectId);
  }

  get(projectId: string): TerminalProjectContextRecord | undefined {
    const parsed = parseTerminalChildProjectId(projectId);
    return parsed
      ? this.contextsByParentProjectId
          .get(parsed.parentProjectId)
          ?.get(projectId)
      : undefined;
  }

  list(parentProjectId: string): TerminalProjectContextRecord[] {
    return Array.from(
      this.contextsByParentProjectId.get(parentProjectId)?.values() ?? [],
    );
  }

  async refresh(
    parent: TerminalProjectRecord,
    sessions: TerminalSessionRecord[],
  ): Promise<TerminalProjectContextRecord[]> {
    const contexts = new Map<string, TerminalProjectContextRecord>();
    const discovery = parent.path
      ? await this.discover(parent).catch(() => ({
          primaryBranch: null,
          primaryHead: null,
          contexts: [],
        }))
      : { primaryBranch: null, primaryHead: null, contexts: [] };
    contexts.set(parent.id, {
      id: parent.id,
      projectId: parent.id,
      parentProjectId: parent.id,
      name: parent.name,
      branch: discovery.primaryBranch,
      head: discovery.primaryHead,
      path: parent.path,
      isPrimary: true,
      pinned: true,
      pinOrder: -1,
      availability: contextAvailability(parent),
      createdAt: parent.createdAt,
      isDefault: parent.isDefault,
      pinnedChildProjectIds: [...parent.pinnedChildProjectIds],
    });

    for (const context of discovery.contexts) {
      contexts.set(context.projectId, context);
    }

    for (const session of sessions) {
      const parsed = parseTerminalChildProjectId(session.projectId);
      if (
        parsed?.parentProjectId !== parent.id ||
        contexts.has(session.projectId)
      ) {
        continue;
      }
      const pinOrder = parent.pinnedChildProjectIds.indexOf(session.projectId);
      contexts.set(session.projectId, {
        id: session.projectId,
        projectId: session.projectId,
        parentProjectId: parent.id,
        name: parsed.worktreeName,
        branch: null,
        head: null,
        path: null,
        isPrimary: false,
        pinned: pinOrder >= 0,
        pinOrder: pinOrder >= 0 ? pinOrder : null,
        availability: "missing",
        createdAt: parent.createdAt,
        isDefault: false,
        pinnedChildProjectIds: [],
      });
    }

    this.contextsByParentProjectId.set(parent.id, contexts);
    return this.sort(parent, Array.from(contexts.values()), sessions);
  }

  sort(
    parent: TerminalProjectRecord,
    contexts: TerminalProjectContextRecord[],
    sessions: TerminalSessionRecord[],
  ): TerminalProjectContextRecord[] {
    const lastActivityByProjectId = new Map<string, number>();
    for (const session of sessions) {
      lastActivityByProjectId.set(
        session.projectId,
        Math.max(
          lastActivityByProjectId.get(session.projectId) ?? 0,
          session.lastActivityAt.getTime(),
        ),
      );
    }
    const pinnedOrder = new Map(
      parent.pinnedChildProjectIds.map((projectId, index) => [projectId, index]),
    );
    return [...contexts].sort((left, right) => {
      if (left.isPrimary !== right.isPrimary) {
        return left.isPrimary ? -1 : 1;
      }
      const leftPin = pinnedOrder.get(left.projectId);
      const rightPin = pinnedOrder.get(right.projectId);
      if ((leftPin !== undefined) !== (rightPin !== undefined)) {
        return leftPin !== undefined ? -1 : 1;
      }
      if (leftPin !== undefined && rightPin !== undefined && leftPin !== rightPin) {
        return leftPin - rightPin;
      }
      const activityDifference =
        (lastActivityByProjectId.get(right.projectId) ?? 0) -
        (lastActivityByProjectId.get(left.projectId) ?? 0);
      return activityDifference || left.name.localeCompare(right.name);
    });
  }

  private async discover(
    parent: TerminalProjectRecord,
  ): Promise<{
    primaryBranch: string | null;
    primaryHead: string | null;
    contexts: TerminalProjectContextRecord[];
  }> {
    if (!parent.path) {
      return { primaryBranch: null, primaryHead: null, contexts: [] };
    }
    const parentRealPath = await realpath(parent.path);
    const records = parseGitWorktreeList(
      await runGitWorktreeList(parentRealPath),
    );
    let primaryBranch: string | null = null;
    let primaryHead: string | null = null;
    for (const record of records) {
      const resolvedRecordPath = await realpath(record.worktreePath).catch(
        () => null,
      );
      if (resolvedRecordPath === parentRealPath) {
        primaryBranch = record.branch;
        primaryHead = record.head;
        break;
      }
    }
    const expectedWorktreeRoot = path.join(parentRealPath, ".worktree");
    const worktreeRootRealPath = await realpath(expectedWorktreeRoot).catch(
      () => null,
    );
    if (
      !worktreeRootRealPath ||
      path.relative(parentRealPath, worktreeRootRealPath) !== ".worktree"
    ) {
      return { primaryBranch, primaryHead, contexts: [] };
    }
    const contexts: TerminalProjectContextRecord[] = [];
    for (const record of records) {
      const lexicalRelativePath = path.relative(
        expectedWorktreeRoot,
        path.resolve(record.worktreePath),
      );
      if (!isDirectChild(lexicalRelativePath)) {
        continue;
      }
      const resolvedWorktreePath = await realpath(record.worktreePath).catch(
        () => null,
      );
      if (!resolvedWorktreePath) {
        continue;
      }
      const realRelativePath = path.relative(
        worktreeRootRealPath,
        resolvedWorktreePath,
      );
      if (!isDirectChild(realRelativePath)) {
        continue;
      }
      const worktreeName = realRelativePath.normalize("NFC");
      const projectId = buildTerminalChildProjectId(parent.id, worktreeName);
      const pinOrder = parent.pinnedChildProjectIds.indexOf(projectId);
      contexts.push({
        id: projectId,
        projectId,
        parentProjectId: parent.id,
        name: worktreeName,
        branch: record.branch,
        head: record.head,
        path: resolvedWorktreePath,
        isPrimary: false,
        pinned: pinOrder >= 0,
        pinOrder: pinOrder >= 0 ? pinOrder : null,
        availability: "available",
        createdAt: parent.createdAt,
        isDefault: false,
        pinnedChildProjectIds: [],
      });
    }
    return { primaryBranch, primaryHead, contexts };
  }
}
