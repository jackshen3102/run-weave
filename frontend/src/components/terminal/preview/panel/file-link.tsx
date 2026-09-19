import { useEffect, useState } from "react";
import { useMemoizedFn } from "ahooks";
import type {
  TerminalFileLinkCandidate,
  TerminalFileLinkRequest,
  TerminalFileReference,
} from "@runweave/shared/terminal/file-link";
import { resolveTerminalPreviewFileLink } from "../../../../services/terminal/preview";
import { useTerminalRuntime } from "../../../../features/terminal/queries/provider";
import { Button } from "../../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "../../../ui/dialog";

export interface TerminalPreviewFileLinkIntent extends TerminalFileLinkRequest {
  id: number;
  scope: string;
  projectId: string;
}

export function TerminalPreviewFileLink({
  intent,
  onOpen,
  onDone,
  onError,
}: {
  intent: TerminalPreviewFileLinkIntent;
  onOpen: (
    path: string,
    target?: Pick<TerminalFileReference, "line" | "column">,
  ) => void;
  onDone: () => void;
  onError: (error: unknown) => string;
}) {
  const { apiBase, token } = useTerminalRuntime();
  const [candidates, setCandidates] = useState<TerminalFileLinkCandidate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const finish = useMemoizedFn(onDone);
  const reportError = useMemoizedFn(onError);
  const open = useMemoizedFn((candidate: TerminalFileLinkCandidate) => {
    onOpen(candidate.path, intent);
    finish();
  });
  useEffect(() => {
    const controller = new AbortController();
    void resolveTerminalPreviewFileLink(
      apiBase,
      token,
      intent.projectId,
      intent,
      controller.signal,
    )
      .then(({ candidates: items }) => {
        if (controller.signal.aborted) return;
        if (items.length === 1 && items[0]) open(items[0]);
        else setCandidates(items);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(reportError(cause));
      });
    return () => controller.abort();
  }, [apiBase, token, intent, open, reportError]);
  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value) finish();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {error
              ? "Cannot open file"
              : candidates.length
                ? "Choose a file"
                : "Opening file…"}
          </DialogTitle>
          <DialogDescription className="break-all">
            {intent.path}
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-sm text-rose-300">
            {error}
          </p>
        ) : null}
        {candidates.map((candidate) => (
          <Button
            key={candidate.absolutePath}
            variant="outline"
            className="h-auto justify-start whitespace-normal break-all text-left"
            onClick={() => open(candidate)}
          >
            {candidate.absolutePath}
          </Button>
        ))}
      </DialogContent>
    </Dialog>
  );
}
