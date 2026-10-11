import { strict as assert } from "node:assert";
import path from "node:path";
import { TerminalSessionManager } from "../../../backend/src/terminal/manager/manager";
import { LowDbTerminalSessionStore } from "../../../backend/src/terminal/store/lowdb-store";
import { TerminalBadges } from "../../../backend/src/device-monitor/terminal-badges";
import { pause, type fixture } from "./fixture";

/** Actual persisted completion/ack state -> Backend publisher -> HTTPS gateway. No agent process is started. */
export async function verifyUnreadSessions(f: Awaited<ReturnType<typeof fixture>>, read: () => Promise<Response>) {
  const file = path.join(f.directory, "unread-sessions.json");
  let sessions = new TerminalSessionManager(new LowDbTerminalSessionStore(file));
  const badges = new TerminalBadges(sessions, f.events, f.subscriptions);
  const expectCount = async (count: number) => {
    const until = Date.now() + 10_000;
    while (true) {
      const response = await read();
      if (response.ok && (await response.json()).count === count) return;
      assert.ok(Date.now() < until, "published count must converge within 10 seconds");
      await pause(30);
    }
  };
  try {
    await sessions.initialize();
    const a = await sessions.createSession({ command: "sh", cwd: f.directory });
    const b = await sessions.createSession({ command: "sh", cwd: f.directory });
    await sessions.recordSessionCompletion(a.id);
    await sessions.recordSessionCompletion(b.id);
    // Earlier protocol checks used revisions through 4; continue the fixture's persisted version monotonically.
    await f.monitorStore.update((data) => { data.unread = { count: 0, revision: 10 }; });
    badges.start();
    await expectCount(2);
    const seen = a.completionRevision;
    await sessions.recordSessionCompletion(a.id);
    await sessions.acknowledgeSessionCompletion(a.id, seen);
    assert.equal((await badges.snapshot()).count, 2, "old acknowledgement cannot consume a newer completion");
    await sessions.acknowledgeSessionCompletion(a.id, a.completionRevision);
    await expectCount(1);
    await sessions.acknowledgeSessionCompletion(a.id, seen);
    assert.equal((await badges.snapshot()).count, 1, "old acknowledgement cannot move read state backwards");
    await sessions.acknowledgeSessionCompletion(b.id, b.completionRevision);
    await expectCount(0);
    await badges.dispose();
    await sessions.dispose();
    sessions = new TerminalSessionManager(new LowDbTerminalSessionStore(file));
    await sessions.initialize();
    assert.equal(sessions.listSessions().filter((s) => s.completionRevision > s.acknowledgedCompletionRevision).length, 0);
    console.log("PASS persisted terminal state: new completion survives old acknowledgement, actual publisher converges 2 -> 1 -> 0, read state survives restart");
  } finally {
    await badges.dispose();
    await sessions.dispose();
  }
}
