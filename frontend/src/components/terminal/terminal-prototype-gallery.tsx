import { useMemoizedFn } from "ahooks";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  TerminalPrototypeGalleryItem,
  TerminalPrototypeGalleryProject,
  TerminalPrototypeGalleryResponse,
} from "@runweave/shared";
import { AlertCircle, FileCode2, FolderKanban, RefreshCw } from "lucide-react";
import { HttpError } from "../../services/http";
import {
  createTerminalPrototypePreviewTicket,
  listTerminalPrototypeGallery,
} from "../../services/terminal";

interface PrototypeSelection {
  projectId: string;
  slug: string;
}

interface TerminalPrototypeGalleryProps {
  apiBase: string;
  token: string;
  activeProjectId: string | null;
  onAuthExpired?: () => void;
}

const SELECTION_STORAGE_PREFIX = "runweave.prototype-gallery.selection.v1";

function selectionStorageKey(apiBase: string): string {
  return `${SELECTION_STORAGE_PREFIX}:${apiBase || "local"}`;
}

function readStoredSelection(apiBase: string): PrototypeSelection | null {
  try {
    const value = window.localStorage.getItem(selectionStorageKey(apiBase));
    if (!value) {
      return null;
    }
    const parsed = JSON.parse(value) as Partial<PrototypeSelection>;
    return typeof parsed.projectId === "string" &&
      typeof parsed.slug === "string"
      ? { projectId: parsed.projectId, slug: parsed.slug }
      : null;
  } catch {
    return null;
  }
}

function persistSelection(
  apiBase: string,
  selection: PrototypeSelection,
): void {
  try {
    window.localStorage.setItem(
      selectionStorageKey(apiBase),
      JSON.stringify(selection),
    );
  } catch {
    // The current in-memory selection remains usable when storage is blocked.
  }
}

function sameSelection(
  left: PrototypeSelection | null,
  right: PrototypeSelection,
): boolean {
  return left?.projectId === right.projectId && left.slug === right.slug;
}

function findGalleryItem(
  gallery: TerminalPrototypeGalleryResponse,
  selection: PrototypeSelection | null,
): {
  project: TerminalPrototypeGalleryProject;
  prototype: TerminalPrototypeGalleryItem;
} | null {
  if (!selection) {
    return null;
  }
  const project = gallery.projects.find(
    (item) => item.projectId === selection.projectId,
  );
  const prototype = project?.prototypes.find(
    (item) => item.slug === selection.slug,
  );
  return project && prototype ? { project, prototype } : null;
}

function chooseGallerySelection(params: {
  gallery: TerminalPrototypeGalleryResponse;
  current: PrototypeSelection | null;
  stored: PrototypeSelection | null;
  activeProjectId: string | null;
}): PrototypeSelection | null {
  for (const candidate of [params.current, params.stored]) {
    if (findGalleryItem(params.gallery, candidate)) {
      return candidate;
    }
  }
  const activeProject = params.gallery.projects.find(
    (project) => project.projectId === params.activeProjectId,
  );
  const activePrototype = activeProject?.prototypes[0];
  if (activeProject && activePrototype) {
    return {
      projectId: activeProject.projectId,
      slug: activePrototype.slug,
    };
  }
  for (const project of params.gallery.projects) {
    const prototype = project.prototypes[0];
    if (prototype) {
      return { projectId: project.projectId, slug: prototype.slug };
    }
  }
  return null;
}

function projectEmptyMessage(project: TerminalPrototypeGalleryProject): string {
  if (project.status === "project-path-missing") {
    return "Project path is not set";
  }
  if (project.status === "prototype-root-missing") {
    return "No docs/prototypes directory";
  }
  if (project.status === "prototype-root-unavailable") {
    return "Prototype directory is unavailable";
  }
  return "No prototypes";
}

function buildPreviewUrl(apiBase: string, previewPath: string): string {
  return `${apiBase.replace(/\/$/, "")}${previewPath}`;
}

export function TerminalPrototypeGallery({
  apiBase,
  token,
  activeProjectId,
  onAuthExpired,
}: TerminalPrototypeGalleryProps) {
  const [gallery, setGallery] =
    useState<TerminalPrototypeGalleryResponse | null>(null);
  const [selection, setSelection] = useState<PrototypeSelection | null>(() =>
    readStoredSelection(apiBase),
  );
  const [galleryLoading, setGalleryLoading] = useState(true);
  const [galleryError, setGalleryError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const galleryRequestRef = useRef(0);
  const previewRequestRef = useRef(0);

  const selected = useMemo(
    () => (gallery ? findGalleryItem(gallery, selection) : null),
    [gallery, selection],
  );

  const handleRequestError = useMemoizedFn((error: unknown): string => {
    if (error instanceof HttpError && error.status === 401) {
      onAuthExpired?.();
    }
    return error instanceof Error ? error.message : String(error);
  });

  const loadGallery = useMemoizedFn(async (): Promise<void> => {
    const requestId = galleryRequestRef.current + 1;
    galleryRequestRef.current = requestId;
    setGalleryLoading(true);
    setGalleryError(null);
    try {
      const payload = await listTerminalPrototypeGallery(apiBase, token);
      if (galleryRequestRef.current !== requestId) {
        return;
      }
      setGallery(payload);
      setSelection((current) => {
        const next = chooseGallerySelection({
          gallery: payload,
          current,
          stored: readStoredSelection(apiBase),
          activeProjectId,
        });
        if (next) {
          persistSelection(apiBase, next);
        }
        return next;
      });
    } catch (error) {
      if (galleryRequestRef.current === requestId) {
        setGalleryError(handleRequestError(error));
      }
    } finally {
      if (galleryRequestRef.current === requestId) {
        setGalleryLoading(false);
      }
    }
  });

  const loadPreview = useMemoizedFn(async (): Promise<void> => {
    const requestId = previewRequestRef.current + 1;
    previewRequestRef.current = requestId;
    if (!selected?.prototype.entry) {
      setPreviewUrl(null);
      setPreviewError(null);
      setPreviewLoading(false);
      return;
    }
    setPreviewUrl(null);
    setPreviewError(null);
    setPreviewLoading(true);
    try {
      const ticket = await createTerminalPrototypePreviewTicket(
        apiBase,
        token,
        selected.project.projectId,
        selected.prototype.slug,
      );
      if (previewRequestRef.current !== requestId) {
        return;
      }
      setPreviewUrl(buildPreviewUrl(apiBase, ticket.path));
    } catch (error) {
      if (previewRequestRef.current === requestId) {
        setPreviewError(handleRequestError(error));
        setPreviewLoading(false);
      }
    }
  });

  const selectPrototype = useMemoizedFn((next: PrototypeSelection): void => {
    persistSelection(apiBase, next);
    setSelection((current) => (sameSelection(current, next) ? current : next));
  });

  useEffect(() => {
    void loadGallery();
  }, [apiBase, loadGallery, token]);

  useEffect(() => {
    void loadPreview();
  }, [
    loadPreview,
    selected?.project.projectId,
    selected?.prototype.entry,
    selected?.prototype.slug,
  ]);

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(190px,28%)_minmax(0,1fr)] bg-slate-950">
      <aside className="flex min-h-0 flex-col border-r border-slate-800">
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-slate-800 px-3">
          <div className="flex min-w-0 items-center gap-2">
            <FolderKanban className="h-3.5 w-3.5 shrink-0 text-slate-400" />
            <span className="truncate text-xs font-medium text-slate-200">
              Project prototypes
            </span>
          </div>
          <button
            type="button"
            aria-label="Refresh prototype library"
            title="Refresh prototype library"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-400 transition hover:bg-slate-800 hover:text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500"
            onClick={() => void loadGallery()}
          >
            <RefreshCw
              className={[
                "h-3.5 w-3.5",
                galleryLoading ? "animate-spin" : "",
              ].join(" ")}
            />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {galleryLoading && !gallery ? (
            <p className="px-2 py-4 text-xs text-slate-500">
              Loading prototypes...
            </p>
          ) : galleryError ? (
            <div className="flex gap-2 rounded-md border border-rose-900/70 bg-rose-950/40 p-2 text-xs text-rose-200">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{galleryError}</span>
            </div>
          ) : gallery ? (
            <div className="space-y-3">
              {gallery.projects.map((project) => (
                <section key={project.projectId} aria-label={project.name}>
                  <div className="flex items-center justify-between gap-2 px-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-slate-500">
                    <span
                      className="truncate normal-case"
                      title={project.path ?? undefined}
                    >
                      {project.name}
                    </span>
                    <span>{project.prototypes.length}</span>
                  </div>
                  {project.prototypes.length > 0 ? (
                    <div className="space-y-0.5">
                      {project.prototypes.map((prototype) => {
                        const active = sameSelection(selection, {
                          projectId: project.projectId,
                          slug: prototype.slug,
                        });
                        return (
                          <button
                            type="button"
                            key={prototype.slug}
                            aria-current={active ? "page" : undefined}
                            className={[
                              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition focus:outline-none focus:ring-2 focus:ring-slate-500",
                              active
                                ? "bg-slate-800 text-slate-50"
                                : "text-slate-400 hover:bg-slate-900 hover:text-slate-100",
                            ].join(" ")}
                            onClick={() =>
                              selectPrototype({
                                projectId: project.projectId,
                                slug: prototype.slug,
                              })
                            }
                          >
                            <FileCode2 className="h-3.5 w-3.5 shrink-0" />
                            <span className="min-w-0 flex-1">
                              <span
                                className="block truncate"
                                title={prototype.title}
                              >
                                {prototype.title}
                              </span>
                              <span className="block truncate text-[10px] text-slate-600">
                                {prototype.slug}
                              </span>
                            </span>
                            {!prototype.entry ? (
                              <span className="shrink-0 rounded border border-amber-900/80 px-1 py-0.5 text-[8px] uppercase text-amber-400">
                                No entry
                              </span>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="px-2 py-1 text-[10px] text-slate-600">
                      {projectEmptyMessage(project)}
                    </p>
                  )}
                </section>
              ))}
              {gallery.projects.length === 0 ? (
                <p className="px-2 py-4 text-xs text-slate-500">
                  No Runweave projects
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </aside>

      <section className="flex min-h-0 min-w-0 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-slate-800 px-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-slate-200">
              {selected?.prototype.title ?? "Prototype preview"}
            </p>
            {selected ? (
              <p className="truncate text-[10px] text-slate-600">
                {selected.project.name} / docs/prototypes/
                {selected.prototype.slug}
              </p>
            ) : null}
          </div>
          {selected?.prototype.entry ? (
            <button
              type="button"
              aria-label="Reload prototype"
              title="Reload prototype"
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-400 transition hover:bg-slate-800 hover:text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500"
              onClick={() => void loadPreview()}
            >
              <RefreshCw
                className={[
                  "h-3.5 w-3.5",
                  previewLoading ? "animate-spin" : "",
                ].join(" ")}
              />
            </button>
          ) : null}
        </div>
        <div className="relative min-h-0 flex-1 bg-slate-950">
          {previewError ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-xs text-rose-300">
              {previewError}
            </div>
          ) : selected && !selected.prototype.entry ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <FileCode2 className="h-8 w-8 text-slate-700" />
              <div>
                <p className="text-sm text-slate-300">No index.html entry</p>
                <p className="mt-1 text-xs text-slate-600">
                  Add index.html to this prototype directory to run it here.
                </p>
              </div>
              <div className="max-w-md text-[10px] text-slate-600">
                {selected.prototype.files.join(" · ") || "No files"}
              </div>
            </div>
          ) : previewUrl ? (
            <iframe
              key={previewUrl}
              title={selected?.prototype.title ?? "Prototype preview"}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              src={previewUrl}
              className="h-full w-full border-0 bg-white"
              onLoad={() => setPreviewLoading(false)}
            />
          ) : selected && previewLoading ? (
            <div className="flex h-full items-center justify-center text-xs text-slate-500">
              Loading prototype...
            </div>
          ) : (
            <div className="flex h-full items-center justify-center px-6 text-center text-xs text-slate-500">
              Select a prototype
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
