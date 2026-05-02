import type { ProjectMobileSummary } from "./terminal-card-view-model";

interface ProjectSwitcherProps {
  projects: ProjectMobileSummary[];
  selectedProjectId: string | null;
  onSelectProject: (projectId: string) => void;
}

export function ProjectSwitcher({
  projects,
  selectedProjectId,
  onSelectProject,
}: ProjectSwitcherProps) {
  return (
    <div className="flex flex-wrap gap-2 px-4 py-2">
      {projects.map((project) => {
        const isActive = project.projectId === selectedProjectId;
        return (
          <button
            key={project.projectId}
            type="button"
            aria-pressed={isActive}
            className={[
              "min-h-10 shrink-0 rounded-full border px-3 text-left text-xs shadow-sm transition-colors",
              isActive
                ? "border-primary/70 bg-primary text-primary-foreground"
                : "border-border/60 bg-card/72 text-foreground hover:border-border",
            ].join(" ")}
            onClick={() => {
              onSelectProject(project.projectId);
            }}
          >
            <span className="block max-w-32 truncate font-semibold">
              {project.name}
            </span>
            <span
              className={[
                "block text-[11px]",
                isActive ? "text-primary-foreground/75" : "text-muted-foreground",
              ].join(" ")}
            >
              {project.totalTerminals} 终端 · {project.needsAttention} 待处理
            </span>
          </button>
        );
      })}
    </div>
  );
}
