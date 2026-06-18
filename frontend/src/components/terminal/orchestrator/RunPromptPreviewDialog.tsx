import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";

export function RunPromptPreviewDialog(props: {
  open: boolean;
  loading: boolean;
  prompt: string;
  runId: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open && !props.loading) {
          props.onClose();
        }
      }}
    >
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>确认主 Agent Prompt</DialogTitle>
          <DialogDescription>
            Run: {props.runId || "pending"}
          </DialogDescription>
        </DialogHeader>
        <pre className="max-h-[55vh] overflow-auto rounded-md border bg-muted p-3 text-xs leading-relaxed text-foreground whitespace-pre-wrap">
          {props.prompt}
        </pre>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={props.loading}
            onClick={props.onClose}
          >
            取消
          </Button>
          <Button
            type="button"
            disabled={props.loading}
            onClick={props.onConfirm}
          >
            {props.loading ? "启动中..." : "确认并开始 Run"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
