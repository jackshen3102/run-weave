import { IonApp } from "@ionic/react";
import { IonReactRouter } from "@ionic/react-router";

import { SupportLogProvider, SupportLogSheet } from "./features/support-logs";
import { useAppSession } from "./hooks/use-app-session";
import { AppRoutes } from "./routes/AppRoutes";

function AppContent() {
  const session = useAppSession();

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
      <AppContent />
    </SupportLogProvider>
  );
}

export default App;
