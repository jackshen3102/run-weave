import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  expect,
  test,
  type APIRequestContext,
  type ConsoleMessage,
  type Page,
} from "@playwright/test";

const E2E_BACKEND_PORT = 5501;
const E2E_API_BASE = `http://127.0.0.1:${E2E_BACKEND_PORT}`;
const DEFAULT_SESSION_COUNT = 8;
const DEFAULT_SEED_LINES = 12_000;
const DEFAULT_PROBE_COUNT = 30;
const DEFAULT_BACKGROUND_BURST_LINES = 120;
const DEFAULT_BACKGROUND_SLEEP_SECONDS = "0.05";
const DEFAULT_OUTPUT_TIMEOUT_MS = 60_000;
const DEFAULT_SCENARIO = "busy";
const DEFAULT_SEED_PAYLOAD_REPEAT = 1;
const DEFAULT_TEST_TIMEOUT_MS = 180_000;

interface ConsolePerfEvent {
  prefix: string;
  event: string | null;
  details: Record<string, unknown>;
  text: string;
}

interface MetricSummary {
  p50: number;
  p95: number;
  max: number;
}

interface LongTaskSummary {
  count: number;
  totalMs: number;
  maxMs: number;
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readPerfScenario(): string {
  return process.env.TERMINAL_PERF_SCENARIO ?? DEFAULT_SCENARIO;
}

function shouldRunScenario(scenario: string): boolean {
  const configuredScenario = readPerfScenario();
  return configuredScenario === scenario || configuredScenario === "all";
}

function summarize(values: number[]): MetricSummary {
  if (values.length === 0) {
    return { p50: 0, p95: 0, max: 0 };
  }

  const sorted = [...values].sort((left, right) => left - right);
  const pick = (percentile: number) =>
    sorted[
      Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * percentile))
    ];

  return {
    p50: Number(pick(0.5).toFixed(2)),
    p95: Number(pick(0.95).toFixed(2)),
    max: Number(sorted[sorted.length - 1].toFixed(2)),
  };
}

function summarizeLongTasks(
  tasks: Array<{ duration: number }>,
): LongTaskSummary {
  const durations = tasks.map((task) => task.duration);
  const totalMs = durations.reduce((total, duration) => total + duration, 0);
  return {
    count: durations.length,
    totalMs: Number(totalMs.toFixed(2)),
    maxMs: Number((durations.length ? Math.max(...durations) : 0).toFixed(2)),
  };
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function readProbeEvent(
  page: Page,
  eventName: string,
  marker: string,
): Promise<Record<string, unknown> | null> {
  return await page.evaluate(
    ({ eventName: nextEventName, marker: nextMarker }) => {
      const target = window as unknown as {
        __terminalPerfProbeEvents?: Array<{
          event: string;
          at: number;
          details: Record<string, unknown>;
        }>;
      };
      const matchingEvent = target.__terminalPerfProbeEvents?.find((event) => {
        if (event.event !== nextEventName) {
          return false;
        }

        return event.details.probeText === nextMarker;
      });

      return matchingEvent?.details ?? null;
    },
    { eventName, marker },
  );
}

function buildRepeatedSeedPayload(repeat: number): string {
  return "abcdefghijklmnopqrstuvwxyz".repeat(repeat);
}

function buildSeedCommand(
  seedLines: number,
  payloadRepeat = DEFAULT_SEED_PAYLOAD_REPEAT,
): string {
  const seedPayload = buildRepeatedSeedPayload(payloadRepeat);
  return [
    "python3 - <<'PY'",
    `payload = ${JSON.stringify(seedPayload)}`,
    `for i in range(${seedLines}):`,
    "    print(f'seed-line-{i:05d} {payload}')",
    "PY",
  ].join("\n");
}

function buildSeedCompleteMarker(seedLines: number): string {
  return `seed-line-${String(seedLines - 1).padStart(5, "0")}`;
}

function buildBackgroundCommand(
  seedLines: number,
  burstLines: number,
  sleepSeconds: string,
  payloadRepeat = DEFAULT_SEED_PAYLOAD_REPEAT,
): string {
  return [
    buildSeedCommand(seedLines, payloadRepeat),
    "while true; do",
    "python3 - <<'PY'",
    `for i in range(${burstLines}):`,
    "    print(f'bg-line-{i:03d} abcdefghijklmnopqrstuvwxyz')",
    "PY",
    `sleep ${sleepSeconds}`,
    "done",
  ].join("\n");
}

function buildSilentRunningScrollbackCommand(
  seedLines: number,
  payloadRepeat = DEFAULT_SEED_PAYLOAD_REPEAT,
): string {
  return [
    buildSeedCommand(seedLines, payloadRepeat),
    "while true; do sleep 3600; done",
  ].join("\n");
}

function buildInteractiveScrollbackCommand(
  seedLines: number,
  payloadRepeat = DEFAULT_SEED_PAYLOAD_REPEAT,
): string {
  return [buildSeedCommand(seedLines, payloadRepeat), "exec /bin/bash -i"].join(
    "\n",
  );
}

async function loginAndSeedToken(
  request: APIRequestContext,
  page: Page,
): Promise<string> {
  const response = await request.post(`${E2E_API_BASE}/api/auth/login`, {
    data: {
      username: "e2e-admin",
      password: "e2e-secret",
    },
  });

  expect(response.ok()).toBe(true);
  const payload = (await response.json()) as {
    accessToken: string;
    expiresIn: number;
    sessionId: string;
  };

  await page.addInitScript(({ accessToken, expiresIn, sessionId }) => {
    const session = {
      accessToken,
      accessExpiresAt: Date.now() + expiresIn * 1000,
      sessionId,
    };
    window.localStorage.setItem("viewer.auth.token", JSON.stringify(session));
  }, payload);

  return payload.accessToken;
}

async function getTerminalHistory(
  request: APIRequestContext,
  token: string,
  terminalSessionId: string,
): Promise<{ scrollback: string }> {
  const response = await request.get(
    `${E2E_API_BASE}/api/terminal/session/${encodeURIComponent(terminalSessionId)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );

  expect(response.ok()).toBe(true);
  return (await response.json()) as { scrollback: string };
}

async function createTerminalSession(
  request: APIRequestContext,
  token: string,
  payload: {
    command: string;
    args?: string[];
    cwd: string;
  },
): Promise<{ terminalSessionId: string; terminalUrl: string }> {
  const response = await request.post(`${E2E_API_BASE}/api/terminal/session`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
    data: payload,
  });

  expect(response.ok()).toBe(true);
  return (await response.json()) as {
    terminalSessionId: string;
    terminalUrl: string;
  };
}

async function waitForTerminalHistory(
  request: APIRequestContext,
  token: string,
  terminalSessionId: string,
  expectedText: string,
  timeout = DEFAULT_OUTPUT_TIMEOUT_MS,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const history = await getTerminalHistory(
          request,
          token,
          terminalSessionId,
        );
        return history.scrollback;
      },
      { timeout },
    )
    .toContain(expectedText);
}

async function writePerfArtifact(
  payload: Record<string, unknown>,
): Promise<string> {
  const artifactRoot =
    process.env.TERMINAL_PERF_ARTIFACT_DIR ??
    path.join(
      process.cwd(),
      "..",
      "artifacts",
      "terminal-perf",
      new Date().toISOString().replaceAll(":", "-"),
    );
  await mkdir(artifactRoot, { recursive: true });
  const artifactPath = path.join(
    artifactRoot,
    `${String(payload.candidate ?? "candidate")}.json`,
  );
  await writeFile(
    artifactPath,
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
  return artifactPath;
}

function collectTerminalPerfConsoleEvents(page: Page): ConsolePerfEvent[] {
  const consoleEvents: ConsolePerfEvent[] = [];
  page.on("console", (message: ConsoleMessage) => {
    void (async () => {
      const text = message.text();
      if (
        text.includes("[terminal-perf-fe]") &&
        text.includes("BV_") &&
        (text.includes("terminal.output.received") ||
          text.includes("terminal.output.rendered") ||
          text.includes("terminal.output.painted"))
      ) {
        const args = message.args();
        let eventName: string | null = null;
        let details: Record<string, unknown> = {};
        try {
          const rawEventName = await args[1]?.jsonValue();
          const rawDetails = await args[2]?.jsonValue();
          eventName = typeof rawEventName === "string" ? rawEventName : null;
          details =
            rawDetails && typeof rawDetails === "object"
              ? (rawDetails as Record<string, unknown>)
              : {};
        } catch {
          eventName = null;
          details = {};
        }
        consoleEvents.push({
          prefix: "[terminal-perf-fe]",
          event: eventName,
          details,
          text,
        });
      }
    })();
  });
  return consoleEvents;
}

async function installTerminalPerfObservers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const target = window as unknown as {
      __terminalPerfLongTasks?: Array<{ duration: number; startTime: number }>;
      __terminalPerfProbeEvents?: Array<{
        event: string;
        at: number;
        details: Record<string, unknown>;
      }>;
    };
    target.__terminalPerfLongTasks = [];
    target.__terminalPerfProbeEvents = [];
    if ("PerformanceObserver" in window) {
      try {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            target.__terminalPerfLongTasks?.push({
              duration: entry.duration,
              startTime: entry.startTime,
            });
          }
        });
        observer.observe({ entryTypes: ["longtask"] });
      } catch {
        target.__terminalPerfLongTasks = [];
      }
    }
  });
}

interface ProbeMetrics {
  echoLatencyMs: number[];
  outputReceivedSinceLastInputMs: number[];
  outputRenderedSinceLastInputMs: number[];
  outputRenderDurationMs: number[];
  outputPaintedSinceLastInputMs: number[];
  outputPaintDelayMs: number[];
  outputReceivedSinceLastInputMissingCount: number;
  outputRenderedSinceLastInputMissingCount: number;
  outputPaintedSinceLastInputMissingCount: number;
}

async function measureTerminalProbeMetrics(
  page: Page,
  probeCount: number,
): Promise<ProbeMetrics> {
  const echoLatencyMs: number[] = [];
  const outputReceivedSinceLastInputMs: number[] = [];
  const outputRenderedSinceLastInputMs: number[] = [];
  const outputRenderDurationMs: number[] = [];
  const outputPaintedSinceLastInputMs: number[] = [];
  const outputPaintDelayMs: number[] = [];
  let outputReceivedSinceLastInputMissingCount = 0;
  let outputRenderedSinceLastInputMissingCount = 0;
  let outputPaintedSinceLastInputMissingCount = 0;

  for (let index = 0; index < probeCount; index += 1) {
    const marker = `BV_${Date.now()}_${index}`;
    await page.keyboard.type(marker);
    await page.keyboard.press("Enter");
    await expect
      .poll(() => readProbeEvent(page, "terminal.output.received", marker), {
        timeout: 500,
      })
      .not.toBeNull()
      .catch(() => undefined);
    const receivedEvent = await readProbeEvent(
      page,
      "terminal.output.received",
      marker,
    );
    const receivedLatency = receivedEvent
      ? toFiniteNumber(receivedEvent.sinceLastInputMs)
      : null;
    if (receivedLatency !== null) {
      outputReceivedSinceLastInputMs.push(receivedLatency);
    } else {
      outputReceivedSinceLastInputMissingCount += 1;
    }

    await expect
      .poll(() => readProbeEvent(page, "terminal.output.rendered", marker), {
        timeout: 500,
      })
      .not.toBeNull()
      .catch(() => undefined);
    const renderedEvent = await readProbeEvent(
      page,
      "terminal.output.rendered",
      marker,
    );
    const renderedLatency = renderedEvent
      ? toFiniteNumber(renderedEvent.sinceLastInputMs)
      : null;
    const renderDuration = renderedEvent
      ? toFiniteNumber(renderedEvent.renderDurationMs)
      : null;
    if (renderedLatency !== null) {
      outputRenderedSinceLastInputMs.push(renderedLatency);
    } else {
      outputRenderedSinceLastInputMissingCount += 1;
    }
    if (renderDuration !== null) {
      outputRenderDurationMs.push(renderDuration);
    }

    await expect
      .poll(() => readProbeEvent(page, "terminal.output.painted", marker), {
        timeout: DEFAULT_OUTPUT_TIMEOUT_MS,
      })
      .not.toBeNull();
    const paintedEvent = await readProbeEvent(
      page,
      "terminal.output.painted",
      marker,
    );
    const paintedLatency = paintedEvent
      ? toFiniteNumber(paintedEvent.sinceLastInputMs)
      : null;
    const paintDelay = paintedEvent
      ? toFiniteNumber(paintedEvent.paintDelayMs)
      : null;
    if (paintedLatency !== null) {
      outputPaintedSinceLastInputMs.push(paintedLatency);
      echoLatencyMs.push(paintedLatency);
    } else {
      outputPaintedSinceLastInputMissingCount += 1;
    }
    if (paintDelay !== null) {
      outputPaintDelayMs.push(paintDelay);
    }
  }

  return {
    echoLatencyMs,
    outputReceivedSinceLastInputMs,
    outputRenderedSinceLastInputMs,
    outputRenderDurationMs,
    outputPaintedSinceLastInputMs,
    outputPaintDelayMs,
    outputReceivedSinceLastInputMissingCount,
    outputRenderedSinceLastInputMissingCount,
    outputPaintedSinceLastInputMissingCount,
  };
}

async function readLongTasks(page: Page): Promise<Array<{ duration: number }>> {
  return await page.evaluate(() => {
    const target = window as unknown as {
      __terminalPerfLongTasks?: Array<{ duration: number; startTime: number }>;
    };
    return target.__terminalPerfLongTasks ?? [];
  });
}

function buildPerfResult(params: {
  candidate: string;
  scenario: string;
  sessions: number;
  seedLines: number;
  seedPayloadRepeat: number;
  seedActiveScrollback?: boolean;
  probeCount: number;
  openDurationMs: number;
  probeMetrics: ProbeMetrics;
  longTasks: Array<{ duration: number }>;
  consoleEvents: ConsolePerfEvent[];
}): Record<string, unknown> {
  const commit = process.env.TERMINAL_PERF_COMMIT ?? "unknown";
  const probeMetrics = params.probeMetrics;
  return {
    candidate: params.candidate,
    scenario: params.scenario,
    commit,
    sessions: params.sessions,
    seedLinesPerSession: params.seedLines,
    seedPayloadRepeat: params.seedPayloadRepeat,
    seedActiveScrollback: params.seedActiveScrollback ?? false,
    probes: params.probeCount,
    openDurationMs: Number(params.openDurationMs.toFixed(2)),
    echoLatencySamplesMs: probeMetrics.echoLatencyMs.map((value) =>
      Number(value.toFixed(2)),
    ),
    echoLatencyMs: summarize(probeMetrics.echoLatencyMs),
    outputReceivedSinceLastInputSamplesMs:
      probeMetrics.outputReceivedSinceLastInputMs.map((value) =>
        Number(value.toFixed(2)),
      ),
    outputReceivedSinceLastInputMs: summarize(
      probeMetrics.outputReceivedSinceLastInputMs,
    ),
    outputReceivedSinceLastInputMissingCount:
      probeMetrics.outputReceivedSinceLastInputMissingCount,
    outputRenderedSinceLastInputSamplesMs:
      probeMetrics.outputRenderedSinceLastInputMs.map((value) =>
        Number(value.toFixed(2)),
      ),
    outputRenderedSinceLastInputMs: summarize(
      probeMetrics.outputRenderedSinceLastInputMs,
    ),
    outputRenderedSinceLastInputMissingCount:
      probeMetrics.outputRenderedSinceLastInputMissingCount,
    outputRenderDurationSamplesMs: probeMetrics.outputRenderDurationMs.map(
      (value) => Number(value.toFixed(2)),
    ),
    outputRenderDurationMs: summarize(probeMetrics.outputRenderDurationMs),
    outputPaintedSinceLastInputSamplesMs:
      probeMetrics.outputPaintedSinceLastInputMs.map((value) =>
        Number(value.toFixed(2)),
      ),
    outputPaintedSinceLastInputMs: summarize(
      probeMetrics.outputPaintedSinceLastInputMs,
    ),
    outputPaintedSinceLastInputMissingCount:
      probeMetrics.outputPaintedSinceLastInputMissingCount,
    outputPaintDelaySamplesMs: probeMetrics.outputPaintDelayMs.map((value) =>
      Number(value.toFixed(2)),
    ),
    outputPaintDelayMs: summarize(probeMetrics.outputPaintDelayMs),
    longTasks: summarizeLongTasks(params.longTasks),
    frontendPerfLogCount: params.consoleEvents.filter(
      (event) => event.prefix === "[terminal-perf-fe]",
    ).length,
    errors: params.consoleEvents
      .filter((event) => /error|failed|invalid/i.test(event.text))
      .map((event) => event.text.slice(0, 500)),
  };
}

test.describe("terminal performance", () => {
  test.skip(
    process.env.TERMINAL_PERF !== "1",
    "Set TERMINAL_PERF=1 to run the terminal performance benchmark.",
  );
  test.setTimeout(
    readPositiveInt("TERMINAL_PERF_TIMEOUT_MS", DEFAULT_TEST_TIMEOUT_MS),
  );

  test("measures input echo latency under many busy terminals", async ({
    page,
    request,
  }) => {
    test.skip(
      !shouldRunScenario("busy"),
      "Set TERMINAL_PERF_SCENARIO=busy or all to run this scenario.",
    );
    const sessionCount = readPositiveInt(
      "TERMINAL_PERF_SESSION_COUNT",
      DEFAULT_SESSION_COUNT,
    );
    const seedLines = readPositiveInt(
      "TERMINAL_PERF_SEED_LINES",
      DEFAULT_SEED_LINES,
    );
    const seedPayloadRepeat = readPositiveInt(
      "TERMINAL_PERF_SEED_PAYLOAD_REPEAT",
      DEFAULT_SEED_PAYLOAD_REPEAT,
    );
    const probeCount = readPositiveInt(
      "TERMINAL_PERF_PROBE_COUNT",
      DEFAULT_PROBE_COUNT,
    );
    const backgroundBurstLines = readPositiveInt(
      "TERMINAL_PERF_BACKGROUND_BURST_LINES",
      DEFAULT_BACKGROUND_BURST_LINES,
    );
    const backgroundSleepSeconds =
      process.env.TERMINAL_PERF_BACKGROUND_SLEEP_SECONDS ??
      DEFAULT_BACKGROUND_SLEEP_SECONDS;
    const candidate = process.env.TERMINAL_PERF_CANDIDATE ?? "baseline";
    const consoleEvents = collectTerminalPerfConsoleEvents(page);

    await installTerminalPerfObservers(page);

    const token = await loginAndSeedToken(request, page);
    const sessions: Array<{ terminalSessionId: string; terminalUrl: string }> =
      [];
    const activeSession = await createTerminalSession(request, token, {
      command: "/bin/bash",
      args: ["-i"],
      cwd: "/tmp",
    });
    sessions.push(activeSession);

    for (let index = 1; index < sessionCount; index += 1) {
      sessions.push(
        await createTerminalSession(request, token, {
          command: "/bin/bash",
          args: [
            "-lc",
            buildBackgroundCommand(
              seedLines,
              backgroundBurstLines,
              backgroundSleepSeconds,
              seedPayloadRepeat,
            ),
          ],
          cwd: "/tmp",
        }),
      );
    }

    const openStartedAt = performance.now();
    await page.goto(activeSession.terminalUrl);
    const activeTerminal = page.getByLabel("Terminal emulator").first();
    await expect(activeTerminal).toBeVisible();
    await activeTerminal.click({ force: true });
    await page.keyboard.type(buildSeedCommand(seedLines, seedPayloadRepeat));
    await page.keyboard.press("Enter");
    await waitForTerminalHistory(
      request,
      token,
      activeSession.terminalSessionId,
      buildSeedCompleteMarker(seedLines),
    );
    await page.keyboard.type("cat");
    await page.keyboard.press("Enter");
    const openDurationMs = performance.now() - openStartedAt;

    const probeMetrics = await measureTerminalProbeMetrics(page, probeCount);
    const longTasks = await readLongTasks(page);
    const result = buildPerfResult({
      candidate,
      scenario: "busy",
      sessions: sessions.length,
      seedLines,
      seedPayloadRepeat,
      probeCount,
      openDurationMs,
      probeMetrics,
      longTasks,
      consoleEvents,
    });

    const artifactPath = await writePerfArtifact(result);
    console.info(
      "[terminal-perf-result]",
      artifactPath,
      JSON.stringify(result),
    );

    expect((result.echoLatencyMs as MetricSummary).p95).toBeGreaterThan(0);
  });

  test("measures input echo latency with silent heavy scrollback terminals", async ({
    page,
    request,
  }) => {
    test.skip(
      !shouldRunScenario("silent-heavy-scrollback"),
      "Set TERMINAL_PERF_SCENARIO=silent-heavy-scrollback or all to run this scenario.",
    );
    const sessionCount = readPositiveInt(
      "TERMINAL_PERF_SESSION_COUNT",
      DEFAULT_SESSION_COUNT,
    );
    const seedLines = readPositiveInt(
      "TERMINAL_PERF_SEED_LINES",
      DEFAULT_SEED_LINES,
    );
    const seedPayloadRepeat = readPositiveInt(
      "TERMINAL_PERF_SEED_PAYLOAD_REPEAT",
      DEFAULT_SEED_PAYLOAD_REPEAT,
    );
    const probeCount = readPositiveInt(
      "TERMINAL_PERF_PROBE_COUNT",
      DEFAULT_PROBE_COUNT,
    );
    const seedActiveScrollback =
      process.env.TERMINAL_PERF_ACTIVE_SEED_SCROLLBACK === "1";
    const candidate = process.env.TERMINAL_PERF_CANDIDATE ?? "baseline";
    const consoleEvents = collectTerminalPerfConsoleEvents(page);

    await installTerminalPerfObservers(page);

    const token = await loginAndSeedToken(request, page);
    const sessions: Array<{ terminalSessionId: string; terminalUrl: string }> =
      [];
    const activeSession = await createTerminalSession(request, token, {
      command: "/bin/bash",
      args: seedActiveScrollback
        ? [
            "-lc",
            buildInteractiveScrollbackCommand(seedLines, seedPayloadRepeat),
          ]
        : ["-i"],
      cwd: "/tmp",
    });
    sessions.push(activeSession);
    if (seedActiveScrollback) {
      await waitForTerminalHistory(
        request,
        token,
        activeSession.terminalSessionId,
        buildSeedCompleteMarker(seedLines),
      );
    }

    for (let index = 1; index < sessionCount; index += 1) {
      const backgroundSession = await createTerminalSession(request, token, {
        command: "/bin/bash",
        args: [
          "-lc",
          buildSilentRunningScrollbackCommand(seedLines, seedPayloadRepeat),
        ],
        cwd: "/tmp",
      });
      sessions.push(backgroundSession);
      await waitForTerminalHistory(
        request,
        token,
        backgroundSession.terminalSessionId,
        buildSeedCompleteMarker(seedLines),
      );
    }

    const openStartedAt = performance.now();
    await page.goto(activeSession.terminalUrl);
    const activeTerminal = page.getByLabel("Terminal emulator").first();
    await expect(activeTerminal).toBeVisible();
    await activeTerminal.click({ force: true });
    await page.keyboard.type("cat");
    await page.keyboard.press("Enter");
    const openDurationMs = performance.now() - openStartedAt;

    const probeMetrics = await measureTerminalProbeMetrics(page, probeCount);
    const longTasks = await readLongTasks(page);
    const result = buildPerfResult({
      candidate,
      scenario: "silent-heavy-scrollback",
      sessions: sessions.length,
      seedLines,
      seedPayloadRepeat,
      seedActiveScrollback,
      probeCount,
      openDurationMs,
      probeMetrics,
      longTasks,
      consoleEvents,
    });

    const artifactPath = await writePerfArtifact(result);
    console.info(
      "[terminal-perf-result]",
      artifactPath,
      JSON.stringify(result),
    );

    expect((result.echoLatencyMs as MetricSummary).p95).toBeGreaterThan(0);
  });
});
