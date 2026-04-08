import { describe, expect, it, vi } from "vitest";
import { createTerminalBellPlayer } from "./bell";

describe("createTerminalBellPlayer", () => {
  it("is a no-op when audio context is unavailable", () => {
    const player = createTerminalBellPlayer({
      createContext: () => null,
    });

    expect(() => {
      player.play();
    }).not.toThrow();
  });

  it("creates a short beep and resumes suspended audio contexts", async () => {
    let resumed = false;
    const oscillator = {
      type: "square",
      frequency: { value: 0 },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
    const gain = {
      gain: { value: 0 },
      connect: vi.fn(),
    };
    const resume = vi.fn(async () => {
      resumed = true;
    });
    const createOscillator = vi.fn(() => oscillator);
    const createGain = vi.fn(() => gain);
    const createContext = vi.fn(() => ({
      currentTime: 10,
      state: "suspended",
      destination: { id: "dest" },
      resume,
      createOscillator,
      createGain,
    }));

    const player = createTerminalBellPlayer({
      createContext,
      durationMs: 100,
      frequency: 660,
      volume: 0.05,
    });

    await player.play();

    expect(createContext).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resumed).toBe(true);
    expect(createOscillator).toHaveBeenCalledTimes(1);
    expect(createGain).toHaveBeenCalledTimes(1);
    expect(oscillator.type).toBe("sine");
    expect(oscillator.frequency.value).toBe(660);
    expect(gain.gain.value).toBe(0.05);
    expect(oscillator.connect).toHaveBeenCalledWith(gain);
    expect(gain.connect).toHaveBeenCalledWith({ id: "dest" });
    expect(oscillator.start).toHaveBeenCalledTimes(1);
    expect(oscillator.stop).toHaveBeenCalledWith(10.1);
  });

  it("reuses the same audio context across plays", async () => {
    const oscillatorFactory = vi.fn(() => ({
      type: "square",
      frequency: { value: 0 },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    }));
    const createContext = vi.fn(() => ({
      currentTime: 0,
      state: "running",
      destination: {},
      createOscillator: oscillatorFactory,
      createGain: vi.fn(() => ({
        gain: { value: 0 },
        connect: vi.fn(),
      })),
    }));

    const player = createTerminalBellPlayer({ createContext });
    await player.play();
    await player.play();

    expect(createContext).toHaveBeenCalledTimes(1);
    expect(oscillatorFactory).toHaveBeenCalledTimes(2);
  });

  it("can prewarm the audio context from a user gesture without playing a sound", async () => {
    const createOscillator = vi.fn();
    const createGain = vi.fn();
    const resume = vi.fn(async () => undefined);
    const createContext = vi.fn(() => ({
      currentTime: 0,
      state: "suspended",
      destination: {},
      resume,
      createOscillator,
      createGain,
    }));

    const player = createTerminalBellPlayer({ createContext });
    await player.prepare();

    expect(createContext).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(createOscillator).not.toHaveBeenCalled();
    expect(createGain).not.toHaveBeenCalled();
  });

  it("prefers the native electron beep when it is available", async () => {
    const nativeBeep = vi.fn();
    const createOscillator = vi.fn(() => ({
      type: "square",
      frequency: { value: 0 },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    }));
    const createContext = vi.fn(() => ({
      currentTime: 0,
      state: "running",
      destination: {},
      createOscillator,
      createGain: vi.fn(() => ({
        gain: { value: 0 },
        connect: vi.fn(),
      })),
    }));

    const player = createTerminalBellPlayer({
      createContext,
      nativeBeep,
    });

    await player.prepare();
    await player.play();

    expect(nativeBeep).toHaveBeenCalledTimes(1);
    expect(createContext).not.toHaveBeenCalled();
    expect(createOscillator).not.toHaveBeenCalled();
  });

  it("falls back to the native electron beep when web audio is unavailable", async () => {
    const nativeBeep = vi.fn();
    const player = createTerminalBellPlayer({
      createContext: () => null,
      nativeBeep,
    });

    await player.prepare();
    await player.play();

    expect(nativeBeep).toHaveBeenCalledTimes(1);
  });

  it("falls back to web audio when the native electron beep throws", async () => {
    const nativeBeep = vi.fn(() => {
      throw new Error("native beep failed");
    });
    const createOscillator = vi.fn(() => ({
      type: "square",
      frequency: { value: 0 },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    }));
    const createContext = vi.fn(() => ({
      currentTime: 0,
      state: "running",
      destination: {},
      createOscillator,
      createGain: vi.fn(() => ({
        gain: { value: 0 },
        connect: vi.fn(),
      })),
    }));

    const player = createTerminalBellPlayer({
      createContext,
      nativeBeep,
    });

    await player.play();

    expect(nativeBeep).toHaveBeenCalledTimes(1);
    expect(createContext).toHaveBeenCalledTimes(1);
    expect(createOscillator).toHaveBeenCalledTimes(1);
  });
});
