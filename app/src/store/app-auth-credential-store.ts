import { Capacitor } from "@capacitor/core";

import {
  type AppAuthCredentialStore,
  webAppAuthCredentialStore,
} from "./app-auth-credential-store.web";
import { nativeAppAuthCredentialStore } from "./app-auth-credential-store.native";

export type { AppAuthCredentialStore } from "./app-auth-credential-store.web";

export function getAppAuthCredentialStore(): AppAuthCredentialStore {
  return Capacitor.isNativePlatform()
    ? nativeAppAuthCredentialStore
    : webAppAuthCredentialStore;
}
