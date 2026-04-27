import { useTerminalPreviewStore } from "../../features/terminal/preview-store";
import { Button } from "../ui/button";

interface TerminalPreviewMenuProps {
  projectId: string | null;
  disabled?: boolean;
  buttonClassName?: string;
}

export function TerminalPreviewMenu({
  projectId,
  disabled = false,
  buttonClassName,
}: TerminalPreviewMenuProps) {
  const openPreview = useTerminalPreviewStore((state) => state.openPreview);
  const previewOpen = useTerminalPreviewStore((state) => state.ui.open);

  return (
    <Button
      type="button"
      size="sm"
      variant={previewOpen ? "secondary" : "ghost"}
      disabled={disabled || !projectId}
      className={buttonClassName ?? "h-7 shrink-0 rounded-md px-2 text-xs"}
      onClick={() => {
        if (projectId) {
          openPreview(projectId);
        }
      }}
    >
      Preview
    </Button>
  );
}
