import { useEffect, useRef } from "react";
import "./monaco-workers";
import Editor, { DiffEditor, type OnMount } from "@monaco-editor/react";

type MonacoEditor = Parameters<OnMount>[0];

interface TerminalMonacoViewerProps {
  language?: string;
  content?: string;
  oldContent?: string;
  newContent?: string;
  diff?: boolean;
  scrollRatio?: number;
  onScrollRatioChange?: (ratio: number) => void;
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
}: TerminalMonacoViewerProps) {
  const editorRef = useRef<MonacoEditor | null>(null);
  const scrollDisposableRef = useRef<{ dispose: () => void } | null>(null);

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
    };
  }, []);

  if (diff) {
    return (
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
      />
    );
  }

  return (
    <Editor
      height="100%"
      language={language}
      value={content}
      theme="vs-dark"
      options={EDITOR_OPTIONS}
      onMount={(editor) => {
        editorRef.current = editor;
        scrollDisposableRef.current?.dispose();
        scrollDisposableRef.current = editor.onDidScrollChange(() => {
          if (!onScrollRatioChange) {
            return;
          }
          const scrollHeight = editor.getScrollHeight();
          const visibleHeight = editor.getLayoutInfo().height;
          const maxScrollTop = Math.max(0, scrollHeight - visibleHeight);
          onScrollRatioChange(maxScrollTop > 0 ? editor.getScrollTop() / maxScrollTop : 0);
        });
      }}
    />
  );
}
