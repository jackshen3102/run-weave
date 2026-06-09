import type {
  RuntimeTerminalSessionRecord,
  TerminalProjectRecord,
  TerminalSessionRecord,
} from "./manager-records";

export function sortTerminalProjects(
  projects: Iterable<TerminalProjectRecord>,
): TerminalProjectRecord[] {
  return Array.from(projects).sort((left, right) => compareOrderedRecords(left, right));
}

export function sortTerminalSessions(
  sessions: Iterable<TerminalSessionRecord>,
): TerminalSessionRecord[] {
  return Array.from(sessions).sort((left, right) => compareOrderedRecords(left, right));
}

export function applyProjectOrder(
  projects: Iterable<TerminalProjectRecord>,
  orderedIds: string[],
): void {
  const orderMap = createOrderMap(orderedIds);
  for (const project of projects) {
    const order = orderMap.get(project.id);
    if (order !== undefined) {
      project.order = order;
    }
  }
}

export function applySessionOrder(
  sessions: Iterable<RuntimeTerminalSessionRecord>,
  projectId: string,
  orderedIds: string[],
): void {
  const orderMap = createOrderMap(orderedIds);
  for (const session of sessions) {
    if (session.projectId !== projectId) {
      continue;
    }
    const order = orderMap.get(session.id);
    if (order !== undefined) {
      session.order = order;
    }
  }
}

function createOrderMap(orderedIds: string[]): Map<string, number> {
  const orderMap = new Map<string, number>();
  for (let index = 0; index < orderedIds.length; index += 1) {
    const id = orderedIds[index];
    if (id !== undefined) {
      orderMap.set(id, index);
    }
  }
  return orderMap;
}

function compareOrderedRecords(
  left: { order?: number; createdAt: Date },
  right: { order?: number; createdAt: Date },
): number {
  const leftOrder = left.order;
  const rightOrder = right.order;
  if (leftOrder !== undefined && rightOrder !== undefined) {
    return leftOrder - rightOrder;
  }
  if (leftOrder !== undefined) return -1;
  if (rightOrder !== undefined) return 1;
  return left.createdAt.getTime() - right.createdAt.getTime();
}
