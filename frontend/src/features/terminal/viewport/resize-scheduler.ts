export interface ResizeScheduler {
  schedule(): void;
  flush(): void;
  dispose(): void;
}

export function createResizeScheduler(
  callback: () => void,
  delayMs: number,
): ResizeScheduler {
  let timer: number | null = null;

  const clearTimer = () => {
    if (timer === null) {
      return;
    }

    window.clearTimeout(timer);
    timer = null;
  };

  return {
    schedule() {
      clearTimer();
      timer = window.setTimeout(() => {
        timer = null;
        callback();
      }, delayMs);
    },
    flush() {
      clearTimer();
      callback();
    },
    dispose() {
      clearTimer();
    },
  };
}
