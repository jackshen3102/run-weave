import { useMemoizedFn } from "ahooks";
import { useEffect, useRef, useState } from "react";
import "./monaco-workers";
import Editor, {
  DiffEditor,
  type DiffOnMount,
  type OnMount,
} from "@monaco-editor/react";
import {
  getSelectedLineReferenceRange,
  LineReferenceCopyButton,
  type LineReferenceRange,
  useLineReferenceCopy,
} from "./terminal-line-reference";

type MonacoEditor = Parameters<OnMount>[0];
type MonacoDiffEditor = Parameters<DiffOnMount>[0];
type MonacoApi = Parameters<OnMount>[1];
type MonacoDiffModel = NonNullable<ReturnType<MonacoDiffEditor["getModel"]>>;

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
  const diffModelRef = useRef<MonacoDiffModel | null>(null);
  const scrollDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const selectionDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const shortcutDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const lineReferencePathRef = useRef(lineReferencePath);
  const lineReferenceRangeRef = useRef<LineReferenceRange | null>(null);
  const [lineReferenceRange, setLineReferenceRange] =
    useState<LineReferenceRange | null>(null);
  const {
    lineReferenceCopied,
    copyLineReference,
    clearLineReferenceCopiedTimer,
    resetLineReferenceCopied,
  } = useLineReferenceCopy(lineReferencePathRef, lineReferenceRangeRef);

  const updateLineReferenceRange = useMemoizedFn((): void => {
    const editor = editorRef.current;
    const nextRange = editor
      ? getSelectedLineReferenceRange(editor, lineReferencePathRef.current)
      : null;
    if (!nextRange) {
      lineReferenceRangeRef.current = null;
      setLineReferenceRange(null);
      resetLineReferenceCopied();
      return;
    }
    lineReferenceRangeRef.current = nextRange;
    setLineReferenceRange(nextRange);
    resetLineReferenceCopied();
  });

  const bindLineReferenceEditor = useMemoizedFn(
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
  );

  const handleEditorMount = useMemoizedFn<OnMount>((editor, monaco) => {
    bindLineReferenceEditor(editor, monaco);
  });

  const handleDiffEditorMount = useMemoizedFn<DiffOnMount>((editor, monaco) => {
    diffModelRef.current = editor.getModel();
    bindLineReferenceEditor(editor.getModifiedEditor(), monaco);
  });

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
      const diffModel = diffModelRef.current;
      diffModelRef.current = null;
      if (diffModel) {
        window.setTimeout(() => {
          if (!diffModel.original.isDisposed()) {
            diffModel.original.dispose();
          }
          if (!diffModel.modified.isDisposed()) {
            diffModel.modified.dispose();
          }
        }, 0);
      }
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
          keepCurrentOriginalModel
          keepCurrentModifiedModel
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
