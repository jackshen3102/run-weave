import type {
  RunweaveCompanionBridge,
  RunweaveElectronHostBridge,
} from "@runweave/shared/desktop-bridge";

declare global {
  interface Window {
    companionAPI?: RunweaveCompanionBridge;
    electronAPI?: RunweaveElectronHostBridge;
  }
}

export {};
