import { create } from "zustand";
export const useSuijiDrawer = create<{
  open: boolean;
  opened: boolean;
  revision: number;
  setOpen: (open: boolean) => void;
}>((set) => ({
  open: false,
  opened: false,
  revision: 0,
  setOpen: (open) =>
    set((state) => ({
      open,
      opened: state.opened || open,
      revision: state.revision + (state.open === open ? 0 : 1),
    })),
}));
