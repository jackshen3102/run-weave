import { resolveRepositoryIdentity } from "../../repository/identity";
import type { ActivityRepositoryBinding } from "../database/repository-index";

const inFlight = new Map<
  string,
  ReturnType<typeof resolveRepositoryIdentity>
>();
function resolveCurrent(cwd: string) {
  let operation = inFlight.get(cwd);
  if (!operation) {
    operation = resolveRepositoryIdentity(cwd);
    inFlight.set(cwd, operation);
    void operation.then(
      () => inFlight.delete(cwd),
      () => inFlight.delete(cwd),
    );
  }
  return operation;
}

export async function resolveActivityRepositories(
  events: Array<{ eventId: string; cwd: string | null | undefined }>,
): Promise<ActivityRepositoryBinding[]> {
  const byCwd = new Map<
    string,
    Promise<Omit<ActivityRepositoryBinding, "eventId">>
  >();
  // Sequential unique directories bound Git process fan-out; repeated cwd uses one result.
  for (const event of events) {
    if (!event.cwd || byCwd.has(event.cwd)) continue;
    const result = resolveCurrent(event.cwd)
      .then((identity) => ({
        repositoryId: identity.repositoryId,
        commonDirectory: identity.commonDirectory,
        reason: "event_cwd",
      }))
      .catch(() => ({
        repositoryId: null,
        commonDirectory: null,
        reason: "repository_unavailable",
      }));
    byCwd.set(event.cwd, result);
    await result;
  }
  return Promise.all(
    events.map(async (event) => ({
      eventId: event.eventId,
      ...(event.cwd
        ? await byCwd.get(event.cwd)!
        : {
            repositoryId: null,
            commonDirectory: null,
            reason: "event_cwd_missing",
          }),
    })),
  );
}
