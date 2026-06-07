import { create } from 'zustand';

type HelloState = {
  greeting: string;
  count: number;
  increment: () => void;
};

export const useHelloStore = create<HelloState>((set) => ({
  greeting: 'Hello World',
  count: 0,
  increment: () => set((state) => ({ count: state.count + 1 })),
}));
