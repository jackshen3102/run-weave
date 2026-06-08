import { IonButton } from "@ionic/react";

import type { TerminalHomeProjectGroup } from "../lib/terminal-home-view-model";
import { TerminalRow } from "./TerminalRow";

interface ProjectGroupProps {
  group: TerminalHomeProjectGroup;
  expanded: boolean;
  onToggle: () => void;
  onOpenTerminal: (terminalSessionId: string) => void;
}

export function ProjectGroup({
  group,
  expanded,
  onToggle,
  onOpenTerminal,
}: ProjectGroupProps) {
  return (
    <section className="project-group">
      <IonButton
        aria-expanded={expanded}
        className="project-group__header"
        fill="clear"
        onClick={onToggle}
      >
        <span className="project-group__chevron">{expanded ? "⌄" : "›"}</span>
        <span className="project-group__identity">
          <span className="project-group__name">{group.project.name}</span>
          <span className="project-group__path">
            {group.project.path ?? "No path"}
          </span>
        </span>
        <span className="project-group__count">{group.terminalCount}</span>
      </IonButton>
      {expanded ? (
        <div className="project-group__sessions">
          {group.sessions.length > 0 ? (
            group.sessions.map((session) => (
              <TerminalRow
                key={session.terminalSessionId}
                session={session}
                onOpenTerminal={onOpenTerminal}
              />
            ))
          ) : (
            <p className="project-group__empty">暂无终端</p>
          )}
        </div>
      ) : null}
    </section>
  );
}
