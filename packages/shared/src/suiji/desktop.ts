import type { SuijiTokens } from "./index";

export type SuijiEnvironment = "production" | "development";
export type SuijiSavedSession = { tokens: SuijiTokens; expiresAt: number };
export type SuijiProfile = {
  endpoint: string;
  username: string;
  password?: string;
  session?: SuijiSavedSession;
};
export type SuijiDesktopState = {
  active: SuijiEnvironment;
  profiles: Record<SuijiEnvironment, SuijiProfile>;
};
