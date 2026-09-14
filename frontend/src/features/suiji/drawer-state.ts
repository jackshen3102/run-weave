import { create } from "zustand";
export const useSuijiDrawer = create<{
  open: boolean;
  opened: boolean;
  setOpen: (open: boolean) => void;
}>((set) => ({
  open: false,
  opened: false,
  setOpen: (open) => set((state) => ({ open, opened: state.opened || open })),
}));
