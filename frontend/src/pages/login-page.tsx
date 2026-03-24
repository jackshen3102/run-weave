import { useNavigate } from "react-router-dom";
import { LoginPage as LoginScreen } from "../components/login-page";

interface LoginPageProps {
  apiBase: string;
  onSuccess: (token: string) => void;
}

export function LoginPage({ apiBase, onSuccess }: LoginPageProps) {
  const navigate = useNavigate();

  return (
    <LoginScreen
      apiBase={apiBase}
      onSuccess={(token) => {
        onSuccess(token);
        navigate("/", { replace: true });
      }}
    />
  );
}
