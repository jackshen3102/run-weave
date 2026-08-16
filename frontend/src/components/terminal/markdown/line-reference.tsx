import { useMemoizedFn } from "ahooks";
import { useRef, useState, type RefObject } from "react";
import { Check, Copy } from "lucide-react";
import type { OnMount } from "@monaco-editor/react";

type MonacoEditor = Parameters<OnMount>[0];

export interface LineReferenceRange {
  startLine: number;
  endLine: number;
  top: number;
}

const LINE_REFERENCE_COPY_RESET_MS = 1500;
const LINE_REFERENCE_BUTTON_MIN_TOP = 8;

export function getSelectedLineReferenceRange(
  editor: MonacoEditor,
  lineReferencePath?: string,
): LineReferenceRange | null {
  const selection = editor.getSelection();
  if (!selection || selection.isEmpty() || !lineReferencePath) {
    return null;
  }

  const startLine = Math.min(
    selection.startLineNumber,
    selection.endLineNumber,
  );
  let endLine = Math.max(selection.startLineNumber, selection.endLineNumber);
  if (endLine > startLine && selection.endColumn === 1) {
    endLine -= 1;
  }

  const visiblePosition = editor.getScrolledVisiblePosition({
    lineNumber: startLine,
    column: 1,
  });
  return {
    startLine,
    endLine,
    top: Math.max(
      LINE_REFERENCE_BUTTON_MIN_TOP,
      visiblePosition?.top ?? LINE_REFERENCE_BUTTON_MIN_TOP,
    ),
  };
}

interface UseLineReferenceCopyResult {
  lineReferenceCopied: boolean;
  copyLineReference: () => Promise<boolean>;
  clearLineReferenceCopiedTimer: () => void;
  resetLineReferenceCopied: () => void;
}

export function useLineReferenceCopy(
  lineReferencePathRef: RefObject<string | undefined>,
  lineReferenceRangeRef: RefObject<LineReferenceRange | null>,
): UseLineReferenceCopyResult {
  const copiedTimeoutRef = useRef<number | null>(null);
  const [lineReferenceCopied, setLineReferenceCopied] = useState(false);

  const clearLineReferenceCopiedTimer = useMemoizedFn((): void => {
    if (copiedTimeoutRef.current === null) {
      return;
    }
    window.clearTimeout(copiedTimeoutRef.current);
    copiedTimeoutRef.current = null;
  });

  const resetLineReferenceCopied = useMemoizedFn((): void => {
    setLineReferenceCopied(false);
  });

  const formatLineReference = useMemoizedFn(
    (range: LineReferenceRange): string | null => {
      const path = lineReferencePathRef.current;
      if (!path) {
        return null;
      }
      return range.startLine === range.endLine
        ? `${path}:${range.startLine}`
        : `${path}:${range.startLine}-${range.endLine}`;
    },
  );

  const copyLineReference = useMemoizedFn(async (): Promise<boolean> => {
    const range = lineReferenceRangeRef.current;
    const reference = range ? formatLineReference(range) : null;
    if (!reference || !navigator.clipboard?.writeText) {
      return false;
    }
    await navigator.clipboard.writeText(reference);
    setLineReferenceCopied(true);
    clearLineReferenceCopiedTimer();
    copiedTimeoutRef.current = window.setTimeout(() => {
      setLineReferenceCopied(false);
      copiedTimeoutRef.current = null;
    }, LINE_REFERENCE_COPY_RESET_MS);
    return true;
  });

  return {
    lineReferenceCopied,
    copyLineReference,
    clearLineReferenceCopiedTimer,
    resetLineReferenceCopied,
  };
}

interface LineReferenceCopyButtonProps {
  range: LineReferenceRange | null;
  copied: boolean;
  onCopy: () => void;
}

export function LineReferenceCopyButton({
  range,
  copied,
  onCopy,
}: LineReferenceCopyButtonProps) {
  if (!range) {
    return null;
  }

  const label = copied ? "Line reference copied" : "Copy line reference";
  return (
    <button
      type="button"
      className="absolute right-3 z-20 inline-flex h-7 w-7 items-center justify-center rounded-md border border-slate-700 bg-slate-900 text-slate-100 shadow-lg hover:border-slate-500 hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      style={{ top: range.top }}
      aria-label={label}
      title={label}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onCopy}
    >
      {copied ? (
        <Check className="h-4 w-4 text-emerald-400" />
      ) : (
        <Copy className="h-4 w-4" />
      )}
    </button>
  );
}
