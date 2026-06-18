import { registerPlugin } from "@capacitor/core";

interface NativeSecureCredentialsPlugin {
  get(options: { key: string }): Promise<{ value?: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
}

export const NativeSecureCredentials =
  registerPlugin<NativeSecureCredentialsPlugin>("RunweaveSecureCredentials");
