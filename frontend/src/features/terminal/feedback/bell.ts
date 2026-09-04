interface BellOscillatorLike {
  type: string;
  frequency: {
    value: number;
  };
  connect(node: unknown): void;
  start(): void;
  stop(time?: number): void;
}

interface BellGainLike {
  gain: {
    value: number;
  };
  connect(node: unknown): void;
}

interface BellAudioContextLike {
  currentTime: number;
  state?: string;
  destination: unknown;
  resume?(): Promise<void>;
  createOscillator(): BellOscillatorLike;
  createGain(): BellGainLike;
}

function createDefaultAudioContext(): BellAudioContextLike | null {
  if (typeof window === "undefined") {
    return null;
  }

  const AudioContextCtor =
    window.AudioContext ??
    (
      window as typeof window & {
        webkitAudioContext?: typeof AudioContext;
      }
    ).webkitAudioContext;

  if (!AudioContextCtor) {
    return null;
  }

  return new AudioContextCtor() as unknown as BellAudioContextLike;
}

export function createTerminalBellPlayer(options?: {
  createContext?: () => BellAudioContextLike | null;
  durationMs?: number;
  frequency?: number;
  nativeBeep?: () => void;
  volume?: number;
}) {
  const {
    createContext = createDefaultAudioContext,
    durationMs = 120,
    frequency = 1046,
    nativeBeep =
      typeof window === "undefined" ? undefined : window.electronAPI?.beep,
    volume = 0.12,
  } = options ?? {};

  let audioContext: BellAudioContextLike | null = null;
  let pendingReady: Promise<BellAudioContextLike | null> | null = null;

  const ensureReady = async (): Promise<BellAudioContextLike | null> => {
    audioContext ??= createContext();
    if (!audioContext) {
      return null;
    }

    if (audioContext.state === "suspended" && audioContext.resume) {
      if (!pendingReady) {
        pendingReady = audioContext
          .resume()
          .then(() => audioContext)
          .finally(() => {
            pendingReady = null;
          });
      }
      await pendingReady;
    }

    return audioContext;
  };

  return {
    async prepare() {
      if (nativeBeep) {
        return;
      }
      await ensureReady();
    },
    play() {
      if (nativeBeep) {
        try {
          nativeBeep();
          return Promise.resolve();
        } catch {
          // Ignore native beep failures and continue with Web Audio.
        }
      }

      return ensureReady()
        .then((readyContext) => {
          if (!readyContext) {
            return;
          }

          const oscillator = readyContext.createOscillator();
          const gain = readyContext.createGain();
          oscillator.type = "sine";
          oscillator.frequency.value = frequency;
          gain.gain.value = volume;
          oscillator.connect(gain);
          gain.connect(readyContext.destination);
          oscillator.start();
          oscillator.stop(readyContext.currentTime + durationMs / 1000);
        })
        .catch(() => undefined);
    },
  };
}
