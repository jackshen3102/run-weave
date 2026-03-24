import { Navigate, Route, Routes } from "react-router-dom";
import { useAuthToken } from "./features/auth/use-auth-token";
import { HomePage } from "./pages/home-page";
import { LoginPage } from "./pages/login-page";
import { ViewerPage } from "./pages/viewer-page";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";
const AUTH_TOKEN_STORAGE_KEY = "viewer.auth.token";

export default function App() {
  const { token, setToken, clearToken } = useAuthToken(AUTH_TOKEN_STORAGE_KEY);

  return (
    <Routes>
      <Route
        path="/login"
        element={
          token ? (
            <Navigate to="/" replace />
          ) : (
            <LoginPage apiBase={API_BASE} onSuccess={setToken} />
          )
        }
      />
      <Route
        path="/"
        element={
          token ? (
            <HomePage apiBase={API_BASE} token={token} clearToken={clearToken} />
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route
        path="/viewer/:sessionId"
        element={
          token ? (
            <ViewerPage
              apiBase={API_BASE}
              token={token}
              onAuthExpired={clearToken}
            />
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route
        path="*"
        element={<Navigate to={token ? "/" : "/login"} replace />}
      />
    </Routes>
  );
}
