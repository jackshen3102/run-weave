import { useMemoizedFn } from "ahooks";
import {
  MessageSquarePlus,
  MousePointer2,
  Pencil,
  Send,
  Trash2,
  X,
} from "lucide-react";
import type {
  TerminalBrowserAnnotationDraft,
  TerminalBrowserAnnotationState,
} from "@runweave/shared/terminal-browser-annotation";
import { Button } from "../ui/button";

interface TerminalBrowserAnnotationsPanelProps {
  error: string | null;
  open: boolean;
  state: TerminalBrowserAnnotationState;
  submitting: boolean;
  onClose: () => void;
  onDelete: (annotationId: string) => void;
  onDiscard: () => void;
  onFocus: (annotationId: string) => void;
  onSelectingChange: (selecting: boolean) => void;
  onSubmit: () => void;
}

interface TerminalBrowserAnnotationModeBarProps {
  selecting: boolean;
  onDone: () => void;
}

function annotationTargetLabel(
  annotation: TerminalBrowserAnnotationDraft,
): string {
  return (
    annotation.target.targetText ||
    annotation.target.targetSelector ||
    annotation.target.targetPath ||
    "Page element"
  );
}

export function TerminalBrowserAnnotationModeBar({
  selecting,
  onDone,
}: TerminalBrowserAnnotationModeBarProps) {
  if (!selecting) {
    return null;
  }

  return (
    <div className="flex min-h-10 shrink-0 items-center gap-2 border-b border-sky-800/60 bg-sky-950/35 px-3">
      <span className="flex h-6 w-6 items-center justify-center rounded-md bg-sky-500/15 text-sky-300">
        <MousePointer2 className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-sky-100">Browser comment mode</p>
        <p className="truncate text-[10px] text-sky-400">
          Select a page element to add a comment
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 rounded-md px-2 text-xs text-sky-200 hover:bg-sky-500/10 hover:text-sky-100"
        onClick={onDone}
      >
        Done
      </Button>
    </div>
  );
}

export function TerminalBrowserAnnotationsPanel({
  error,
  open,
  state,
  submitting,
  onClose,
  onDelete,
  onDiscard,
  onFocus,
  onSelectingChange,
  onSubmit,
}: TerminalBrowserAnnotationsPanelProps) {
  const discard = useMemoizedFn(() => {
    if (
      state.annotations.length === 0 ||
      window.confirm(
        `Discard ${state.annotations.length} browser comment${state.annotations.length === 1 ? "" : "s"}?`,
      )
    ) {
      onDiscard();
    }
  });

  if (!open) {
    return null;
  }

  return (
    <aside className="absolute inset-y-0 right-0 z-10 flex w-[320px] flex-col border-l border-slate-800 bg-slate-950">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-slate-800 px-3">
        <MessageSquarePlus className="h-3.5 w-3.5 text-sky-300" />
        <p className="min-w-0 flex-1 text-xs font-medium text-slate-200">
          Browser comments
        </p>
        <span className="rounded-full bg-slate-800 px-1.5 py-0.5 text-[10px] font-medium text-slate-400">
          {state.annotations.length}
        </span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 w-7 rounded-md px-0"
          aria-label="Close browser comments panel"
          title="Close browser comments panel"
          onClick={onClose}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {state.annotations.length === 0 ? (
          <div className="flex min-h-48 flex-col items-center justify-center rounded-md border border-dashed border-slate-800 px-5 text-center">
            <span className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-sky-500/10 text-sky-300">
              <MousePointer2 className="h-4 w-4" />
            </span>
            <p className="text-xs font-medium text-slate-300">
              No comments yet
            </p>
            <p className="mt-1 text-[11px] leading-4 text-slate-500">
              Select an element in the page to add the first comment.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {state.annotations.map((annotation) => (
              <article
                key={annotation.id}
                className="rounded-md border border-slate-800 bg-slate-900/50 p-2.5"
              >
                <div className="flex items-start gap-2">
                  <button
                    type="button"
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-sky-700 text-[10px] font-semibold text-white hover:bg-sky-600"
                    aria-label={`Edit browser comment ${annotation.index}`}
                    title="Edit on page"
                    disabled={submitting}
                    onClick={() => onFocus(annotation.id)}
                  >
                    {annotation.index}
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[10px] text-slate-500">
                      {annotationTargetLabel(annotation)}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-slate-200">
                      {annotation.comment}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-6 w-6 rounded px-0 text-slate-500 hover:text-sky-300"
                      aria-label={`Edit browser comment ${annotation.index}`}
                      title="Edit on page"
                      disabled={submitting}
                      onClick={() => onFocus(annotation.id)}
                    >
                      <Pencil className="h-3 w-3" />
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-6 w-6 rounded px-0 text-slate-500 hover:text-rose-300"
                      aria-label={`Delete browser comment ${annotation.index}`}
                      title="Delete comment"
                      disabled={submitting}
                      onClick={() => onDelete(annotation.id)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      <div className="shrink-0 space-y-2 border-t border-slate-800 p-3">
        {error ? (
          <p className="rounded-md border border-rose-900/60 bg-rose-950/30 px-2.5 py-2 text-[11px] leading-4 text-rose-300">
            {error} Your comments are still available to retry.
          </p>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8 w-full rounded-md border border-slate-800 text-xs"
          disabled={submitting}
          onClick={() => onSelectingChange(!state.selecting)}
        >
          <MousePointer2 className="mr-1.5 h-3.5 w-3.5" />
          {state.selecting ? "Finish selecting" : "Add another comment"}
        </Button>
        <Button
          type="button"
          size="sm"
          className="h-9 w-full rounded-md text-xs"
          disabled={state.annotations.length === 0 || submitting}
          onClick={onSubmit}
        >
          <Send className="mr-1.5 h-3.5 w-3.5" />
          {submitting
            ? "Sending comments..."
            : `Send ${state.annotations.length} to Agent`}
        </Button>
        {state.annotations.length > 0 ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 w-full rounded-md text-[11px] text-slate-500 hover:text-rose-300"
            disabled={submitting}
            onClick={discard}
          >
            Discard all comments
          </Button>
        ) : null}
      </div>
    </aside>
  );
}
