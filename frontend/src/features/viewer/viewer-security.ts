export type ViewerSecurityTone = "secure" | "insecure" | "neutral";

export interface ViewerSecurityState {
  label: string;
  hostname: string;
  tone: ViewerSecurityTone;
}

export function getViewerSecurityState(rawUrl: string): ViewerSecurityState {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return {
      label: "No page",
      hostname: "",
      tone: "neutral",
    };
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "https:") {
      return {
        label: "Secure",
        hostname: parsed.hostname,
        tone: "secure",
      };
    }

    if (parsed.protocol === "http:") {
      return {
        label: "Not secure",
        hostname: parsed.hostname,
        tone: "insecure",
      };
    }

    return {
      label: "Browser page",
      hostname: trimmed,
      tone: "neutral",
    };
  } catch {
    return {
      label: "Browser page",
      hostname: trimmed,
      tone: "neutral",
    };
  }
}
