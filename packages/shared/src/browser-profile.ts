import type { BrowserProfile } from "./protocol";

export const MAX_BROWSER_PROFILE_VIEWPORT_DIMENSION = 10_000;
export const MAX_BROWSER_PROFILE_USER_AGENT_LENGTH = 2_048;

export type BrowserProfileFieldPath =
  | "locale"
  | "timezoneId"
  | "userAgent"
  | "viewport.width"
  | "viewport.height";

export interface BrowserProfileValidationResult {
  normalizedProfile: BrowserProfile | undefined;
  fieldErrors: Partial<Record<BrowserProfileFieldPath, string>>;
}

function normalizeLocale(locale: string): string | null {
  try {
    const [canonicalLocale] = Intl.getCanonicalLocales(locale);
    return canonicalLocale ?? null;
  } catch {
    return null;
  }
}

function normalizeTimezoneId(timezoneId: string): string | null {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezoneId,
    }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

function validateViewportDimension(
  field: "viewport.width" | "viewport.height",
  value: number,
): string | null {
  if (!Number.isInteger(value) || value <= 0) {
    return `${field === "viewport.width" ? "Viewport width" : "Viewport height"} must be a positive integer.`;
  }

  if (value > MAX_BROWSER_PROFILE_VIEWPORT_DIMENSION) {
    return `${field === "viewport.width" ? "Viewport width" : "Viewport height"} must be at most ${MAX_BROWSER_PROFILE_VIEWPORT_DIMENSION}.`;
  }

  return null;
}

export function validateBrowserProfile(
  profile: BrowserProfile | undefined,
): BrowserProfileValidationResult {
  if (!profile) {
    return {
      normalizedProfile: undefined,
      fieldErrors: {},
    };
  }

  const fieldErrors: Partial<Record<BrowserProfileFieldPath, string>> = {};
  const normalizedProfile: BrowserProfile = {};

  if (profile.locale !== undefined) {
    const canonicalLocale = normalizeLocale(profile.locale.trim());
    if (!canonicalLocale) {
      fieldErrors.locale = "Locale must be a valid BCP 47 language tag.";
    } else {
      normalizedProfile.locale = canonicalLocale;
    }
  }

  if (profile.timezoneId !== undefined) {
    const canonicalTimezoneId = normalizeTimezoneId(profile.timezoneId.trim());
    if (!canonicalTimezoneId) {
      fieldErrors.timezoneId = "Timezone must be a supported IANA time zone.";
    } else {
      normalizedProfile.timezoneId = canonicalTimezoneId;
    }
  }

  if (profile.userAgent !== undefined) {
    const userAgent = profile.userAgent.trim();
    if (!userAgent) {
      fieldErrors.userAgent = "User agent must not be empty.";
    } else if (userAgent.length > MAX_BROWSER_PROFILE_USER_AGENT_LENGTH) {
      fieldErrors.userAgent =
        `User agent must be at most ${MAX_BROWSER_PROFILE_USER_AGENT_LENGTH} characters.`;
    } else {
      normalizedProfile.userAgent = userAgent;
    }
  }

  if (profile.viewport !== undefined) {
    const widthError = validateViewportDimension(
      "viewport.width",
      profile.viewport.width,
    );
    const heightError = validateViewportDimension(
      "viewport.height",
      profile.viewport.height,
    );

    if (widthError) {
      fieldErrors["viewport.width"] = widthError;
    }
    if (heightError) {
      fieldErrors["viewport.height"] = heightError;
    }

    if (!widthError && !heightError) {
      normalizedProfile.viewport = {
        width: profile.viewport.width,
        height: profile.viewport.height,
      };
    }
  }

  return {
    normalizedProfile:
      Object.keys(normalizedProfile).length > 0 ? normalizedProfile : undefined,
    fieldErrors,
  };
}
