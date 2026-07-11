import { useMemoizedFn } from "ahooks";
import type { TerminalPrototypeGallerySource } from "@runweave/shared/terminal/preview";
import { ArrowLeft, PanelsTopLeft } from "lucide-react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { PrototypeGallery } from "../components/prototypes/prototype-gallery";

interface PrototypesPageProps {
  apiBase: string;
  token: string;
  onAuthExpired: () => void;
}

export function PrototypesPage({
  apiBase,
  token,
  onAuthExpired,
}: PrototypesPageProps) {
  const navigate = useNavigate();
  const { projectId, prototypeSource, prototypeSlug } = useParams<{
    projectId?: string;
    prototypeSource?: string;
    prototypeSlug?: string;
  }>();
  const [searchParams] = useSearchParams();
  const preferredProjectId = projectId ?? searchParams.get("project");
  const selectedPrototypeSource: TerminalPrototypeGallerySource | undefined =
    prototypeSource === "prototypes" || prototypeSource === "architecture-flows"
      ? prototypeSource
      : undefined;

  const handleSelectionChange = useMemoizedFn(
    (selection: {
      projectId: string;
      source: TerminalPrototypeGallerySource;
      slug: string;
    }): void => {
      const nextPath = `/prototypes/${encodeURIComponent(selection.projectId)}/${encodeURIComponent(selection.source)}/${encodeURIComponent(selection.slug)}`;
      if (
        selection.projectId === projectId &&
        selection.source === selectedPrototypeSource &&
        selection.slug === prototypeSlug
      ) {
        return;
      }
      navigate(nextPath, { replace: true });
    },
  );

  return (
    <main className="flex h-dvh min-h-0 flex-col overflow-hidden bg-slate-950 text-slate-100 dark">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-slate-800 px-4">
        <button
          type="button"
          aria-label="Back to terminal"
          title="Back to terminal"
          className="grid h-8 w-8 place-items-center rounded-md text-slate-400 transition hover:bg-slate-800 hover:text-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
          onClick={() => navigate("/terminal")}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <PanelsTopLeft className="h-4 w-4 text-slate-400" />
        <div className="min-w-0">
          <h1 className="truncate text-sm font-medium text-slate-100">
            Prototypes
          </h1>
          <p className="truncate text-[10px] text-slate-500">
            Project prototype library
          </p>
        </div>
      </header>
      <div className="min-h-0 flex-1">
        <PrototypeGallery
          apiBase={apiBase}
          token={token}
          activeProjectId={preferredProjectId}
          selectedProjectId={projectId}
          selectedPrototypeSource={selectedPrototypeSource}
          selectedPrototypeSlug={prototypeSlug}
          onSelectionChange={handleSelectionChange}
          onAuthExpired={onAuthExpired}
        />
      </div>
    </main>
  );
}
