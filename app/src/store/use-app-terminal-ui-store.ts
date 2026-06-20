import { create } from "zustand";

import type { AppTerminalDetailTab } from "../components/TerminalDetailTabBar";
import type { SelectedTerminalChange } from "../components/TerminalChangesTab";

interface AppTerminalUiState {
  activeTab: AppTerminalDetailTab;
  changesCount: number;
  confirmDeleteOpen: boolean;
  deleteError: string | null;
  isDeletingTerminal: boolean;
  requestedChange: SelectedTerminalChange | null;
  setActiveTab: (tab: AppTerminalDetailTab) => void;
  setChangesCount: (count: number) => void;
  setConfirmDeleteOpen: (open: boolean) => void;
  setDeleteError: (error: string | null) => void;
  setIsDeletingTerminal: (isDeleting: boolean) => void;
  showChanges: (change: SelectedTerminalChange) => void;
  resetForTerminal: () => void;
}

const initialState = {
  activeTab: "chat" as AppTerminalDetailTab,
  changesCount: 0,
  confirmDeleteOpen: false,
  deleteError: null,
  isDeletingTerminal: false,
  requestedChange: null,
};

export const useAppTerminalUiStore = create<AppTerminalUiState>((set) => ({
  ...initialState,
  setActiveTab: (activeTab) => set({ activeTab }),
  setChangesCount: (changesCount) => set({ changesCount }),
  setConfirmDeleteOpen: (confirmDeleteOpen) => set({ confirmDeleteOpen }),
  setDeleteError: (deleteError) => set({ deleteError }),
  setIsDeletingTerminal: (isDeletingTerminal) => set({ isDeletingTerminal }),
  showChanges: (requestedChange) =>
    set({ activeTab: "changes", requestedChange }),
  resetForTerminal: () => set(initialState),
}));
