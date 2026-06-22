import { useState } from "react";
import Lightbox from "yet-another-react-lightbox";
import Zoom from "yet-another-react-lightbox/plugins/zoom";

export interface RunweaveImageLightboxProps {
  src: string;
  alt: string;
  title?: string;
  open: boolean;
  onClose: () => void;
}

export interface RunweaveImagePreviewProps {
  src: string;
  alt: string;
  title?: string;
  className?: string;
}

const LIGHTBOX_PLUGINS = [Zoom];

export function RunweaveImageLightbox({
  src,
  alt,
  title,
  open,
  onClose,
}: RunweaveImageLightboxProps) {
  return (
    <Lightbox
      carousel={{ finite: true, imageFit: "contain", padding: 0 }}
      className="rw-image-lightbox"
      close={onClose}
      labels={{
        Close: "Close",
        Lightbox: title ?? alt,
        "Photo gallery": title ?? alt,
        "Zoom in": "Zoom in",
        "Zoom out": "Zoom out",
      }}
      open={open}
      plugins={LIGHTBOX_PLUGINS}
      render={{
        controls: () =>
          title ? (
            <div className="rw-image-lightbox__title" title={title}>
              {title}
            </div>
          ) : null,
      }}
      slides={[{ src, alt }]}
      toolbar={{ buttons: ["zoom", "close"] }}
      zoom={{
        doubleClickMaxStops: 2,
        maxZoomPixelRatio: 4,
        pinchZoomV4: true,
        scrollToZoom: true,
        wheelZoomDistanceFactor: 120,
        zoomInMultiplier: 1.6,
      }}
    />
  );
}

export function RunweaveImagePreview({
  src,
  alt,
  title,
  className,
}: RunweaveImagePreviewProps) {
  const [open, setOpen] = useState(false);
  const label = title ?? alt;

  return (
    <div
      className={["rw-image-preview", className ?? ""]
        .filter(Boolean)
        .join(" ")}
    >
      <button
        aria-label={`Open image fullscreen: ${label}`}
        className="rw-image-preview__button"
        onClick={() => setOpen(true)}
        title="Open image fullscreen"
        type="button"
      >
        <img
          alt={alt}
          className="rw-image-preview__image"
          draggable={false}
          src={src}
        />
        <span className="rw-image-preview__open">Open fullscreen</span>
      </button>
      <RunweaveImageLightbox
        alt={alt}
        onClose={() => setOpen(false)}
        open={open}
        src={src}
        title={title}
      />
    </div>
  );
}
