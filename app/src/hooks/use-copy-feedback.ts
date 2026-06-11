import { useCallback, useEffect, useRef, useState } from "react";

const COPIED_FEEDBACK_MS = 1500;

export function useCopyFeedback() {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<number | null>(null);

  const clearCopiedTimeout = useCallback(() => {
    if (timeoutRef.current === null) {
      return;
    }
    window.clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
  }, []);

  const copyText = useCallback(
    async (value: string): Promise<boolean> => {
      if (!value || !navigator.clipboard?.writeText) {
        return false;
      }
      await navigator.clipboard.writeText(value);
      setCopied(true);
      clearCopiedTimeout();
      timeoutRef.current = window.setTimeout(() => {
        setCopied(false);
        timeoutRef.current = null;
      }, COPIED_FEEDBACK_MS);
      return true;
    },
    [clearCopiedTimeout],
  );

  useEffect(() => clearCopiedTimeout, [clearCopiedTimeout]);

  return { copied, copyText };
}
