import { useCallback, useEffect, useRef, useState } from "react";
import "./monaco-workers";
import Editor, {
  DiffEditor,
  type DiffOnMount,
  type OnMount,
} from "@monaco-editor/react";
import { Check, Copy } from "lucide-react";

type MonacoEditor = Parameters<OnMount>[0];
type MonacoApi = Parameters<OnMount>[1];

interface LineReferenceRange {
  startLine: number;
  endLine: number;
  top: number;
}

interface TerminalMonacoViewerProps {
  language?: string;
  content?: string;
  oldContent?: string;
  newContent?: string;
  diff?: boolean;
  scrollRatio?: number;
  onScrollRatioChange?: (ratio: number) => void;
  editable?: boolean;
  onContentChange?: (content: string) => void;
  lineReferencePath?: string;
}

const EDITOR_OPTIONS = {
  readOnly: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  wordWrap: "on" as const,
  fontSize: 13,
  lineHeight: 20,
  renderWhitespace: "selection" as const,
  automaticLayout: true,
};

const LINE_REFERENCE_COPY_RESET_MS = 1500;
const LINE_REFERENCE_BUTTON_MIN_TOP = 8;

function getEditorScrollRatio(editor: MonacoEditor): number {
  const scrollHeight = editor.getScrollHeight();
  const visibleHeight = editor.getLayoutInfo().height;
  const maxScrollTop = Math.max(0, scrollHeight - visibleHeight);
  return maxScrollTop > 0 ? editor.getScrollTop() / maxScrollTop : 0;
}

function applyEditorScrollRatio(editor: MonacoEditor, ratio: number): void {
  const scrollHeight = editor.getScrollHeight();
  const visibleHeight = editor.getLayoutInfo().height;
  const maxScrollTop = Math.max(0, scrollHeight - visibleHeight);
  const clampedRatio = Math.min(Math.max(ratio, 0), 1);
  editor.setScrollTop(maxScrollTop * clampedRatio);
}

function getSelectedLineReferenceRange(
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

interface LineReferenceCopyButtonProps {
  range: LineReferenceRange | null;
  copied: boolean;
  onCopy: () => void;
}

function LineReferenceCopyButton({
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

export function TerminalMonacoViewer({
  language = "plaintext",
  content = "",
  oldContent = "",
  newContent = "",
  diff = false,
  scrollRatio,
  onScrollRatioChange,
  editable = false,
  onContentChange,
  lineReferencePath,
}: TerminalMonacoViewerProps) {
  const editorRef = useRef<MonacoEditor | null>(null);
  const scrollDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const selectionDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const shortcutDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const lineReferencePathRef = useRef(lineReferencePath);
  const lineReferenceRangeRef = useRef<LineReferenceRange | null>(null);
  const copiedTimeoutRef = useRef<number | null>(null);
  const [lineReferenceRange, setLineReferenceRange] =
    useState<LineReferenceRange | null>(null);
  const [lineReferenceCopied, setLineReferenceCopied] = useState(false);

  const clearLineReferenceCopiedTimer = useCallback((): void => {
    if (copiedTimeoutRef.current === null) {
      return;
    }
    window.clearTimeout(copiedTimeoutRef.current);
    copiedTimeoutRef.current = null;
  }, []);

  const formatLineReference = useCallback(
    (range: LineReferenceRange): string | null => {
      const path = lineReferencePathRef.current;
      if (!path) {
        return null;
      }
      return range.startLine === range.endLine
        ? `${path}:${range.startLine}`
        : `${path}:${range.startLine}-${range.endLine}`;
    },
    [],
  );

  const copyLineReference = useCallback(async (): Promise<boolean> => {
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
  }, [clearLineReferenceCopiedTimer, formatLineReference]);

  const updateLineReferenceRange = useCallback((): void => {
    const editor = editorRef.current;
    const nextRange = editor
      ? getSelectedLineReferenceRange(editor, lineReferencePathRef.current)
      : null;
    if (!nextRange) {
      lineReferenceRangeRef.current = null;
      setLineReferenceRange(null);
      setLineReferenceCopied(false);
      return;
    }
    lineReferenceRangeRef.current = nextRange;
    setLineReferenceRange(nextRange);
    setLineReferenceCopied(false);
  }, []);

  const bindLineReferenceEditor = useCallback(
    (editor: MonacoEditor, monaco: MonacoApi): void => {
      editorRef.current = editor;
      scrollDisposableRef.current?.dispose();
      selectionDisposableRef.current?.dispose();
      shortcutDisposableRef.current?.dispose();
      scrollDisposableRef.current = editor.onDidScrollChange(() => {
        updateLineReferenceRange();
        if (!onScrollRatioChange || diff) {
          return;
        }
        onScrollRatioChange(getEditorScrollRatio(editor));
      });
      selectionDisposableRef.current = editor.onDidChangeCursorSelection(() => {
        updateLineReferenceRange();
      });
      shortcutDisposableRef.current = editor.addAction({
        id: "copy-line-reference",
        label: "Copy line reference",
        keybindings: [
          monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyC,
        ],
        run: () => {
          void copyLineReference();
        },
      });
      updateLineReferenceRange();
    },
    [copyLineReference, diff, onScrollRatioChange, updateLineReferenceRange],
  );

  const handleEditorMount = useCallback<OnMount>(
    (editor, monaco) => {
      bindLineReferenceEditor(editor, monaco);
    },
    [bindLineReferenceEditor],
  );

  const handleDiffEditorMount = useCallback<DiffOnMount>(
    (editor, monaco) => {
      bindLineReferenceEditor(editor.getModifiedEditor(), monaco);
    },
    [bindLineReferenceEditor],
  );

  useEffect(() => {
    lineReferencePathRef.current = lineReferencePath;
    updateLineReferenceRange();
  }, [lineReferencePath, updateLineReferenceRange]);

  useEffect(() => {
    if (diff || scrollRatio === undefined) {
      return;
    }
    const editor = editorRef.current;
    if (!editor) {
      return;
    }
    applyEditorScrollRatio(editor, scrollRatio);
  }, [diff, scrollRatio]);

  useEffect(() => {
    return () => {
      scrollDisposableRef.current?.dispose();
      scrollDisposableRef.current = null;
      selectionDisposableRef.current?.dispose();
      selectionDisposableRef.current = null;
      shortcutDisposableRef.current?.dispose();
      shortcutDisposableRef.current = null;
      clearLineReferenceCopiedTimer();
    };
  }, [clearLineReferenceCopiedTimer]);

  const lineReferenceButton = (
    <LineReferenceCopyButton
      range={lineReferenceRange}
      copied={lineReferenceCopied}
      onCopy={() => {
        void copyLineReference();
      }}
    />
  );

  if (diff) {
    return (
      <div className="relative h-full min-h-0">
        <DiffEditor
          height="100%"
          language={language}
          original={oldContent}
          modified={newContent}
          theme="vs-dark"
          options={{
            ...EDITOR_OPTIONS,
            originalEditable: false,
            readOnly: true,
            renderSideBySide: true,
          }}
          onMount={handleDiffEditorMount}
        />
        {lineReferenceButton}
      </div>
    );
  }

  return (
    <div className="relative h-full min-h-0">
      <Editor
        height="100%"
        language={language}
        value={content}
        theme="vs-dark"
        options={{ ...EDITOR_OPTIONS, readOnly: !editable }}
        onChange={(value) => onContentChange?.(value ?? "")}
        onMount={handleEditorMount}
      />
      {lineReferenceButton}
    </div>
  );
}
