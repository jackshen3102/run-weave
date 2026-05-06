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

  const formatLineReference = useCallback((range: LineReferenceRange): string | null => {
    const path = lineReferencePathRef.current;
    if (!path) {
      return null;
    }
    return range.startLine === range.endLine
      ? `${path}:${range.startLine}`
      : `${path}:${range.startLine}-${range.endLine}`;
  }, []);

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
    }, 1500);
    return true;
  }, [clearLineReferenceCopiedTimer, formatLineReference]);

  const updateLineReferenceRange = useCallback((): void => {
    const editor = editorRef.current;
    const selection = editor?.getSelection();
    if (!editor || !selection || selection.isEmpty() || !lineReferencePathRef.current) {
      lineReferenceRangeRef.current = null;
      setLineReferenceRange(null);
      setLineReferenceCopied(false);
      return;
    }

    const startLine = Math.min(selection.startLineNumber, selection.endLineNumber);
    let endLine = Math.max(selection.startLineNumber, selection.endLineNumber);
    if (endLine > startLine && selection.endColumn === 1) {
      endLine -= 1;
    }
    const visiblePosition = editor.getScrolledVisiblePosition({
      lineNumber: startLine,
      column: 1,
    });
    const nextRange = {
      startLine,
      endLine,
      top: Math.max(8, visiblePosition?.top ?? 8),
    };
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
        const scrollHeight = editor.getScrollHeight();
        const visibleHeight = editor.getLayoutInfo().height;
        const maxScrollTop = Math.max(0, scrollHeight - visibleHeight);
        onScrollRatioChange(
          maxScrollTop > 0 ? editor.getScrollTop() / maxScrollTop : 0,
        );
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
    const scrollHeight = editor.getScrollHeight();
    const visibleHeight = editor.getLayoutInfo().height;
    const maxScrollTop = Math.max(0, scrollHeight - visibleHeight);
    editor.setScrollTop(maxScrollTop * Math.min(Math.max(scrollRatio, 0), 1));
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

  const lineReferenceButton = lineReferenceRange ? (
    <button
      type="button"
      className="absolute right-3 z-20 inline-flex h-7 w-7 items-center justify-center rounded-md border border-slate-700 bg-slate-900 text-slate-100 shadow-lg hover:border-slate-500 hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      style={{ top: lineReferenceRange.top }}
      aria-label={
        lineReferenceCopied ? "Line reference copied" : "Copy line reference"
      }
      title={
        lineReferenceCopied ? "Line reference copied" : "Copy line reference"
      }
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        void copyLineReference();
      }}
    >
      {lineReferenceCopied ? (
        <Check className="h-4 w-4 text-emerald-400" />
      ) : (
        <Copy className="h-4 w-4" />
      )}
    </button>
  ) : null;

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
