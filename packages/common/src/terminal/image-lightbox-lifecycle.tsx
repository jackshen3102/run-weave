import { createContext, useContext, useLayoutEffect, useRef } from "react";

/** The Web host may coordinate its own layers; common never knows about Electron. */
const ImageLightboxLifecycle = createContext<((element: HTMLElement) => () => void) | null>(null);
export const ImageLightboxLifecycleProvider = ImageLightboxLifecycle.Provider;

export function ImageLightboxPresence() {
  const marker = useRef<HTMLSpanElement>(null);
  const register = useContext(ImageLightboxLifecycle);
  useLayoutEffect(() => {
    const portal = marker.current?.closest<HTMLElement>(".rw-image-lightbox");
    if (portal && register) return register(portal);
  }, [register]);
  return <span ref={marker} hidden />;
}
