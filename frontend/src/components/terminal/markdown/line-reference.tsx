import { useMemoizedFn } from "ahooks";
import { useRef, useState, type RefObject } from "react";
import { Check, Copy, MessageSquarePlus } from "lucide-react";
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
  onInsert?: () => void;
  insertDisabledReason?: string;
}

export function LineReferenceCopyButton({
  range,
  copied,
  onCopy,
  onInsert,
  insertDisabledReason,
}: LineReferenceCopyButtonProps) {
  if (!range) {
    return null;
  }

  const label = copied ? "Line reference copied" : "Copy line reference";
  return (
    <div className="absolute right-3 z-20 flex items-center gap-1 rounded-md border border-slate-700 bg-slate-900 p-1 text-slate-100 shadow-lg" style={{ top: range.top }} onMouseDown={(event) => event.preventDefault()}>
    {onInsert ? <button type="button" onClick={onInsert} disabled={Boolean(insertDisabledReason)}
      title={insertDisabledReason ?? "加入输入框；超过 4 KiB 时仅插入路径和行号"}
      className="inline-flex h-7 items-center gap-1 rounded px-2 text-xs hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:cursor-not-allowed disabled:opacity-50">
      <MessageSquarePlus className="h-4 w-4" />加入输入框
    </button> : null}
    <button
      type="button"
      className="inline-flex h-7 w-7 items-center justify-center rounded hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
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
    </div>
  );
}
