import { useMemoizedFn } from "ahooks";
import { Check, Copy, MessageSquarePlus, TextCursorInput } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type MouseEventHandler,
  type ReactNode,
  type RefObject,
  type UIEventHandler,
} from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../ui/context-menu";
import {
  formatMarkdownLineReference,
  type MarkdownSourceSelection,
  resolveMarkdownSourceSelection,
} from "./terminal-markdown-reference";

interface TerminalMarkdownReferenceControlsProps {
  children: ReactNode;
  containerRef: RefObject<HTMLDivElement | null>;
  lineReferencePath?: string;
  canInsertLineReference: boolean;
  lineReferenceDisabledReason?: string;
  hasUnsavedChanges: boolean;
  resetKey: string;
  onClick: MouseEventHandler<HTMLDivElement>;
  onScroll: UIEventHandler<HTMLDivElement>;
  onInsertLineReference?: (reference: string) => void;
  onRevealSourceLine?: (line: number) => void;
}

export function TerminalMarkdownReferenceControls({
  children,
  containerRef,
  lineReferencePath,
  canInsertLineReference,
  lineReferenceDisabledReason,
  hasUnsavedChanges,
  resetKey,
  onClick,
  onScroll,
  onInsertLineReference,
  onRevealSourceLine,
}: TerminalMarkdownReferenceControlsProps) {
  const feedbackTimeoutRef = useRef<number | null>(null);
  const [sourceSelection, setSourceSelection] =
    useState<MarkdownSourceSelection | null>(null);
  const [referenceFeedback, setReferenceFeedback] = useState<
    "copied" | "inserted" | null
  >(null);
  const lineReference =
    sourceSelection && lineReferencePath
      ? formatMarkdownLineReference(lineReferencePath, sourceSelection)
      : null;
  const lineReferenceUnavailable = hasUnsavedChanges || !lineReference;
  const insertLineReferenceUnavailable =
    lineReferenceUnavailable || !canInsertLineReference;
  const lineReferenceTitle = hasUnsavedChanges
    ? "Save the file before referencing source lines"
    : undefined;

  const clearFeedbackTimer = useMemoizedFn(() => {
    if (feedbackTimeoutRef.current !== null) {
      window.clearTimeout(feedbackTimeoutRef.current);
      feedbackTimeoutRef.current = null;
    }
  });
  const showFeedback = useMemoizedFn((feedback: "copied" | "inserted") => {
    clearFeedbackTimer();
    setReferenceFeedback(feedback);
    feedbackTimeoutRef.current = window.setTimeout(() => {
      setReferenceFeedback(null);
      feedbackTimeoutRef.current = null;
    }, 1500);
  });
  const refreshSelection = useMemoizedFn(
    (fallbackTarget?: Node | null): MarkdownSourceSelection | null => {
      const container = containerRef.current;
      const nextSelection = container
        ? resolveMarkdownSourceSelection(container, fallbackTarget)
        : null;
      setSourceSelection(nextSelection);
      setReferenceFeedback(null);
      return nextSelection;
    },
  );
  const copyLineReference = useMemoizedFn(async (): Promise<void> => {
    if (
      lineReferenceUnavailable ||
      !lineReference ||
      !navigator.clipboard?.writeText
    ) {
      return;
    }
    await navigator.clipboard.writeText(lineReference);
    showFeedback("copied");
  });
  const copySelectedText = useMemoizedFn(async (): Promise<void> => {
    const selectedText = sourceSelection?.selectedText;
    if (!selectedText || !navigator.clipboard?.writeText) {
      return;
    }
    await navigator.clipboard.writeText(selectedText);
    showFeedback("copied");
  });
  const insertLineReference = useMemoizedFn((): void => {
    if (insertLineReferenceUnavailable || !lineReference) {
      return;
    }
    onInsertLineReference?.(lineReference);
    showFeedback("inserted");
  });
  const revealSourceLine = useMemoizedFn((): void => {
    if (sourceSelection) {
      onRevealSourceLine?.(sourceSelection.startLine);
    }
  });

  useEffect(() => {
    setSourceSelection(null);
    setReferenceFeedback(null);
  }, [resetKey]);

  useEffect(() => {
    const handleSelectionChange = (): void => {
      const container = containerRef.current;
      const selection = window.getSelection();
      if (
        !container ||
        !selection ||
        selection.isCollapsed ||
        !container.contains(selection.anchorNode) ||
        !container.contains(selection.focusNode)
      ) {
        setSourceSelection(null);
        return;
      }
      refreshSelection();
    };
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
      clearFeedbackTimer();
    };
  }, [clearFeedbackTimer, containerRef, refreshSelection]);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={containerRef}
          className="terminal-markdown-preview relative h-full overflow-auto px-5 py-4 text-sm leading-6 text-slate-200"
          onClick={onClick}
          onScroll={onScroll}
          onContextMenu={(event) => {
            refreshSelection(
              event.target instanceof Node ? event.target : null,
            );
          }}
        >
          {children}
          {sourceSelection?.selectedText ? (
            <div
              data-testid="markdown-reference-toolbar"
              className="absolute z-30 flex items-center gap-1 rounded-md border border-slate-700 bg-slate-900 p-1 shadow-xl"
              style={{ left: sourceSelection.left, top: sourceSelection.top }}
            >
              <button
                type="button"
                className="inline-flex h-7 items-center gap-1.5 rounded px-2 text-xs text-slate-100 hover:bg-slate-800 disabled:cursor-not-allowed disabled:text-slate-500"
                disabled={insertLineReferenceUnavailable}
                title={
                  lineReferenceTitle ??
                  lineReferenceDisabledReason ??
                  "Add line reference to Agent input"
                }
                onMouseDown={(event) => event.preventDefault()}
                onClick={insertLineReference}
              >
                {referenceFeedback === "inserted" ? (
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <MessageSquarePlus className="h-3.5 w-3.5" />
                )}
                {referenceFeedback === "inserted" ? "Added" : "Add to input"}
              </button>
              <button
                type="button"
                className="inline-flex h-7 w-7 items-center justify-center rounded text-slate-300 hover:bg-slate-800 hover:text-slate-100 disabled:cursor-not-allowed disabled:text-slate-600"
                disabled={lineReferenceUnavailable}
                title={lineReferenceTitle ?? "Copy line reference"}
                aria-label={
                  referenceFeedback === "copied"
                    ? "Line reference copied"
                    : "Copy line reference"
                }
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void copyLineReference()}
              >
                {referenceFeedback === "copied" ? (
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          ) : null}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem
          disabled={insertLineReferenceUnavailable}
          title={lineReferenceTitle ?? lineReferenceDisabledReason}
          onSelect={insertLineReference}
        >
          <MessageSquarePlus className="mr-2 h-4 w-4" />
          Add reference to input
        </ContextMenuItem>
        <ContextMenuItem
          disabled={lineReferenceUnavailable}
          title={lineReferenceTitle}
          onSelect={() => void copyLineReference()}
        >
          <Copy className="mr-2 h-4 w-4" />
          Copy line reference
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!sourceSelection?.selectedText}
          onSelect={() => void copySelectedText()}
        >
          <TextCursorInput className="mr-2 h-4 w-4" />
          Copy selected text
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          disabled={!sourceSelection || !onRevealSourceLine}
          onSelect={revealSourceLine}
        >
          Reveal in Source
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
