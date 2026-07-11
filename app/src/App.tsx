import { IonApp } from "@ionic/react";
import { IonReactRouter } from "@ionic/react-router";
import { useEffect } from "react";

import {
  SupportLogProvider,
  SupportLogSheet,
  useSupportLogs,
} from "./features/support-logs";
import { useAppSession } from "./hooks/use-app-session";
import { AppRoutes } from "./routes/AppRoutes";
import { AppQueryProvider } from "./features/query/app-query-provider";

function AppContent() {
  const session = useAppSession();
  const { setUploadTarget } = useSupportLogs();

  useEffect(() => {
    // apiBase may legitimately be an empty string (same-origin / relative
    // requests are handled by services/http.ts), so gate only on auth + token
    // to match how the rest of the app decides the session is usable.
    if (session.isAuthenticated && session.accessToken) {
      setUploadTarget({
        apiBase: session.apiBase,
        accessToken: session.accessToken,
      });
    } else {
      setUploadTarget(null);
    }
  }, [
    session.accessToken,
    session.apiBase,
    session.isAuthenticated,
    setUploadTarget,
  ]);

  if (session.startupState === "checking") {
    return (
      <IonApp className="app-loading">
        <SupportLogSheet />
      </IonApp>
    );
  }

  return (
    <IonApp>
      <IonReactRouter>
        <AppRoutes session={session} />
      </IonReactRouter>
      <SupportLogSheet />
    </IonApp>
  );
}

function App() {
  return (
    <SupportLogProvider>
      <AppQueryProvider>
        <AppContent />
      </AppQueryProvider>
    </SupportLogProvider>
  );
}

export default App;
