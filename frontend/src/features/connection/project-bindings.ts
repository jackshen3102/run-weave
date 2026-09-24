import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ProjectBinding } from "@runweave/shared/remote";
import type { TerminalProjectListItem } from "@runweave/shared/terminal/project";

interface ProjectBindingsState {
  bindings: ProjectBinding[];
  add: (connectionId: string, project: TerminalProjectListItem) => void;
  remove: (connectionId: string, projectId: string) => void;
  removeConnection: (connectionId: string) => void;
}

export function isProjectBound(bindings: ProjectBinding[], connectionId: string, projectId: string): boolean {
  return bindings.some((binding) => binding.connectionId === connectionId && binding.remoteProjectId === projectId);
}

export const useProjectBindings = create<ProjectBindingsState>()(persist((set) => ({
  bindings: [],
  add: (connectionId, project) => set((state) => ({
    bindings: [
      ...state.bindings.filter((binding) => binding.connectionId !== connectionId || binding.remoteProjectId !== project.projectId),
      { connectionId, remoteProjectId: project.projectId, remoteDirectory: project.path ?? "" },
    ],
  })),
  remove: (connectionId, projectId) => set((state) => ({
    bindings: state.bindings.filter((binding) => binding.connectionId !== connectionId || binding.remoteProjectId !== projectId),
  })),
  removeConnection: (connectionId) => set((state) => ({
    bindings: state.bindings.filter((binding) => binding.connectionId !== connectionId),
  })),
}), { name: "viewer.remote-project-bindings.v1", version: 1, partialize: (state) => ({ bindings: state.bindings }) }));
