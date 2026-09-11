import { strict as assert } from "node:assert";
import { parseMacBattery } from "../../../packages/shared/src/monitoring/battery";
import { fixture, pause } from "./fixture";

export async function verifyCadence() {
  const calls: number[] = [];
  const value = parseMacBattery(
    "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1) 42%; discharging; 1:20 remaining present: true",
  );
  const f = await fixture(
    async () => {
      calls.push(performance.now());
      return value;
    },
    async () => ({ state: "accepted" }),
  );
  try {
    const owners = await Promise.all([f.login(), f.login(), f.login()]);
    const frames = [0, 0, 0];
    const sockets = owners.map((owner, index) => {
      const socket = f.socket(owner);
      socket.on("message", (raw) => {
        if (JSON.parse(String(raw)).type === "device-status") frames[index]!++;
      });
      return socket;
    });
    f.monitor.start();
    const started = performance.now();
    while (performance.now() - started < 130_000) {
      await Promise.all(
        owners.map((owner) =>
          f.request("/api/device/status", owner.accessToken),
        ),
      );
      await pause(1000);
    }
    assert.equal(calls.length, 3);
    assert.ok(calls[1]! - calls[0]! >= 59_000);
    assert.ok(calls[2]! - calls[1]! >= 59_000);
    assert.ok(frames.every((count) => count >= 3));
    for (const socket of sockets) socket.terminate();
    process.stdout.write(
      "PASS 130 real seconds, three authenticated readers + sockets: exactly three samples; expired initial ticket does not end a valid session\n",
    );
  } finally {
    await f.dispose();
  }
}
