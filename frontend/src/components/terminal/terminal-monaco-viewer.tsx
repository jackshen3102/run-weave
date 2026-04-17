import "./monaco-workers";
import Editor, { DiffEditor } from "@monaco-editor/react";

interface TerminalMonacoViewerProps {
  language?: string;
  content?: string;
  oldContent?: string;
  newContent?: string;
  diff?: boolean;
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
}: TerminalMonacoViewerProps) {
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
    />
  );
}
