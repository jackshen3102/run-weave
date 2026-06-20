import { ZoomableImage } from "@runweave/common/terminal";
import "@runweave/common/terminal/zoomable-image.css";
import { IonModal } from "@ionic/react";
import { useEffect, useState } from "react";

interface TerminalZoomableImageProps {
  src: string;
  alt: string;
  title: string;
}

export function TerminalZoomableImage({
  src,
  alt,
  title,
}: TerminalZoomableImageProps) {
  const [fullscreenOpen, setFullscreenOpen] = useState(false);

  useEffect(() => {
    setFullscreenOpen(false);
  }, [src]);

  return (
    <>
      <ZoomableImage
        alt={alt}
        src={src}
        title={title}
        toolbarPlacement="bottom"
        onRequestFullscreen={() => setFullscreenOpen(true)}
      />
      <IonModal
        className="terminal-image-fullscreen-modal"
        isOpen={fullscreenOpen}
        onDidDismiss={() => setFullscreenOpen(false)}
      >
        <ZoomableImage
          alt={alt}
          fullscreen
          src={src}
          title={title}
          toolbarPlacement="bottom"
          onCloseFullscreen={() => setFullscreenOpen(false)}
        />
      </IonModal>
    </>
  );
}
