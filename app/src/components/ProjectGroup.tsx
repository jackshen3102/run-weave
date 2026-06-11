import { IonButton, IonIcon } from "@ionic/react";
import { addOutline } from "ionicons/icons";

import type { TerminalHomeProjectGroup } from "../lib/terminal-home-view-model";
import { TerminalRow } from "./TerminalRow";

interface ProjectGroupProps {
  group: TerminalHomeProjectGroup;
  expanded: boolean;
  onToggle: () => void;
  onOpenTerminal: (terminalSessionId: string) => void;
  onCreateTerminal: (projectId: string) => void;
  creatingTerminal: boolean;
}

export function ProjectGroup({
  group,
  expanded,
  onToggle,
  onOpenTerminal,
  onCreateTerminal,
  creatingTerminal,
}: ProjectGroupProps) {
  return (
    <section className="project-group border-border">
      <div className="project-group__header">
        <IonButton
          aria-expanded={expanded}
          className="project-group__toggle"
          fill="clear"
          onClick={onToggle}
        >
          <span className="project-group__chevron">
            {expanded ? "⌄" : "›"}
          </span>
          <span className="project-group__identity min-w-0">
            <span className="project-group__name text-foreground">
              {group.project.name}
            </span>
            <span className="project-group__path text-muted-foreground">
              {group.project.path ?? "No path"}
            </span>
          </span>
          <span className="project-group__count text-muted-foreground">
            {group.terminalCount}
          </span>
        </IonButton>
        <IonButton
          aria-label={`Create terminal in ${group.project.name}`}
          className="project-group__create"
          disabled={creatingTerminal}
          fill="clear"
          onClick={() => onCreateTerminal(group.project.projectId)}
        >
          <IonIcon aria-hidden="true" icon={addOutline} />
        </IonButton>
      </div>
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
            <p className="project-group__empty text-muted-foreground">暂无终端</p>
          )}
        </div>
      ) : null}
    </section>
  );
}
