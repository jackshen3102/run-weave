import { create } from "zustand";
import type { TunnelSnapshot } from "@runweave/shared/tunnels";

export const useTunnelStore = create<{
  snapshot: TunnelSnapshot | null;
  open: boolean;
  error: string | null;
  notice: string | null;
  setOpen: (open: boolean) => void;
  setSnapshot: (snapshot: TunnelSnapshot) => void;
  setError: (error: string | null) => void;
  setNotice: (notice: string | null) => void;
}>((set) => ({
  snapshot: null,
  open: false,
  error: null,
  notice: null,
  setOpen: (open) => set({ open }),
  setSnapshot: (snapshot) => set({ snapshot }),
  setError: (error) => set({ error }),
  setNotice: (notice) => set({ notice }),
}));
