export type ClientMode = "desktop" | "mobile";

interface ResolveClientModeParams {
  viewportWidth: number;
  coarsePointer: boolean;
  isElectron?: boolean;
  override?: string | null;
}

const PHONE_MAX_WIDTH = 767;
const COARSE_POINTER_MAX_WIDTH = 1024;

export function resolveClientMode({
  viewportWidth,
  coarsePointer,
  isElectron = false,
  override = null,
}: ResolveClientModeParams): ClientMode {
  if (override === "desktop" || override === "mobile") {
    return override;
  }

  if (isElectron) {
    return "desktop";
  }

  if (viewportWidth <= PHONE_MAX_WIDTH) {
    return "mobile";
  }

  if (coarsePointer && viewportWidth <= COARSE_POINTER_MAX_WIDTH) {
    return "mobile";
  }

  return "desktop";
}

export function readClientModeOverride(search: string): ClientMode | null {
  const value = new URLSearchParams(search).get("clientMode");
  return value === "desktop" || value === "mobile" ? value : null;
}
