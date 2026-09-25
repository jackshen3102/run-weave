import type { ReactNode } from "react";
import { ImageLightboxLifecycleProvider } from "@runweave/common/terminal";
import { registerOverlay } from "./registry";

const registerImage = (element: HTMLElement) => registerOverlay(element, "window");
export function OverlayProvider({ children }: { children: ReactNode }) {
  return <ImageLightboxLifecycleProvider value={registerImage}>{children}</ImageLightboxLifecycleProvider>;
}
