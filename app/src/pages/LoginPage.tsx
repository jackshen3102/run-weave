import {
  IonButton,
  IonContent,
  IonInput,
  IonPage,
  IonSpinner,
  IonText,
} from "@ionic/react";
import { FormEvent, useState } from "react";

import { ApiError } from "../services/http";

interface LoginPageProps {
  onLogin: (params: { username: string; password: string }) => Promise<void>;
}

function resolveLoginError(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) {
    return "用户名或密码不正确";
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "无法连接服务";
}

export function LoginPage({ onLogin }: LoginPageProps) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await onLogin({
        username: username.trim(),
        password,
      });
    } catch (loginError) {
      setError(resolveLoginError(loginError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <IonPage>
      <IonContent fullscreen className="login-page">
        <main className="login-shell">
          <section className="login-brand">
            <p>Runweave</p>
            <h1>Sign in</h1>
          </section>
          <form className="login-form" onSubmit={handleSubmit}>
            <IonInput
              className="app-input"
              autocomplete="username"
              disabled={submitting}
              label="Username"
              labelPlacement="stacked"
              onIonInput={(event) =>
                setUsername(String(event.detail.value ?? ""))
              }
              value={username}
            />
            <IonInput
              className="app-input"
              autocomplete="current-password"
              disabled={submitting}
              label="Password"
              labelPlacement="stacked"
              onIonInput={(event) =>
                setPassword(String(event.detail.value ?? ""))
              }
              type="password"
              value={password}
            />
            {error ? (
              <IonText color="danger">
                <p className="login-error">{error}</p>
              </IonText>
            ) : null}
            <IonButton
              className="login-submit"
              disabled={submitting || !username.trim() || !password}
              expand="block"
              type="submit"
            >
              {submitting ? <IonSpinner name="crescent" /> : "Login"}
            </IonButton>
          </form>
        </main>
      </IonContent>
    </IonPage>
  );
}
