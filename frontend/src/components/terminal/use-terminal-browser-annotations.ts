import { useMemoizedFn } from "ahooks";
import { useEffect, useRef, useState } from "react";
import type { TerminalBrowserAnnotationState } from "@runweave/shared/terminal-browser-annotation";
import {
  createTerminalSessionClipboardImage,
  getTerminalState,
  sendTerminalInput,
} from "../../services/terminal";
import { buildBrowserAnnotationPrompt } from "./terminal-browser-annotation-prompt";

const EMPTY_ANNOTATION_STATE: TerminalBrowserAnnotationState = {
  active: false,
  annotations: [],
};

interface UseTerminalBrowserAnnotationsOptions {
  activeTabId: string | null;
  apiBase: string;
  isElectron: boolean;
  terminalSessionId: string | null;
  token: string;
}

export function useTerminalBrowserAnnotations({
  activeTabId,
  apiBase,
  isElectron,
  terminalSessionId,
  token,
}: UseTerminalBrowserAnnotationsOptions) {
  const annotationTabIdRef = useRef<string | null>(null);
  const handledSubmitRequestRef = useRef<string | null>(null);
  const submittingRef = useRef(false);
  const [annotationTabId, setAnnotationTabIdState] = useState<string | null>(
    null,
  );
  const [state, setState] = useState<TerminalBrowserAnnotationState>(
    EMPTY_ANNOTATION_STATE,
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setAnnotationTabId = useMemoizedFn((tabId: string | null): void => {
    annotationTabIdRef.current = tabId;
    setAnnotationTabIdState(tabId);
  });

  const submitTab = useMemoizedFn(async (tabId: string): Promise<void> => {
    setSubmitting(true);
    submittingRef.current = true;
    setError(null);
    try {
      if (!terminalSessionId) {
        setError(
          "Browser comments are ready, but no active terminal is available.",
        );
        return;
      }
      const { terminalState } = await getTerminalState(
        apiBase,
        token,
        terminalSessionId,
      );
      if (!terminalState.agent || terminalState.state === "shell_idle") {
        setError(
          "Browser comments require an active Agent terminal. Start Codex or another supported Agent before submitting.",
        );
        return;
      }
      const submission =
        await window.electronAPI?.terminalBrowserAnnotationSubmit?.(tabId);
      if (!submission || submission.annotations.length === 0) {
        setError("No browser comments to submit.");
        return;
      }

      let screenshotPath: string | null = null;
      let submitWarning: string | null = null;
      if (submission.screenshot) {
        try {
          const savedScreenshot = await createTerminalSessionClipboardImage(
            apiBase,
            token,
            terminalSessionId,
            submission.screenshot,
          );
          screenshotPath = savedScreenshot.filePath;
        } catch (caught) {
          submitWarning =
            caught instanceof Error
              ? `Browser comments were submitted, but saving the marker screenshot failed: ${caught.message}`
              : "Browser comments were submitted, but saving the marker screenshot failed.";
        }
      }

      const prompt = buildBrowserAnnotationPrompt(submission, {
        screenshotPath,
      });
      setState(EMPTY_ANNOTATION_STATE);
      setAnnotationTabId(null);
      await sendTerminalInput(apiBase, token, terminalSessionId, {
        data: prompt,
        mode: "prompt_paste",
        quickInputSource: "web_browser_annotation",
      });
      if (submitWarning) {
        setError(submitWarning);
      }
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Failed to submit browser comments",
      );
    } finally {
      handledSubmitRequestRef.current = null;
      submittingRef.current = false;
      setSubmitting(false);
    }
  });

  const stop = useMemoizedFn(async (): Promise<void> => {
    const tabId = annotationTabId ?? activeTabId;
    if (!tabId) {
      return;
    }
    setError(null);
    try {
      const next =
        await window.electronAPI?.terminalBrowserAnnotationStop?.(tabId);
      setState(next ?? EMPTY_ANNOTATION_STATE);
      setAnnotationTabId(null);
      handledSubmitRequestRef.current = null;
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Failed to stop browser comments",
      );
    }
  });

  const toggle = useMemoizedFn(async (): Promise<void> => {
    if (!isElectron || !activeTabId) {
      return;
    }
    if (state.active) {
      await stop();
      return;
    }
    setError(null);
    handledSubmitRequestRef.current = null;
    try {
      const next =
        await window.electronAPI?.terminalBrowserAnnotationStart?.(activeTabId);
      setAnnotationTabId(activeTabId);
      setState(next ?? { active: true, annotations: [] });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Failed to start browser comments",
      );
    }
  });

  const submit = useMemoizedFn(async (): Promise<void> => {
    const tabId = annotationTabId ?? activeTabId;
    if (tabId) {
      await submitTab(tabId);
    }
  });

  const handleTabClosed = useMemoizedFn((tabId: string): void => {
    if (annotationTabIdRef.current !== tabId) {
      return;
    }
    setAnnotationTabId(null);
    setState(EMPTY_ANNOTATION_STATE);
  });

  useEffect(() => {
    if (!isElectron) {
      return;
    }
    return window.electronAPI?.onTerminalBrowserAnnotationUpdated?.(
      ({ tabId, state: next }) => {
        if (annotationTabIdRef.current === tabId || next.active) {
          setAnnotationTabId(next.active ? tabId : null);
          setState(next);
        }
      },
    );
  }, [isElectron, setAnnotationTabId]);

  useEffect(() => {
    if (
      !isElectron ||
      !state.active ||
      !annotationTabId ||
      !activeTabId ||
      annotationTabId === activeTabId
    ) {
      return;
    }
    let cancelled = false;
    void window.electronAPI
      ?.terminalBrowserAnnotationStop?.(annotationTabId)
      .then((next) => {
        if (!cancelled) {
          setState(next ?? EMPTY_ANNOTATION_STATE);
          setAnnotationTabId(null);
          handledSubmitRequestRef.current = null;
        }
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(
            caught instanceof Error
              ? caught.message
              : "Failed to stop browser comments",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    activeTabId,
    annotationTabId,
    isElectron,
    setAnnotationTabId,
    state.active,
  ]);

  useEffect(() => {
    if (!isElectron || !state.active || !annotationTabId) {
      return;
    }
    let cancelled = false;
    const intervalId = window.setInterval(() => {
      void window.electronAPI
        ?.terminalBrowserAnnotationList?.(annotationTabId)
        .then((next) => {
          if (cancelled) {
            return;
          }
          setState(next);
          if (!next.active) {
            setAnnotationTabId(null);
            return;
          }
          const requestId = next.pendingSubmitRequestId;
          if (
            requestId &&
            handledSubmitRequestRef.current !== requestId &&
            !submittingRef.current
          ) {
            handledSubmitRequestRef.current = requestId;
            void submitTab(annotationTabId);
          }
        })
        .catch((caught) => {
          if (!cancelled) {
            setError(
              caught instanceof Error
                ? caught.message
                : "Failed to refresh browser comments",
            );
          }
        });
    }, 500);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [
    annotationTabId,
    isElectron,
    setAnnotationTabId,
    state.active,
    submitTab,
  ]);

  return {
    error,
    handleTabClosed,
    state,
    submit,
    submitting,
    toggle,
  };
}
