import { RunweaveImagePreview } from "@runweave/common/terminal";
import "@runweave/common/terminal/image-lightbox.css";

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
  return <RunweaveImagePreview alt={alt} src={src} title={title} />;
}
